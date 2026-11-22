//! `budget/calls.ts` (L8): the persistent pre-call port. A call asks [`CallBudget::check_before_call`] for admission, which
//! reserves its estimate atomically under the write lock across the hierarchy global, user, project, agent, turn and session
//! (the tightest remaining ceiling refuses), and settles with the actual usage afterwards. No provider, session, RPC, logging
//! or prompt-content dependency. It counts tokens, calls and media units; there is no money dimension. It shares the ledger
//! of [`super::service`] and honours the limits set there ("legacy" limits below).
//!
//! A reservation that nobody settles or releases stops counting after `reservation_ttl_ms` (30 minutes by default, which must
//! exceed the longest provider call) and is reconciled on open and by [`CallBudget::reconcile_expired`]. Tokens a pending
//! reservation holds are the unweighted estimate; settled tokens count cache reads with the weight of
//! [`super::weight`]. The TypeScript `maintenance` seam (a deferred start while an import holds the store) is the
//! composition's business and is not ported: the reconcile on open runs at once.
use super::period::{period_bounds, validate_time_zone, CallPeriod, Zones};
use super::service::Metric;
use super::store::{self, OpenOptions};
use super::weight::{
    counted_tokens, stored_cache_read_weight, CACHE_READS_SQL, DEFAULT_CACHE_READ_WEIGHT,
};
use super::{input, BudgetError, Clock, IdSource, StoreErrorCode, MAX_TS};
use plur1bus_store::rusqlite::{params, Connection, OptionalExtension};
use plur1bus_store::Store;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

/// `DEFAULT_RESERVATION_TTL_MS`.
pub const DEFAULT_RESERVATION_TTL_MS: i64 = 30 * 60_000;

/// `CallScope`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallScope {
    /// Everything.
    Global,
    /// One principal.
    User,
    /// One project.
    Project,
    /// One agent.
    Agent,
    /// One turn, for its lifetime.
    Turn,
    /// One session, for its lifetime.
    Session,
}

impl CallScope {
    /// The name the store uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::User => "user",
            Self::Project => "project",
            Self::Agent => "agent",
            Self::Turn => "turn",
            Self::Session => "session",
        }
    }

    /// A scope by name.
    pub fn parse(s: &str) -> Option<Self> {
        [
            Self::Global,
            Self::User,
            Self::Project,
            Self::Agent,
            Self::Turn,
            Self::Session,
        ]
        .into_iter()
        .find(|c| c.as_str() == s)
    }

    /// The `budget_call` column the scope matches (`COLUMN`), or `None` for the global scope.
    fn column(self) -> Option<&'static str> {
        match self {
            Self::Global => None,
            Self::User => Some("principal"),
            Self::Project => Some("project"),
            Self::Agent => Some("agent"),
            Self::Turn => Some("turn"),
            Self::Session => Some("session"),
        }
    }
}

/// `MediaAmounts`: media units of an event or allowance. A unit that is 0 is "left out".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MediaAmounts {
    /// Images.
    pub images: i64,
    /// Video seconds.
    pub video_seconds: i64,
}

/// `CallRequest`.
#[derive(Clone, Debug, Default)]
pub struct CallRequest<'a> {
    /// The user.
    pub principal: &'a str,
    /// The agent.
    pub agent: &'a str,
    /// The project.
    pub project: &'a str,
    /// The model.
    pub model: &'a str,
    /// The provider.
    pub provider: Option<&'a str>,
    /// Estimated prompt tokens.
    pub estimated_input_tokens: i64,
    /// The cap on output tokens.
    pub max_output_tokens: i64,
    /// Media units the call asks for: images, `n` per request. Absent: 0.
    pub images: Option<i64>,
    /// Video seconds asked for. Absent: 0.
    pub video_seconds: Option<i64>,
    /// The turn.
    pub turn: Option<&'a str>,
    /// The session.
    pub session: Option<&'a str>,
}

/// `CallLimit`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallLimit {
    /// The scope.
    pub scope: CallScope,
    /// What it matches: empty for global.
    pub id: String,
    /// The period (ignored for turn and session, which count for their lifetime).
    pub period: CallPeriod,
    /// What is counted.
    pub metric: Metric,
    /// Refuse above this.
    pub hard: i64,
    /// Warn at this; 80% of `hard`, rounded down, when `None`.
    pub soft: Option<i64>,
}

/// `CallRefusal`: `kind: 'refuse'`, `code: 'budget_exceeded'`, `reason: 'hard'`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallRefusal {
    /// The refusing scope.
    pub scope: CallScope,
    /// The hard limit.
    pub limit: i64,
    /// What it has used.
    pub used: i64,
    /// What the call asked.
    pub estimate: i64,
    /// What is counted.
    pub metric: Metric,
    /// The id the limit matches.
    pub id: String,
    /// When the period ends (far future for a lifetime limit).
    pub resets_at: i64,
}

