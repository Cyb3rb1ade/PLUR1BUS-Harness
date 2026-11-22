//! `budget/service.ts` (L8, ADR-010 section 4): usage accounting, soft and hard limits, and the check that runs before every
//! model call. Provider adapters call [`BudgetService::record_usage`] after a call and `check` or `enforce` before it. The
//! service never sees prompt content. Budgets count tokens and media units (images, video seconds); there is no money
//! dimension. The call port ([`super::calls`]) enforces all three metrics; `check` and `enforce` here are tokens only.
//!
//! Events (`budget.soft`, `budget.hard`) leave after the transaction has committed and the store lock is released, so a sink
//! may call back into the service, and a rolled-back notice is never announced. A sink that panics does not break accounting.
use super::cache_report::{summarize_cache_usage, CacheUsageRow};
use super::period::{period_bounds, validate_time_zone, CallPeriod, Period, PeriodBounds, Zones};
use super::store::{self, OpenOptions};
use super::weight::{
    counted_tokens, stored_cache_read_weight, write_cache_read_weight, CACHE_READS_SQL,
};
use super::{count, ident, input, BudgetError, Clock, MAX_TS};
use plur1bus_store::rusqlite::{params, Connection, OptionalExtension};
use plur1bus_store::Store;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

/// `LimitScope`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitScope {
    /// Every agent together.
    Global,
    /// One agent.
    Agent,
}

impl LimitScope {
    /// The name the store uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Agent => "agent",
        }
    }
}

/// `Metric`: `tokens` is input plus output (output includes the reasoning tokens a provider reports), `images` generated
/// images, `videoSeconds` seconds of generated video (a fraction is rounded up).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Metric {
    /// Input plus output tokens.
    Tokens,
    /// Generated images.
    Images,
    /// Seconds of generated video.
    VideoSeconds,
}

/// `METRICS`.
pub const METRICS: [Metric; 3] = [Metric::Tokens, Metric::Images, Metric::VideoSeconds];
/// `PERIODS`.
pub const PERIODS: [Period; 2] = [Period::Day, Period::Month];

impl Metric {
    /// The name the store and the RPC use.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tokens => "tokens",
            Self::Images => "images",
            Self::VideoSeconds => "videoSeconds",
        }
    }

    /// A metric by name; `cost` and anything else unknown is `None`.
    pub fn parse(s: &str) -> Option<Self> {
        METRICS.into_iter().find(|m| m.as_str() == s)
    }

    fn unit(self) -> &'static str {
        match self {
            Self::Tokens => "tokens",
            Self::Images => "images",
            Self::VideoSeconds => "video seconds",
        }
    }
}

/// `UsageEvent`: what a provider adapter reports after a call. Closed by its type: there is no field for a prompt.
#[derive(Clone, Debug, Default)]
pub struct UsageEvent<'a> {
    /// The agent.
    pub agent: &'a str,
    /// The model.
    pub model: &'a str,
    /// The provider; empty when `None`.
    pub provider: Option<&'a str>,
    /// The whole prompt, cache reads and writes included.
    pub input_tokens: i64,
    /// Output tokens, reasoning included.
    pub output_tokens: i64,
    /// The part of the input read from the provider's cache.
    pub cache_read_tokens: Option<i64>,
    /// The part of the input written to the provider's cache.
    pub cache_write_tokens: Option<i64>,
    /// Milliseconds since the epoch; the service clock when `None`.
    pub ts: Option<i64>,
    /// An id the adapter keeps stable across retries; a repeat is ignored.
    pub request_id: Option<&'a str>,
}

/// `RecordResult`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordResult {
    /// Whether this call wrote a row (a repeated request id writes none).
    pub recorded: bool,
}

/// `UsageEstimate`.
#[derive(Clone, Copy, Debug, Default)]
pub struct UsageEstimate<'a> {
    /// The provider.
    pub provider: Option<&'a str>,
    /// Estimated input tokens.
    pub input_tokens: i64,
    /// Estimated output tokens; 0 when `None`.
    pub output_tokens: Option<i64>,
}

/// `Limit`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limit {
    /// Global or one agent.
    pub scope: LimitScope,
    /// The agent of an agent limit.
    pub agent_id: Option<String>,
    /// Day or month.
    pub period: Period,
    /// What is counted.
    pub metric: Metric,
    /// Warn above this.
    pub soft: Option<i64>,
    /// Refuse above this.
    pub hard: Option<i64>,
}

/// `LimitKey`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LimitKey {
    /// Global or one agent.
    pub scope: LimitScope,
    /// The agent of an agent limit.
    pub agent_id: Option<String>,
    /// Day or month.
    pub period: Period,
    /// What is counted.
    pub metric: Metric,
}