/// `CallAllowance`: what the reservation holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallAllowance {
    /// The reservation to settle or release.
    pub reservation_id: String,
    /// Estimated input plus maximum output.
    pub estimated_tokens: i64,
    /// Media units reserved.
    pub media: MediaAmounts,
}

/// `CallDecision`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallDecision {
    /// Admitted, with a reservation.
    Allow(CallAllowance),
    /// Refused by a hard limit.
    Refuse(CallRefusal),
}

/// `CallBudgetEvent`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallBudgetEvent {
    /// A soft limit is reached (once per limit and period).
    Warn {
        /// Scope.
        scope: CallScope,
        /// Id.
        id: String,
        /// Use including this call.
        used: i64,
        /// The soft limit.
        limit: i64,
        /// Metric.
        metric: Metric,
    },
    /// A call was refused.
    Refuse(CallRefusal),
    /// A reservation was made.
    Reserve {
        /// Its id.
        reservation_id: String,
        /// Tokens held.
        tokens: i64,
        /// Media held.
        media: MediaAmounts,
    },
    /// A reservation was settled.
    Settle {
        /// Its id.
        reservation_id: String,
        /// Actual tokens.
        tokens: i64,
        /// Limits the actual usage passed.
        overages: Vec<CallRefusal>,
        /// Actual media.
        media: MediaAmounts,
    },
    /// An unused reservation was released.
    Release {
        /// Its id.
        reservation_id: String,
    },
    /// An orphaned reservation was reconciled.
    Expire {
        /// Its id.
        reservation_id: String,
        /// Tokens it held.
        tokens: i64,
        /// When it was made.
        reserved_at: i64,
        /// Media it held.
        media: MediaAmounts,
    },
}

/// `BudgetEmitter`: audit availability must not corrupt committed accounting, so a failing emitter is ignored.
pub trait BudgetEmitter: Send + Sync {
    /// Receives one event, after the transaction that caused it committed.
    fn emit(&self, event: &CallBudgetEvent);
}

/// `ActualCallUsage`: media is what a media call delivered; fewer than reserved frees the rest.
#[derive(Clone, Copy, Debug, Default)]
pub struct ActualCallUsage {
    /// Prompt tokens.
    pub input_tokens: i64,
    /// Output tokens.
    pub output_tokens: i64,
    /// Cache reads.
    pub cache_read_tokens: Option<i64>,
    /// Cache writes.
    pub cache_write_tokens: Option<i64>,
    /// Images delivered.
    pub images: Option<i64>,
    /// Video seconds delivered.
    pub video_seconds: Option<i64>,
}

/// `Settlement`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    /// False when the reservation was settled before.
    pub recorded: bool,
    /// Limits the actual usage passed.
    pub overages: Vec<CallRefusal>,
}

/// What [`CallBudget::reservation`] shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReservationView {
    /// True once settled.
    pub settled: bool,
    /// Tokens held or used.
    pub tokens: i64,
    /// Media held or used.
    pub media: MediaAmounts,
    /// A reserved row past its TTL.
    pub expired: bool,
}

/// `CallBudgetOptions`.
pub struct CallBudgetOptions<'a> {
    /// `state/budget.sqlite`.
    pub path: &'a Path,
    /// The clock.
    pub clock: Arc<dyn Clock>,
    /// The time-zone database.
    pub zones: Arc<dyn Zones>,
    /// Reservation ids.
    pub ids: Arc<dyn IdSource>,
    /// The event emitter.
    pub emitter: Option<Arc<dyn BudgetEmitter>>,
    /// `defaultTimeZone`; `UTC` when `None`.
    pub default_time_zone: Option<&'a str>,
    /// `securePath`.
    pub secure_path: Option<&'a dyn Fn(&Path)>,
    /// `busyTimeoutMs`.
    pub busy_timeout_ms: Option<u64>,
    /// `reservationTtlMs`; [`DEFAULT_RESERVATION_TTL_MS`] when `None`.
    pub reservation_ttl_ms: Option<i64>,
}

/// Why [`CallBudget::run`] did not return the call's value.
#[derive(Debug)]
pub enum RunError<E> {
    /// `CallBudgetExceededError`: refused before the call.
    Refused(CallRefusal),
    /// `CallUsagePendingError`: the call or its settlement failed; the reservation stays until reconciled.
    UsagePending {
        /// The reservation to settle or release.
        reservation_id: String,
        /// What failed.
        cause: RunCause<E>,
    },
    /// Admission itself failed.
    Budget(BudgetError),
}

/// The cause of a [`RunError::UsagePending`].
#[derive(Debug)]
pub enum RunCause<E> {
    /// The provider call failed.
    Call(E),
    /// Settlement failed.
    Settle(BudgetError),
}

const LEDGER_PREFIX: &str = "budget-call:";
/// A settled `budget_call`'s cache reads (RE-D29), looked up in the usage event its settlement wrote.
fn call_reads_sql() -> String {
    format!("(SELECT {CACHE_READS_SQL} FROM usage_event WHERE request_id = '{LEDGER_PREFIX}' || budget_call.id)")
}

/// The statements a constructor runs on the store, outside `user_version`: the same text as the TypeScript constructor.
const CALL_TABLES: &str = r#"
      CREATE TABLE IF NOT EXISTS budget_call (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, project TEXT NOT NULL, agent TEXT NOT NULL,
        model TEXT NOT NULL, provider TEXT NOT NULL, turn TEXT NOT NULL, session TEXT NOT NULL,
        ts INTEGER NOT NULL, tokens INTEGER NOT NULL CHECK(tokens >= 0), cost INTEGER CHECK(cost >= 0),
        state TEXT NOT NULL CHECK(state IN ('reserved','settled')),
        images INTEGER NOT NULL DEFAULT 0 CHECK(images >= 0), video_seconds INTEGER NOT NULL DEFAULT 0 CHECK(video_seconds >= 0)
      );
      CREATE INDEX IF NOT EXISTS budget_call_state_ts ON budget_call(state, ts);
      CREATE TABLE IF NOT EXISTS budget_call_limit (
        scope TEXT NOT NULL, id TEXT NOT NULL, period TEXT NOT NULL, metric TEXT NOT NULL,
        hard INTEGER NOT NULL CHECK(hard >= 0), soft INTEGER NOT NULL CHECK(soft >= 0 AND soft <= hard),
        PRIMARY KEY(scope,id,period,metric)
      );
      CREATE TABLE IF NOT EXISTS budget_call_notice (
        scope TEXT NOT NULL, id TEXT NOT NULL, period TEXT NOT NULL, metric TEXT NOT NULL, period_key TEXT NOT NULL,
        PRIMARY KEY(scope,id,period,metric,period_key)
      );
    "#;

#[derive(Clone, Copy, Default)]
struct Amounts {
    tokens: i64,
    images: i64,
    video_seconds: i64,
}

impl Amounts {
    fn get(&self, m: Metric) -> i64 {
        match m {
            Metric::Tokens => self.tokens,
            Metric::Images => self.images,
            Metric::VideoSeconds => self.video_seconds,
        }
    }

    fn media(&self) -> MediaAmounts {
        MediaAmounts {
            images: self.images,
            video_seconds: self.video_seconds,
        }
    }
}

/// The column each metric is counted in on a reservation, and summed on the ledger.
fn reserved_col(m: Metric) -> &'static str {
    match m {
        Metric::Tokens => "tokens",
        Metric::Images => "images",
        Metric::VideoSeconds => "video_seconds",
    }
}

fn settled_col(m: Metric) -> &'static str {
    match m {
        Metric::Tokens => "input_tokens+output_tokens",
        Metric::Images => "images",
        Metric::VideoSeconds => "video_seconds",
    }
}

/// The metrics this core knows, as SQL.
const METRIC_LIST: &str = "'tokens','images','videoSeconds'";

#[derive(Clone)]
struct CallRow {
    id: String,
    principal: String,
    project: String,
    agent: String,
    model: String,
    provider: String,
    turn: String,
    session: String,
    ts: i64,
    tokens: i64,
    images: i64,
    video_seconds: i64,
}

impl CallRow {
    fn amounts(&self) -> Amounts {
        Amounts {
            tokens: self.tokens,
            images: self.images,
            video_seconds: self.video_seconds,
        }
    }

    fn value(&self, scope: CallScope) -> &str {
        match scope {
            CallScope::Global => "",
            CallScope::User => &self.principal,
            CallScope::Project => &self.project,
            CallScope::Agent => &self.agent,
            CallScope::Turn => &self.turn,
            CallScope::Session => &self.session,
        }
    }
}

#[derive(Clone)]
struct LimitRow {
    scope: CallScope,
    id: String,
    period: CallPeriod,
    metric: Metric,
    hard: Option<i64>,
    soft: i64,
}

/// A limit counts for a call when it is a token limit (token limits gate every call) or the call uses that unit, so an image
/// limit never stops a chat.
fn applies(l: &LimitRow, a: &Amounts) -> bool {
    l.metric == Metric::Tokens || a.get(l.metric) > 0
}

const CALL_COLUMNS: &str = "id, principal, project, agent, model, provider, turn, session, ts, tokens, images, video_seconds";