/// What an update does to one bound: `undefined` keeps it, `null` clears it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Bound {
    /// Leave the bound as it is.
    #[default]
    Keep,
    /// Remove the bound.
    Clear,
    /// Set the bound.
    Set(i64),
}

/// `BudgetLimitUpdate`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetLimitUpdate {
    /// Which limit.
    pub key: LimitKey,
    /// The soft bound.
    pub soft: Bound,
    /// The hard bound.
    pub hard: Bound,
}

/// `Breach`: a call that would pass a hard limit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Breach {
    /// Global or one agent.
    pub scope: LimitScope,
    /// The agent of an agent limit.
    pub agent_id: Option<String>,
    /// Day or month.
    pub period: Period,
    /// What is counted.
    pub metric: Metric,
    /// The hard limit.
    pub limit: i64,
    /// What the period has used.
    pub used: i64,
    /// What this call adds.
    pub estimate: i64,
    /// The period's key.
    pub period_key: String,
    /// When the period ends.
    pub resets_at: i64,
}

/// `Warning`: a call that passes a soft limit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Warning {
    /// Global or one agent.
    pub scope: LimitScope,
    /// The agent of an agent limit.
    pub agent_id: Option<String>,
    /// Day or month.
    pub period: Period,
    /// What is counted.
    pub metric: Metric,
    /// The soft limit.
    pub limit: i64,
    /// What the period has used.
    pub used: i64,
    /// What this call adds.
    pub estimate: i64,
    /// The period's key.
    pub period_key: String,
    /// True when this call is the first to cross the soft limit in this period (the event was emitted).
    pub notified: bool,
}

/// `CheckDecision`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckDecision {
    /// No hard limit is passed.
    pub allowed: bool,
    /// The hard limits passed.
    pub breaches: Vec<Breach>,
    /// The soft limits passed.
    pub warnings: Vec<Warning>,
}

/// `BudgetEvent.kind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    /// `budget.soft`.
    Soft,
    /// `budget.hard`.
    Hard,
}

/// `BudgetEvent`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetEvent {
    /// Soft or hard.
    pub kind: EventKind,
    /// Global or one agent.
    pub scope: LimitScope,
    /// The agent of an agent limit.
    pub agent_id: Option<String>,
    /// Day or month.
    pub period: Period,
    /// What is counted.
    pub metric: Metric,
    /// The limit crossed.
    pub limit: i64,
    /// What the period has used.
    pub used: i64,
    /// The period's key.
    pub period_key: String,
}

/// `BudgetExceededError`: a hard limit refused the call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetExceeded {
    /// The refusing decision.
    pub decision: CheckDecision,
    /// The message: names the limit, the use, the call's estimate and when the period resets.
    pub message: String,
}

/// `describeBreach`.
pub fn describe_breach(b: &Breach) -> String {
    let fmt = |n: i64| format!("{n} {}", b.metric.unit());
    let who = match (&b.scope, &b.agent_id) {
        (LimitScope::Global, _) => "global".to_owned(),
        (LimitScope::Agent, id) => format!("agent {}", id.as_deref().unwrap_or("")),
    };
    let when = format!(
        "{} {}",
        if b.period == Period::Day {
            "daily"
        } else {
            "monthly"
        },
        b.metric.as_str()
    );
    format!(
        "{who} {when} hard limit {} would be exceeded (used {}, this call ~{}; resets {})",
        fmt(b.limit),
        fmt(b.used),
        fmt(b.estimate),
        super::period::iso_utc(b.resets_at)
    )
}

/// `UsageTotals`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct UsageTotals {
    /// Ledger rows.
    pub events: i64,
    /// Raw input tokens, cache reads and writes included.
    pub input_tokens: i64,
    /// Output tokens.
    pub output_tokens: i64,
    /// Raw cache reads.
    pub cache_read_tokens: i64,
    /// Raw cache writes.
    pub cache_write_tokens: i64,
    /// Input outside the cache, clamped to zero per event if a provider reports inconsistent cache counts.
    pub fresh_input_tokens: i64,
    /// Input plus output after weighing cache reads; rounded once for this aggregate.
    pub counted_tokens: i64,
    /// Generated images.
    pub images: i64,
    /// Generated video seconds.
    pub video_seconds: i64,
}

/// `StatusLimit.state`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitState {
    /// Below both bounds.
    Ok,
    /// At or above the soft bound.
    Soft,
    /// At or above the hard bound.
    Hard,
}

/// `StatusLimit`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusLimit {
    /// The limit.
    pub limit: Limit,
    /// What its period has used.
    pub used: i64,
    /// Where that stands.
    pub state: LimitState,
}

/// One model of an agent in a [`StatusPeriod`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusModel {
    /// The model.
    pub model: String,
    /// Its totals.
    pub total: UsageTotals,
}