fn call_row(r: &plur1bus_store::rusqlite::Row<'_>) -> plur1bus_store::rusqlite::Result<CallRow> {
    Ok(CallRow {
        id: r.get(0)?,
        principal: r.get(1)?,
        project: r.get(2)?,
        agent: r.get(3)?,
        model: r.get(4)?,
        provider: r.get(5)?,
        turn: r.get(6)?,
        session: r.get(7)?,
        ts: r.get(8)?,
        tokens: r.get(9)?,
        images: r.get(10)?,
        video_seconds: r.get(11)?,
    })
}

fn safe_count(v: i64) -> Result<i64, BudgetError> {
    if (0..=super::MAX_SAFE).contains(&v) {
        Ok(v)
    } else {
        Err(input("invalid budget count"))
    }
}

fn call_id(v: &str) -> Result<&str, BudgetError> {
    if super::is_identifier(v) {
        Ok(v)
    } else {
        Err(input("invalid budget identifier"))
    }
}

/// The persistent call port.
pub struct CallBudget {
    store: Mutex<Store>,
    clock: Arc<dyn Clock>,
    zones: Arc<dyn Zones>,
    ids: Arc<dyn IdSource>,
    emitter: Option<Arc<dyn BudgetEmitter>>,
    default_zone: String,
    ttl: i64,
}

impl CallBudget {
    /// `createCallBudget`: opens the store, adds the call tables and reconciles expired reservations.
    pub fn open(o: CallBudgetOptions<'_>) -> Result<Self, BudgetError> {
        let default_zone =
            validate_time_zone(o.zones.as_ref(), o.default_time_zone.unwrap_or("UTC"))?;
        let mut store = store::open(
            o.path,
            &OpenOptions {
                busy_timeout_ms: o.busy_timeout_ms,
                secure_path: o.secure_path,
            },
        )?;
        // Additive, lazy extension: the schema of the budget service stays compatible. No prompt or result columns.
        store.write_with(|tx| {
            let schema: Option<String> = tx
                .query_row("SELECT value FROM settings WHERE key='budget_call_schema'", [], |r| r.get(0))
                .optional()?;
            if schema.as_deref().is_some_and(|s| s != "1" && s != "2") {
                return Err(BudgetError::Store {
                    code: StoreErrorCode::NewerSchema,
                    message: "unsupported budget call schema".into(),
                });
            }
            tx.execute_batch(CALL_TABLES)?;
            // Call schema 2 (media units): a schema-1 table gains the two unit columns, 0 on every older reservation.
            let mut cols = Vec::new();
            let mut st = tx.prepare("PRAGMA table_info(budget_call)")?;
            for c in st.query_map([], |r| r.get::<_, String>(1))? {
                cols.push(c?);
            }
            drop(st);
            if !cols.iter().any(|c| c == "images") {
                tx.execute_batch("ALTER TABLE budget_call ADD COLUMN images INTEGER NOT NULL DEFAULT 0 CHECK(images >= 0)")?;
            }
            if !cols.iter().any(|c| c == "video_seconds") {
                tx.execute_batch("ALTER TABLE budget_call ADD COLUMN video_seconds INTEGER NOT NULL DEFAULT 0 CHECK(video_seconds >= 0)")?;
            }
            tx.execute(
                "INSERT INTO settings VALUES ('budget_call_schema','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )?;
            Ok::<_, BudgetError>(())
        })?;
        let ttl = o.reservation_ttl_ms.unwrap_or(DEFAULT_RESERVATION_TTL_MS);
        if !(1..=super::MAX_SAFE).contains(&ttl) {
            return Err(input("invalid reservation ttl"));
        }
        let b = Self {
            store: Mutex::new(store),
            clock: o.clock,
            zones: o.zones,
            ids: o.ids,
            emitter: o.emitter,
            default_zone,
            ttl,
        };
        b.reconcile_expired()?;
        Ok(b)
    }

    fn lock(&self) -> MutexGuard<'_, Store> {
        self.store
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn emit(&self, events: &[CallBudgetEvent]) {
        let Some(em) = &self.emitter else { return };
        for e in events {
            let _ = catch_unwind(AssertUnwindSafe(|| em.emit(e)));
        }
    }

    /// Reserved rows at or before this instant are expired: ignored on read, released by reconciliation.
    fn expired_before(&self) -> i64 {
        self.clock.now() - self.ttl
    }

    /// `reconcileExpired`: releases reservations past their TTL, with an `expire` event each; returns how many.
    pub fn reconcile_expired(&self) -> Result<usize, BudgetError> {
        let cutoff = self.expired_before();
        let stale = self.lock().write_with(|tx| {
            let mut st = tx.prepare("SELECT id, tokens, images, video_seconds, ts FROM budget_call WHERE state='reserved' AND ts < ?")?;
            let rows: Vec<(String, i64, i64, i64, i64)> = st
                .query_map([cutoff], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                .collect::<Result<_, _>>()?;
            drop(st);
            for (id, ..) in &rows {
                tx.execute("DELETE FROM budget_call WHERE id=? AND state='reserved'", [id])?;
            }
            Ok::<_, BudgetError>(rows)
        })?;
        let n = stale.len();
        self.emit(
            &stale
                .into_iter()
                .map(
                    |(id, tokens, images, video_seconds, ts)| CallBudgetEvent::Expire {
                        reservation_id: id,
                        tokens,
                        reserved_at: ts,
                        media: MediaAmounts {
                            images,
                            video_seconds,
                        },
                    },
                )
                .collect::<Vec<_>>(),
        );
        Ok(n)
    }

    fn zone(&self, conn: &Connection) -> Result<String, BudgetError> {
        let v: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key='timezone'", [], |r| {
                r.get(0)
            })
            .optional()?;
        validate_time_zone(
            self.zones.as_ref(),
            v.as_deref().unwrap_or(&self.default_zone),
        )
    }