/// One agent of a [`StatusPeriod`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusAgent {
    /// The agent.
    pub agent_id: String,
    /// Its totals.
    pub total: UsageTotals,
    /// Its models, by name.
    pub models: Vec<StatusModel>,
}

/// `StatusPeriod`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusPeriod {
    /// Day or month.
    pub period: Period,
    /// The period's key.
    pub key: String,
    /// First instant.
    pub start: i64,
    /// First instant of the next period.
    pub end: i64,
    /// Totals of the period.
    pub total: UsageTotals,
    /// By agent, by name.
    pub agents: Vec<StatusAgent>,
}

/// `BudgetStatus`.
#[derive(Clone, Debug, PartialEq)]
pub struct BudgetStatus {
    /// The configured zone.
    pub time_zone: String,
    /// The cache-read weight.
    pub cache_read_weight: f64,
    /// The service clock.
    pub now: i64,
    /// Day, then month.
    pub periods: Vec<StatusPeriod>,
    /// Every limit the core knows.
    pub limits: Vec<StatusLimit>,
}

/// `BudgetSettings`.
#[derive(Clone, Debug, Default)]
pub struct BudgetSettings {
    /// A new zone.
    pub time_zone: Option<String>,
    /// A new cache-read weight.
    pub cache_read_weight: Option<f64>,
    /// A limit change.
    pub limit: Option<BudgetLimitUpdate>,
}

/// `BudgetSettingsResult`. `limit` is absent when no limit was in the update, `Some(None)` when it removed one.
#[derive(Clone, Debug, PartialEq)]
pub struct BudgetSettingsResult {
    /// The zone now.
    pub time_zone: String,
    /// The weight now.
    pub cache_read_weight: f64,
    /// The changed limit.
    pub limit: Option<Option<Limit>>,
    /// Every limit now.
    pub limits: Vec<Limit>,
}

/// Where `budget.soft` and `budget.hard` go.
pub type EventSink = Arc<dyn Fn(&BudgetEvent) + Send + Sync>;

/// `BudgetServiceOptions`.
pub struct BudgetServiceOptions<'a> {
    /// `state/budget.sqlite`.
    pub path: &'a Path,
    /// The clock.
    pub clock: Arc<dyn Clock>,
    /// The time-zone database.
    pub zones: Arc<dyn Zones>,
    /// The event sink.
    pub events: Option<EventSink>,
    /// `securePath`.
    pub secure_path: Option<&'a dyn Fn(&Path)>,
    /// `defaultTimeZone`; `UTC` when `None`.
    pub default_time_zone: Option<&'a str>,
    /// `busyTimeoutMs`.
    pub busy_timeout_ms: Option<u64>,
}

/// `Row` of the sums: the counts of a set of ledger rows. `ri` is the cache reads a token limit may weigh, each event's at
/// most its own input.
#[derive(Clone, Copy, Default)]
pub(crate) struct Sums {
    n: i64,
    i: i64,
    o: i64,
    cr: i64,
    cw: i64,
    im: i64,
    vs: i64,
    ri: i64,
    fresh: i64,
}

impl Sums {
    fn add(&mut self, o: &Sums) {
        self.n += o.n;
        self.i += o.i;
        self.o += o.o;
        self.cr += o.cr;
        self.cw += o.cw;
        self.im += o.im;
        self.vs += o.vs;
        self.ri += o.ri;
        self.fresh += o.fresh;
    }

    fn totals(&self, weight: f64) -> UsageTotals {
        UsageTotals {
            events: self.n,
            input_tokens: self.i,
            output_tokens: self.o,
            cache_read_tokens: self.cr,
            cache_write_tokens: self.cw,
            fresh_input_tokens: self.fresh,
            counted_tokens: counted_tokens(self.i + self.o, self.ri, weight),
            images: self.im,
            video_seconds: self.vs,
        }
    }

    fn used(&self, metric: Metric, weight: f64) -> i64 {
        match metric {
            Metric::Tokens => counted_tokens(self.i + self.o, self.ri, weight),
            Metric::Images => self.im,
            Metric::VideoSeconds => self.vs,
        }
    }
}

fn sums_columns() -> String {
    format!(
        "COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, \
         COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw, \
         COALESCE(SUM(images),0) AS im, COALESCE(SUM(video_seconds),0) AS vs, \
         COALESCE(SUM({CACHE_READS_SQL}),0) AS ri, \
         COALESCE(SUM(MAX(0, input_tokens - cache_read_tokens - cache_write_tokens)),0) AS fresh"
    )
}