    /// The limits that cover this call and apply to what it uses (`a`, see [`applies`]).
    fn limits(
        &self,
        conn: &Connection,
        r: &CallRow,
        a: &Amounts,
    ) -> Result<Vec<LimitRow>, BudgetError> {
        let mut all = Vec::new();
        // A limit row with metric 'cost' (written by an older core) is ignored: there is no money dimension any more.
        let mut st = conn.prepare(&format!(
            "SELECT scope, id, period, metric, hard, soft FROM budget_call_limit WHERE metric IN ({METRIC_LIST})"
        ))?;
        let own = st.query_map([], |x| {
            Ok((
                x.get::<_, String>(0)?,
                x.get::<_, String>(1)?,
                x.get::<_, String>(2)?,
                x.get::<_, String>(3)?,
                x.get::<_, i64>(4)?,
                x.get::<_, i64>(5)?,
            ))
        })?;
        for row in own {
            let (scope, id, period, metric, hard, soft) = row?;
            if let (Some(scope), Some(period), Some(metric)) = (
                CallScope::parse(&scope),
                CallPeriod::parse(&period),
                Metric::parse(&metric),
            ) {
                all.push(LimitRow {
                    scope,
                    id,
                    period,
                    metric,
                    hard: Some(hard),
                    soft,
                });
            }
        }
        drop(st);
        // The limits of the budget service (`budget.set`): soft-only ones warn too, a missing soft bound is 80% of the hard one.
        let mut st = conn.prepare(&format!(
            "SELECT scope, agent, period, metric, hard, soft FROM budget_limit WHERE metric IN ({METRIC_LIST})"
        ))?;
        let legacy = st.query_map([], |x| {
            Ok((
                x.get::<_, String>(0)?,
                x.get::<_, String>(1)?,
                x.get::<_, String>(2)?,
                x.get::<_, String>(3)?,
                x.get::<_, Option<i64>>(4)?,
                x.get::<_, Option<i64>>(5)?,
            ))
        })?;
        for row in legacy {
            let (scope, agent, period, metric, hard, soft) = row?;
            if let (Some(scope), Some(period), Some(metric)) = (
                CallScope::parse(&scope),
                CallPeriod::parse(&period),
                Metric::parse(&metric),
            ) {
                // `Math.floor((l.hard ?? 0) * 0.8)` over a double, as JavaScript counts.
                let default_soft = ((hard.unwrap_or(0) as f64) * 0.8).floor() as i64;
                all.push(LimitRow {
                    scope,
                    id: agent,
                    period,
                    metric,
                    hard,
                    soft: soft.unwrap_or(default_soft),
                });
            }
        }
        Ok(all
            .into_iter()
            .filter(|l| applies(l, a))
            .filter(|l| {
                l.scope == CallScope::Global
                    || (!r.value(l.scope).is_empty() && r.value(l.scope) == l.id)
            })
            .collect())
    }