fn read_sums(
    r: &plur1bus_store::rusqlite::Row<'_>,
    at: usize,
) -> plur1bus_store::rusqlite::Result<Sums> {
    Ok(Sums {
        n: r.get(at)?,
        i: r.get(at + 1)?,
        o: r.get(at + 2)?,
        cr: r.get(at + 3)?,
        cw: r.get(at + 4)?,
        im: r.get(at + 5)?,
        vs: r.get(at + 6)?,
        ri: r.get(at + 7)?,
        fresh: r.get(at + 8)?,
    })
}

/// `sums`: the counts of the ledger rows with `start <= ts < end`, of one agent or of all.
fn sums(conn: &Connection, start: i64, end: i64, agent: Option<&str>) -> Result<Sums, BudgetError> {
    let cols = sums_columns();
    Ok(match agent {
        None => conn.query_row(
            &format!("SELECT {cols} FROM usage_event WHERE ts >= ? AND ts < ?"),
            params![start, end],
            |r| read_sums(r, 0),
        )?,
        Some(a) => conn.query_row(
            &format!("SELECT {cols} FROM usage_event WHERE ts >= ? AND ts < ? AND agent = ?"),
            params![start, end, a],
            |r| read_sums(r, 0),
        )?,
    })
}

/// A `budget_limit` row. The legacy `cost` metric never reaches this type: the queries leave it out.
#[derive(Clone, Debug)]
pub(crate) struct LimitRow {
    pub(crate) scope: LimitScope,
    pub(crate) agent: String,
    pub(crate) period: Period,
    pub(crate) metric: Metric,
    pub(crate) soft: Option<i64>,
    pub(crate) hard: Option<i64>,
}

impl LimitRow {
    fn to_limit(&self) -> Limit {
        Limit {
            scope: self.scope,
            agent_id: (self.scope == LimitScope::Agent).then(|| self.agent.clone()),
            period: self.period,
            metric: self.metric,
            soft: self.soft,
            hard: self.hard,
        }
    }

    fn agent_id(&self) -> Option<String> {
        (self.scope == LimitScope::Agent).then(|| self.agent.clone())
    }
}

/// `TOKEN_LIMITS`: what `check` and `recordUsage` notices look at.
const TOKEN_LIMITS: &str = "metric = 'tokens'";
/// `KNOWN_LIMITS`: every limit this core knows (status, limits, set). A `cost` row left by an older core is ignored (never
/// read, never enforced) rather than dropped by a migration, so an older core can still open the store.
const KNOWN_LIMITS: &str = "metric IN ('tokens', 'images', 'videoSeconds')";

fn parse_limit_row(
    r: &plur1bus_store::rusqlite::Row<'_>,
) -> plur1bus_store::rusqlite::Result<Option<LimitRow>> {
    let scope: String = r.get(0)?;
    let period: String = r.get(2)?;
    let metric: String = r.get(3)?;
    Ok(
        match (
            scope.as_str(),
            Period::parse(&period),
            Metric::parse(&metric),
        ) {
            (s @ ("global" | "agent"), Some(period), Some(metric)) => Some(LimitRow {
                scope: if s == "global" {
                    LimitScope::Global
                } else {
                    LimitScope::Agent
                },
                agent: r.get(1)?,
                period,
                metric,
                soft: r.get(4)?,
                hard: r.get(5)?,
            }),
            _ => None,
        },
    )
}

pub(crate) fn limit_rows(
    conn: &Connection,
    agent: Option<&str>,
    which: &str,
) -> Result<Vec<LimitRow>, BudgetError> {
    let base = "SELECT scope, agent, period, metric, soft, hard FROM budget_limit";
    let mut out = Vec::new();
    match agent {
        None => {
            let mut st = conn.prepare(&format!(
                "{base} WHERE {which} ORDER BY scope, agent, period, metric"
            ))?;
            for row in st.query_map([], parse_limit_row)? {
                out.extend(row?);
            }
        }
        Some(a) => {
            let mut st = conn.prepare(&format!(
                "{base} WHERE {which} AND (scope = 'global' OR agent = ?) ORDER BY scope, agent, period, metric"
            ))?;
            for row in st.query_map([a], parse_limit_row)? {
                out.extend(row?);
            }
        }
    }
    Ok(out)
}

/// `firstNotice`: inserts the notice and reports whether it is the first for the period (a restart does not re-warn).
fn first_notice(
    conn: &Connection,
    kind: &str,
    r: &LimitRow,
    period_key: &str,
    ts: i64,
) -> Result<bool, BudgetError> {
    let n = conn.execute(
        "INSERT OR IGNORE INTO notice (kind, scope, agent, period, metric, period_key, ts) VALUES (?,?,?,?,?,?,?)",
        params![kind, r.scope.as_str(), r.agent, r.period.as_str(), r.metric.as_str(), period_key, ts],
    )?;
    Ok(n == 1)
}

fn event_for(
    kind: EventKind,
    r: &LimitRow,
    limit: i64,
    used: i64,
    period_key: &str,
) -> BudgetEvent {
    BudgetEvent {
        kind,
        scope: r.scope,
        agent_id: r.agent_id(),
        period: r.period,
        metric: r.metric,
        limit,
        used,
        period_key: period_key.to_owned(),
    }
}

/// The budget service over one store.
pub struct BudgetService {
    store: Mutex<Store>,
    clock: Arc<dyn Clock>,
    zones: Arc<dyn Zones>,
    events: Option<EventSink>,
    default_tz: String,
}

impl BudgetService {
    /// `createBudgetService`.
    pub fn open(o: BudgetServiceOptions<'_>) -> Result<Self, BudgetError> {
        let store = store::open(
            o.path,
            &OpenOptions {
                busy_timeout_ms: o.busy_timeout_ms,
                secure_path: o.secure_path,
            },
        )?;
        let default_tz =
            validate_time_zone(o.zones.as_ref(), o.default_time_zone.unwrap_or("UTC"))?;
        Ok(Self {
            store: Mutex::new(store),
            clock: o.clock,
            zones: o.zones,
            events: o.events,
            default_tz,
        })
    }

    fn lock(&self) -> MutexGuard<'_, Store> {
        // A panic while the lock was held leaves the store consistent (the transaction rolled back); keep serving.
        self.store
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn emit(&self, events: &[BudgetEvent]) {
        let Some(sink) = &self.events else { return };
        for e in events {
            // A sink must not break accounting.
            let _ = catch_unwind(AssertUnwindSafe(|| sink(e)));
        }
    }

    fn tz(&self, conn: &Connection) -> Result<String, BudgetError> {
        let v: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'timezone'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(match v {
            None => self.default_tz.clone(),
            Some(v) => validate_time_zone(self.zones.as_ref(), &v)
                .unwrap_or_else(|_| self.default_tz.clone()),
        })
    }

    fn used_for(
        &self,
        conn: &Connection,
        l: &LimitRow,
        ts: i64,
        tz: &str,
        w: f64,
    ) -> Result<(i64, PeriodBounds), BudgetError> {
        let b = period_bounds(self.zones.as_ref(), ts, tz, CallPeriod::from(l.period))?;
        let s = sums(
            conn,
            b.start,
            b.end,
            (l.scope == LimitScope::Agent).then_some(l.agent.as_str()),
        )?;
        Ok((s.used(l.metric, w), b))
    }

    #[allow(clippy::too_many_lines)]
    fn check_in(
        &self,
        conn: &Connection,
        agent: &str,
        model: &str,
        est: &UsageEstimate<'_>,
        out: Option<&mut Vec<BudgetEvent>>,
    ) -> Result<CheckDecision, BudgetError> {
        ident("agent", agent)?;
        ident("model", model)?;
        count("estimate.inputTokens", est.input_tokens)?;
        if let Some(o) = est.output_tokens {
            count("estimate.outputTokens", o)?;
        }
        if let Some(p) = est.provider {
            ident("provider", p)?;
        }
        let now = self.clock.now();
        let tz = self.tz(conn)?;
        let weight = stored_cache_read_weight(conn)?;
        let estimate = est.input_tokens + est.output_tokens.unwrap_or(0);
        let mut breaches = Vec::new();
        let mut warnings: Vec<Warning> = Vec::new();
        let mut pending: Vec<(usize, LimitRow, String, i64)> = Vec::new();
        for r in limit_rows(conn, Some(agent), TOKEN_LIMITS)? {
            let (used, bounds) = self.used_for(conn, &r, now, &tz, weight)?;
            if let Some(hard) = r.hard {
                if used + estimate > hard {
                    breaches.push(Breach {
                        scope: r.scope,
                        agent_id: r.agent_id(),
                        period: r.period,
                        metric: r.metric,
                        limit: hard,
                        used,
                        estimate,
                        period_key: bounds.key.clone(),
                        resets_at: bounds.end,
                    });
                    continue;
                }
            }
            if let Some(soft) = r.soft.filter(|s| used + estimate > *s) {
                warnings.push(Warning {
                    scope: r.scope,
                    agent_id: r.agent_id(),
                    period: r.period,
                    metric: r.metric,
                    limit: soft,
                    used,
                    estimate,
                    period_key: bounds.key.clone(),
                    notified: false,
                });
                pending.push((warnings.len() - 1, r, bounds.key, used));
            }
        }
        // A refused call never happens, so it notifies nobody; an allowed one warns once per limit and period.
        if let (true, Some(out)) = (breaches.is_empty(), out) {
            for (i, r, key, used) in pending {
                warnings[i].notified = first_notice(conn, "soft", &r, &key, now)?;
                if warnings[i].notified {
                    out.push(event_for(
                        EventKind::Soft,
                        &r,
                        r.soft.unwrap_or(0),
                        used,
                        &key,
                    ));
                }
            }
        }
        Ok(CheckDecision {
            allowed: breaches.is_empty(),
            breaches,
            warnings,
        })
    }