    /// What a limit has used at `ts`: pending reservations (they count across a rollover, so a stalled request cannot free
    /// capacity; only past the TTL does an orphan stop counting) plus the settled use of the period.
    fn usage(&self, conn: &Connection, l: &LimitRow, ts: i64) -> Result<(i64, i64), BudgetError> {
        let lifetime = matches!(l.scope, CallScope::Turn | CallScope::Session);
        let (start, end) = if lifetime {
            (0, MAX_TS)
        } else {
            let b = period_bounds(self.zones.as_ref(), ts, &self.zone(conn)?, l.period)?;
            (b.start, b.end)
        };
        let col = l.scope.column();
        let filter = col.map(|c| format!(" AND {c} = ?")).unwrap_or_default();
        let unit = reserved_col(l.metric);
        let reserved: i64 = {
            let sql = format!("SELECT COALESCE(SUM({unit}),0) AS n FROM budget_call WHERE state='reserved' AND ts >= ?{filter}");
            let cutoff = self.expired_before();
            match col {
                Some(_) => conn.query_row(&sql, params![cutoff, l.id], |r| r.get(0))?,
                None => conn.query_row(&sql, params![cutoff], |r| r.get(0))?,
            }
        };
        // Settled tokens count cache reads with the weight (RE-D29), applied here. At full weight nothing is taken off, so
        // the reads are not summed: for a settled call they are looked up one by one.
        let weight = if l.metric == Metric::Tokens {
            stored_cache_read_weight(conn)?
        } else {
            DEFAULT_CACHE_READ_WEIGHT
        };
        let ledger = matches!(l.scope, CallScope::Global | CallScope::Agent);
        let reads = if weight < DEFAULT_CACHE_READ_WEIGHT {
            if ledger {
                CACHE_READS_SQL.to_owned()
            } else {
                call_reads_sql()
            }
        } else {
            "0".to_owned()
        };
        let (n, r): (i64, i64) = if ledger {
            let by_agent = l.scope == CallScope::Agent;
            let sql = format!(
                "SELECT COALESCE(SUM({}),0) AS n, COALESCE(SUM({reads}),0) AS r FROM usage_event WHERE ts>=? AND ts<?{}",
                settled_col(l.metric),
                if by_agent { " AND agent=?" } else { "" }
            );
            if by_agent {
                conn.query_row(&sql, params![start, end, l.id], |x| {
                    Ok((x.get(0)?, x.get(1)?))
                })?
            } else {
                conn.query_row(&sql, params![start, end], |x| Ok((x.get(0)?, x.get(1)?)))?
            }
        } else {
            let sql = format!(
                "SELECT COALESCE(SUM({unit}),0) AS n, COALESCE(SUM({reads}),0) AS r FROM budget_call WHERE state='settled' AND ts>=? AND ts<?{filter}"
            );
            conn.query_row(&sql, params![start, end, l.id], |x| {
                Ok((x.get(0)?, x.get(1)?))
            })?
        };
        let n = if l.metric == Metric::Tokens {
            counted_tokens(n, r, weight)
        } else {
            n
        };
        Ok((safe_count(reserved + n)?, end))
    }

    /// The period key a notice is filed under: the limit's own period, or the limit's id for a lifetime limit.
    fn notice_key(&self, conn: &Connection, l: &LimitRow, ts: i64) -> Result<String, BudgetError> {
        if matches!(l.scope, CallScope::Turn | CallScope::Session) {
            Ok(l.id.clone())
        } else {
            Ok(period_bounds(self.zones.as_ref(), ts, &self.zone(conn)?, l.period)?.key)
        }
    }

    /// `breaches`: `uses` decides which limits apply; `add` is what this check adds on top of the use (the request, or
    /// nothing at settlement). Sorted by what is left, tightest first.
    fn breaches(
        &self,
        conn: &Connection,
        r: &CallRow,
        uses: &Amounts,
        add: Option<&Amounts>,
        ts: i64,
    ) -> Result<Vec<CallRefusal>, BudgetError> {
        let mut out = Vec::new();
        for l in self.limits(conn, r, uses)? {
            let Some(hard) = l.hard else { continue };
            let (used, end) = self.usage(conn, &l, ts)?;
            let n = add.map_or(0, |a| a.get(l.metric));
            if n <= hard - used {
                continue;
            }
            out.push(CallRefusal {
                scope: l.scope,
                id: l.id,
                metric: l.metric,
                limit: hard,
                used,
                estimate: n,
                resets_at: end,
            });
        }
        out.sort_by_key(|x| x.limit - x.used);
        Ok(out)
    }

    fn warnings(
        &self,
        conn: &Connection,
        r: &CallRow,
        uses: &Amounts,
        add: Option<&Amounts>,
        ts: i64,
        events: &mut Vec<CallBudgetEvent>,
    ) -> Result<(), BudgetError> {
        for l in self.limits(conn, r, uses)? {
            let (used, _) = self.usage(conn, &l, ts)?;
            let n = add.map_or(0, |a| a.get(l.metric));
            if used + n >= l.soft {
                let key = self.notice_key(conn, &l, ts)?;
                let first = conn.execute(
                    "INSERT OR IGNORE INTO budget_call_notice VALUES (?,?,?,?,?)",
                    params![
                        l.scope.as_str(),
                        l.id,
                        l.period.as_str(),
                        l.metric.as_str(),
                        key
                    ],
                )?;
                if first > 0 {
                    events.push(CallBudgetEvent::Warn {
                        scope: l.scope,
                        id: l.id,
                        metric: l.metric,
                        used: used + n,
                        limit: l.soft,
                    });
                }
            }
        }
        Ok(())
    }

    /// `setLimit`.
    pub fn set_limit(&self, l: &CallLimit) -> Result<(), BudgetError> {
        if l.scope == CallScope::Global {
            if !l.id.is_empty() {
                return Err(input("invalid limit id"));
            }
        } else {
            call_id(&l.id)?;
        }
        safe_count(l.hard)?;
        let soft = safe_count(l.soft.unwrap_or(((l.hard as f64) * 0.8).floor() as i64))?;
        if soft > l.hard {
            return Err(input("soft exceeds hard"));
        }
        self.lock().write_with(|tx| {
            tx.execute(
                "INSERT INTO budget_call_limit VALUES (?,?,?,?,?,?) ON CONFLICT(scope,id,period,metric) DO UPDATE SET hard=excluded.hard, soft=excluded.soft",
                params![l.scope.as_str(), l.id, l.period.as_str(), l.metric.as_str(), l.hard, soft],
            )?;
            Ok::<_, BudgetError>(())
        })
    }

    /// `clearLimit`.
    pub fn clear_limit(
        &self,
        scope: CallScope,
        id: &str,
        period: CallPeriod,
        metric: Metric,
    ) -> Result<(), BudgetError> {
        self.lock().conn().execute(
            "DELETE FROM budget_call_limit WHERE scope=? AND id=? AND period=? AND metric=?",
            params![scope.as_str(), id, period.as_str(), metric.as_str()],
        )?;
        Ok(())
    }

    /// `checkBeforeCall`: admission and reservation in one step, or a refusal.
    pub fn check_before_call(
        &self,
        request: &CallRequest<'_>,
    ) -> Result<CallDecision, BudgetError> {
        for field in [
            request.principal,
            request.agent,
            request.project,
            request.model,
        ] {
            call_id(field)?;
        }
        for field in [request.provider, request.turn, request.session]
            .into_iter()
            .flatten()
        {
            call_id(field)?;
        }
        let ts = safe_count(self.clock.now())?;
        let tokens = safe_count(
            safe_count(request.estimated_input_tokens)? + safe_count(request.max_output_tokens)?,
        )?;
        let images = safe_count(request.images.unwrap_or(0))?;
        let video_seconds = safe_count(request.video_seconds.unwrap_or(0))?;
        let r = CallRow {
            id: self.ids.next_id(),
            principal: request.principal.into(),
            project: request.project.into(),
            agent: request.agent.into(),
            model: request.model.into(),
            provider: request.provider.unwrap_or("").into(),
            turn: request.turn.unwrap_or("").into(),
            session: request.session.unwrap_or("").into(),
            ts,
            tokens,
            images,
            video_seconds,
        };
        let want = r.amounts();
        let mut events = Vec::new();
        let decision = self.lock().write_with(|tx| {
            if let Some(refusal) = self.breaches(tx, &r, &want, Some(&want), ts)?.into_iter().next() {
                events.push(CallBudgetEvent::Refuse(refusal.clone()));
                return Ok::<_, BudgetError>(CallDecision::Refuse(refusal));
            }
            self.warnings(tx, &r, &want, Some(&want), ts, &mut events)?;
            tx.execute(
                "INSERT INTO budget_call (id,principal,project,agent,model,provider,turn,session,ts,tokens,cost,state,images,video_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)",
                params![r.id, r.principal, r.project, r.agent, r.model, r.provider, r.turn, r.session, r.ts, r.tokens, "reserved", r.images, r.video_seconds],
            )?;
            events.push(CallBudgetEvent::Reserve { reservation_id: r.id.clone(), tokens, media: want.media() });
            Ok(CallDecision::Allow(CallAllowance { reservation_id: r.id.clone(), estimated_tokens: tokens, media: want.media() }))
        })?;
        self.emit(&events);
        Ok(decision)
    }