    fn checked(
        &self,
        agent: &str,
        model: &str,
        est: &UsageEstimate<'_>,
    ) -> Result<CheckDecision, BudgetError> {
        let mut out = Vec::new();
        let d = {
            let mut store = self.lock();
            store.write_with(|tx| self.check_in(tx, agent, model, est, Some(&mut out)))?
        };
        self.emit(&out);
        Ok(d)
    }

    /// `check`: advisory, never fails on a breach (there is no reservation, so concurrent in-flight calls can overshoot by
    /// their own estimates). A soft limit warns once per limit and period, persisted, so a restart does not warn again.
    pub fn check(
        &self,
        agent: &str,
        model: &str,
        estimate: &UsageEstimate<'_>,
    ) -> Result<CheckDecision, BudgetError> {
        self.checked(agent, model, estimate)
    }

    /// `enforce`: `check`, refusing on a breach.
    pub fn enforce(
        &self,
        agent: &str,
        model: &str,
        estimate: &UsageEstimate<'_>,
    ) -> Result<CheckDecision, BudgetError> {
        let d = self.checked(agent, model, estimate)?;
        if d.allowed {
            Ok(d)
        } else {
            let message = format!(
                "budget exceeded for agent \"{agent}\" calling {model}: {}",
                d.breaches
                    .iter()
                    .map(describe_breach)
                    .collect::<Vec<_>>()
                    .join("; ")
            );
            Err(BudgetError::Exceeded(Box::new(BudgetExceeded {
                decision: d,
                message,
            })))
        }
    }

    /// `recordUsage`.
    pub fn record_usage(&self, e: &UsageEvent<'_>) -> Result<RecordResult, BudgetError> {
        let agent = ident("agent", e.agent)?;
        let model = ident("model", e.model)?;
        let provider = match e.provider {
            None => "",
            Some(p) => ident("provider", p)?,
        };
        let request_id = e.request_id.map(|r| ident("requestId", r)).transpose()?;
        let input_tokens = count("inputTokens", e.input_tokens)?;
        let output_tokens = count("outputTokens", e.output_tokens)?;
        let cache_read = count("cacheReadTokens", e.cache_read_tokens.unwrap_or(0))?;
        let cache_write = count("cacheWriteTokens", e.cache_write_tokens.unwrap_or(0))?;
        let ts = match e.ts {
            None => self.clock.now(),
            Some(t) => count("ts", t)?,
        };
        if ts > MAX_TS {
            return Err(input("ts is outside the range of dates"));
        }
        if input_tokens + output_tokens > super::MAX_SAFE {
            return Err(input(
                "the token count of this event exceeds the range the ledger can hold",
            ));
        }
        let mut out = Vec::new();
        let result = {
            let mut store = self.lock();
            let tz = self.tz(store.conn())?;
            let weight = stored_cache_read_weight(store.conn())?;
            store.write_with(|tx| {
                let changed = tx.execute(
                    "INSERT OR IGNORE INTO usage_event (ts, agent, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, price_version, request_id) \
                     VALUES (?,?,?,?,?,?,?,?,?,?)",
                    params![ts, agent, provider, model, input_tokens, output_tokens, cache_read, cache_write, "", request_id],
                )?;
                let recorded = changed == 1;
                if recorded {
                    for r in limit_rows(tx, Some(agent), TOKEN_LIMITS)? {
                        let (used, bounds) = self.used_for(tx, &r, ts, &tz, weight)?;
                        if let Some(hard) = r.hard.filter(|h| used > *h) {
                            // Past the hard limit the soft notice is moot: consume it silently so it is not announced late.
                            if r.soft.is_some() {
                                first_notice(tx, "soft", &r, &bounds.key, ts)?;
                            }
                            if first_notice(tx, "hard", &r, &bounds.key, ts)? {
                                out.push(event_for(EventKind::Hard, &r, hard, used, &bounds.key));
                            }
                        } else if let Some(soft) = r.soft.filter(|s| used > *s) {
                            if first_notice(tx, "soft", &r, &bounds.key, ts)? {
                                out.push(event_for(EventKind::Soft, &r, soft, used, &bounds.key));
                            }
                        }
                    }
                }
                Ok::<_, BudgetError>(RecordResult { recorded })
            })?
        };
        self.emit(&out);
        Ok(result)
    }