    /// `settle`: records the actual usage once. A second settlement of the same reservation records nothing.
    pub fn settle(
        &self,
        reservation_id: &str,
        actual: &ActualCallUsage,
    ) -> Result<Settlement, BudgetError> {
        call_id(reservation_id)?;
        let input_tokens = safe_count(actual.input_tokens)?;
        let output_tokens = safe_count(actual.output_tokens)?;
        let cache_read = safe_count(actual.cache_read_tokens.unwrap_or(0))?;
        let cache_write = safe_count(actual.cache_write_tokens.unwrap_or(0))?;
        let images = safe_count(actual.images.unwrap_or(0))?;
        let video_seconds = safe_count(actual.video_seconds.unwrap_or(0))?;
        let mut events = Vec::new();
        let result = self.lock().write_with(|tx| {
            let r: Option<(CallRow, String)> = tx
                .query_row(
                    &format!("SELECT {CALL_COLUMNS}, state FROM budget_call WHERE id=?"),
                    [reservation_id],
                    |x| Ok((call_row(x)?, x.get(12)?)),
                )
                .optional()?;
            let Some((r, state)) = r else {
                return Err(input("unknown reservation"));
            };
            if state == "settled" {
                return Ok(Settlement { recorded: false, overages: Vec::new() });
            }
            let tokens = safe_count(input_tokens + output_tokens)?;
            // Which limits concern this call: what it reserved or what it used, so a unit limit sees a delivery it did not
            // reserve for.
            let reserved = r.amounts();
            let uses = Amounts {
                tokens,
                images: reserved.images.max(images),
                video_seconds: reserved.video_seconds.max(video_seconds),
            };
            tx.execute(
                "UPDATE budget_call SET state='settled',tokens=?,images=?,video_seconds=? WHERE id=?",
                params![tokens, images, video_seconds, r.id],
            )?;
            tx.execute(
                "INSERT INTO usage_event (ts,agent,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,price_version,request_id,images,video_seconds) VALUES (?,?,?,?,?,?,?,?,'',?,?,?)",
                params![r.ts, r.agent, r.provider, r.model, input_tokens, output_tokens, cache_read, cache_write, format!("{LEDGER_PREFIX}{}", r.id), images, video_seconds],
            )?;
            self.warnings(tx, &r, &uses, None, r.ts, &mut events)?;
            Ok(Settlement { recorded: true, overages: self.breaches(tx, &r, &uses, None, r.ts)? })
        })?;
        self.emit(&events);
        if result.recorded {
            self.emit(&[CallBudgetEvent::Settle {
                reservation_id: reservation_id.to_owned(),
                tokens: input_tokens + output_tokens,
                overages: result.overages.clone(),
                media: MediaAmounts {
                    images,
                    video_seconds,
                },
            }]);
        }
        Ok(result)
    }

    /// `releaseUnused`: only a caller that knows nothing billable was sent (no provider request, or one refused before any
    /// output) may release.
    pub fn release_unused(&self, reservation_id: &str) -> Result<(), BudgetError> {
        call_id(reservation_id)?;
        let n = self.lock().write_with(|tx| {
            Ok::<_, BudgetError>(tx.execute(
                "DELETE FROM budget_call WHERE id=? AND state='reserved'",
                [reservation_id],
            )?)
        })?;
        if n > 0 {
            self.emit(&[CallBudgetEvent::Release {
                reservation_id: reservation_id.to_owned(),
            }]);
        }
        Ok(())
    }

    /// `reservation`: a read-only view of one reservation, or `None` once released or expired.
    pub fn reservation(
        &self,
        reservation_id: &str,
    ) -> Result<Option<ReservationView>, BudgetError> {
        call_id(reservation_id)?;
        let cutoff = self.expired_before();
        let row: Option<(String, i64, i64, i64, i64)> = self
            .lock()
            .conn()
            .query_row(
                "SELECT state, tokens, images, video_seconds, ts FROM budget_call WHERE id=?",
                [reservation_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        Ok(row.map(
            |(state, tokens, images, video_seconds, ts)| ReservationView {
                settled: state == "settled",
                tokens,
                media: MediaAmounts {
                    images,
                    video_seconds,
                },
                expired: state == "reserved" && ts < cutoff,
            },
        ))
    }

    /// `pendingReservations`: reservations still pending (live) and expired but not yet reconciled.
    pub fn pending_reservations(&self) -> Result<(i64, i64), BudgetError> {
        let cutoff = self.expired_before();
        Ok(self.lock().conn().query_row(
            "SELECT COALESCE(SUM(ts >= ?),0) AS live, COALESCE(SUM(ts < ?),0) AS expired FROM budget_call WHERE state='reserved'",
            params![cutoff, cutoff],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }

    /// `run`: admission, the call, settlement. On a failure without authoritative usage the reservation stays until it is
    /// reconciled by [`CallBudget::settle`], which the error's reservation id allows.
    pub fn run<T, E>(
        &self,
        request: &CallRequest<'_>,
        invoke: impl FnOnce() -> Result<(T, ActualCallUsage), E>,
    ) -> Result<T, RunError<E>> {
        let allowance = match self.check_before_call(request).map_err(RunError::Budget)? {
            CallDecision::Refuse(r) => return Err(RunError::Refused(r)),
            CallDecision::Allow(a) => a,
        };
        let pending = |cause| RunError::UsagePending {
            reservation_id: allowance.reservation_id.clone(),
            cause,
        };
        match invoke() {
            Err(e) => Err(pending(RunCause::Call(e))),
            Ok((value, usage)) => match self.settle(&allowance.reservation_id, &usage) {
                Ok(_) => Ok(value),
                Err(e) => Err(pending(RunCause::Settle(e))),
            },
        }
    }
}