    /// `cacheUsage`: prompt-cache usage per provider, agent and model over `[since, until)` (D120 H2-1). Read-only.
    pub fn cache_usage(
        &self,
        since: i64,
        until: i64,
        agent_id: Option<&str>,
    ) -> Result<Vec<CacheUsageRow>, BudgetError> {
        count("since", since)?;
        count("until", until)?;
        if since > until {
            return Err(input("since must not be after until"));
        }
        if let Some(a) = agent_id {
            ident("agentId", a)?;
        }
        summarize_cache_usage(self.lock().conn(), since, until, agent_id)
    }

    /// `status`.
    pub fn status(&self, agent_id: Option<&str>) -> Result<BudgetStatus, BudgetError> {
        let store = self.lock();
        let conn = store.conn();
        let now = self.clock.now();
        let tz = self.tz(conn)?;
        let weight = stored_cache_read_weight(conn)?;
        if let Some(a) = agent_id {
            ident("agentId", a)?;
        }
        let mut periods = Vec::new();
        for period in PERIODS {
            let b = period_bounds(self.zones.as_ref(), now, &tz, CallPeriod::from(period))?;
            let total = sums(conn, b.start, b.end, agent_id)?.totals(weight);
            let cols = sums_columns();
            let filter = if agent_id.is_some() {
                " AND agent = ?3"
            } else {
                ""
            };
            let sql = format!(
                "SELECT {cols}, agent, model FROM usage_event WHERE ts >= ?1 AND ts < ?2{filter} GROUP BY agent, model ORDER BY agent, model"
            );
            let mut st = conn.prepare(&sql)?;
            let map = |r: &plur1bus_store::rusqlite::Row<'_>| -> plur1bus_store::rusqlite::Result<(Sums, String, String)> {
                Ok((read_sums(r, 0)?, r.get(9)?, r.get(10)?))
            };
            let rows: Vec<(Sums, String, String)> = match agent_id {
                None => st
                    .query_map(params![b.start, b.end], map)?
                    .collect::<Result<_, _>>()?,
                Some(a) => st
                    .query_map(params![b.start, b.end, a], map)?
                    .collect::<Result<_, _>>()?,
            };
            // Unrounded counts are kept until the agent total is complete: summing rounded model totals would overcount.
            let mut agents: Vec<(String, Sums, Vec<StatusModel>)> = Vec::new();
            for (row, agent, model) in rows {
                if agents.last().is_none_or(|a| a.0 != agent) {
                    agents.push((agent, Sums::default(), Vec::new()));
                }
                if let Some(a) = agents.last_mut() {
                    a.2.push(StatusModel {
                        model,
                        total: row.totals(weight),
                    });
                    a.1.add(&row);
                }
            }
            periods.push(StatusPeriod {
                period,
                key: b.key,
                start: b.start,
                end: b.end,
                total,
                agents: agents
                    .into_iter()
                    .map(|(agent_id, row, models)| StatusAgent {
                        agent_id,
                        total: row.totals(weight),
                        models,
                    })
                    .collect(),
            });
        }
        let mut limits = Vec::new();
        for r in limit_rows(conn, agent_id, KNOWN_LIMITS)? {
            let (used, _) = self.used_for(conn, &r, now, &tz, weight)?;
            let state = if r.hard.is_some_and(|h| used >= h) {
                LimitState::Hard
            } else if r.soft.is_some_and(|s| used >= s) {
                LimitState::Soft
            } else {
                LimitState::Ok
            };
            limits.push(StatusLimit {
                limit: r.to_limit(),
                used,
                state,
            });
        }
        Ok(BudgetStatus {
            time_zone: tz,
            cache_read_weight: weight,
            now,
            periods,
            limits,
        })
    }

    /// `limits`: every limit this core knows.
    pub fn limits(&self) -> Result<Vec<Limit>, BudgetError> {
        Ok(limit_rows(self.lock().conn(), None, KNOWN_LIMITS)?
            .iter()
            .map(LimitRow::to_limit)
            .collect())
    }

    fn store_limit(
        &self,
        tx: &Connection,
        l: &BudgetLimitUpdate,
    ) -> Result<Option<Limit>, BudgetError> {
        let k = &l.key;
        let agent = match (k.scope, k.agent_id.as_deref()) {
            (LimitScope::Agent, Some(id)) => ident("agentId", id)?.to_owned(),
            (LimitScope::Agent, None) => {
                return Err(input(
                    "agentId must be an identifier (1-128 chars of A-Z a-z 0-9 . _ : / @ + = -)",
                ))
            }
            (LimitScope::Global, Some(_)) => return Err(input("a global limit takes no agentId")),
            (LimitScope::Global, None) => String::new(),
        };
        let bound = |name: &str, b: Bound| -> Result<Bound, BudgetError> {
            if let Bound::Set(v) = b {
                count(name, v)?;
            }
            Ok(b)
        };
        let (soft, hard) = (bound("soft", l.soft)?, bound("hard", l.hard)?);
        let cur: Option<(Option<i64>, Option<i64>)> = tx
            .query_row(
                "SELECT soft, hard FROM budget_limit WHERE scope = ? AND agent = ? AND period = ? AND metric = ?",
                params![k.scope.as_str(), agent, k.period.as_str(), k.metric.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let pick = |b: Bound, current: Option<i64>| match b {
            Bound::Keep => current,
            Bound::Clear => None,
            Bound::Set(v) => Some(v),
        };
        let next_soft = pick(soft, cur.and_then(|c| c.0));
        let next_hard = pick(hard, cur.and_then(|c| c.1));
        if next_soft.is_none() && next_hard.is_none() {
            tx.execute(
                "DELETE FROM budget_limit WHERE scope = ? AND agent = ? AND period = ? AND metric = ?",
                params![k.scope.as_str(), agent, k.period.as_str(), k.metric.as_str()],
            )?;
            return Ok(None);
        }
        if let (Some(s), Some(h)) = (next_soft, next_hard) {
            if s > h {
                return Err(input("soft limit must not exceed the hard limit"));
            }
        }
        tx.execute(
            "INSERT INTO budget_limit (scope, agent, period, metric, soft, hard) VALUES (?,?,?,?,?,?) \
             ON CONFLICT (scope, agent, period, metric) DO UPDATE SET soft = excluded.soft, hard = excluded.hard",
            params![k.scope.as_str(), agent, k.period.as_str(), k.metric.as_str(), next_soft, next_hard],
        )?;
        Ok(Some(
            LimitRow {
                scope: k.scope,
                agent,
                period: k.period,
                metric: k.metric,
                soft: next_soft,
                hard: next_hard,
            }
            .to_limit(),
        ))
    }

    fn store_time_zone(&self, tx: &Connection, tz: &str) -> Result<String, BudgetError> {
        let v = validate_time_zone(self.zones.as_ref(), tz)?;
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('timezone', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [&v],
        )?;
        Ok(v)
    }

    /// `setLimit`: a bound left as `Keep` stays, `Clear` removes it; a limit with neither bound left is removed (`None`).
    pub fn set_limit(&self, l: &BudgetLimitUpdate) -> Result<Option<Limit>, BudgetError> {
        self.lock().write_with(|tx| self.store_limit(tx, l))
    }

    /// `updateSettings`: applies every supplied setting atomically; a rejected one rolls back the whole update.
    pub fn update_settings(&self, s: &BudgetSettings) -> Result<BudgetSettingsResult, BudgetError> {
        self.lock().write_with(|tx| {
            let limit = match &s.limit {
                None => None,
                Some(l) => Some(self.store_limit(tx, l)?),
            };
            if let Some(tz) = &s.time_zone {
                self.store_time_zone(tx, tz)?;
            }
            if let Some(w) = s.cache_read_weight {
                write_cache_read_weight(tx, w)?;
            }
            Ok::<_, BudgetError>(BudgetSettingsResult {
                time_zone: self.tz(tx)?,
                cache_read_weight: stored_cache_read_weight(tx)?,
                limit,
                limits: limit_rows(tx, None, KNOWN_LIMITS)?
                    .iter()
                    .map(LimitRow::to_limit)
                    .collect(),
            })
        })
    }

    /// `timeZone`.
    pub fn time_zone(&self) -> Result<String, BudgetError> {
        self.tz(self.lock().conn())
    }

    /// `setTimeZone`.
    pub fn set_time_zone(&self, tz: &str) -> Result<String, BudgetError> {
        self.lock().write_with(|tx| self.store_time_zone(tx, tz))
    }

    /// `cacheReadWeight`: 1, the default, counts cache reads in full.
    pub fn cache_read_weight(&self) -> Result<f64, BudgetError> {
        stored_cache_read_weight(self.lock().conn())
    }

    /// `setCacheReadWeight`: stores a weight from 0 to 1, rounded to millionths, and returns it as stored.
    pub fn set_cache_read_weight(&self, w: f64) -> Result<f64, BudgetError> {
        self.lock().write_with(|tx| write_cache_read_weight(tx, w))
    }

    /// `prune`: deletes usage events older than `before_ts`; returns how many.
    pub fn prune(&self, before_ts: i64) -> Result<usize, BudgetError> {
        count("beforeTs", before_ts)?;
        self.lock().write_with(|tx| {
            Ok::<_, BudgetError>(tx.execute("DELETE FROM usage_event WHERE ts < ?", [before_ts])?)
        })
    }
}
