//! `metrics/metrics.ts`: the harness's metric set (D3). Everything here is a number or a member of a closed enumeration:
//! no agent name, user, path, host, model or error text is ever a label (see `registry.rs` for how that is enforced).
//!
//! Seams (P4-11 ruling 2): the core's RPC method list ([`MetricsOptions::methods`], `METHODS_BY_SERVER.core`) and the
//! process memory reading are inputs; the per-turn aggregate of `session/turn-telemetry.ts` is ported here as far as the
//! metrics need it ([`TurnTelemetryAggregate`]), so the flip PR can swap it for the session module's own.
use super::registry::{
    spec, Counter, CounterOptions, Histogram, LabelSpec, Registry, RegistryError,
};
use serde_json::{Map, Value};
use std::sync::{Arc, Mutex, PoisonError};

/// Result classes of an RPC call: `ok` or the error code folded into a stable class.
const RESULT_BY_CODE: &[(&str, &str)] = &[
    ("ok", "ok"),
    ("E_INVALID_PARAMS", "invalid_params"),
    ("E_UNAUTHORIZED", "unauthorized"),
    ("E_DENIED", "unauthorized"),
    ("E_APPROVAL_REQUIRED", "unauthorized"),
    ("E_NOT_FOUND", "not_found"),
    ("E_AGENT_UNKNOWN", "not_found"),
    ("E_MODULE_UNKNOWN", "not_found"),
    ("E_NOT_AVAILABLE", "unavailable"),
    ("E_CORE_UNAVAILABLE", "unavailable"),
    ("E_LOCKED", "unavailable"),
    ("E_INTERNAL", "internal"),
    ("E_STORAGE", "internal"),
    ("E_CONFIG_INVALID", "internal"),
];
/// The distinct result classes in order of first appearance.
const RESULTS: &[&str] = &[
    "ok",
    "invalid_params",
    "unauthorized",
    "not_found",
    "unavailable",
    "internal",
];

/// Series bound of `plur1bus_rpc_calls_total` for `method_count` core methods: every method plus the `other` fold, times
/// every result class plus `other`. Derived from the schema, so adding RPC methods never trips the per-metric cap.
pub fn rpc_calls_max_series(method_count: usize) -> u64 {
    (u64::try_from(method_count).unwrap_or(u64::MAX) + 1) * (RESULTS.len() as u64 + 1)
}

/// The most series one process can expose: a regression guard for the label enumerations (the RPC bound plus 1000).
pub fn max_total_series(method_count: usize) -> u64 {
    rpc_calls_max_series(method_count) + 1000
}

/// Provider enumeration. A new provider adapter adds its id here, nowhere else.
pub const PROVIDERS: &[&str] = &[
    "openai",
    "anthropic",
    "google",
    "openrouter",
    "ollama",
    "openai_compatible",
];
/// Provider failure kinds.
pub const PROVIDER_ERROR_KINDS: &[&str] = &[
    "auth",
    "rate_limit",
    "timeout",
    "server",
    "invalid_request",
    "network",
];
/// Turn outcomes.
pub const TURN_OUTCOMES: &[&str] = &["ok", "error", "aborted"];
/// `INBOX_KINDS` of `inbox/store.ts`.
pub const INBOX_KINDS: &[&str] = &[
    "breakglass",
    "approval",
    "job-failed",
    "update",
    "media-index",
    "pairing",
    "channel",
    "system",
];
/// `TOOL_CHOICE_STATUSES` of `session/turn-telemetry.ts`.
pub const TOOL_CHOICE_STATUSES: &[&str] = &["auto", "required", "named", "unsupported"];
/// `TOOL_NEED_REASONS` of `session/turn-telemetry.ts`.
pub const TOOL_NEED_REASONS: &[&str] = &[
    "triage",
    "url",
    "path",
    "time",
    "attachment",
    "skill",
    "mode",
];
/// `TURN_END_REASONS` of `session/turn-telemetry.ts`.
pub const TURN_END_REASONS: &[&str] = &[
    "completed",
    "tool-error",
    "provider-error",
    "approval-required",
    "local-only",
    "budget",
    "aborted",
    "cancelled",
    "error-limit",
    "round-limit",
    "command",
    "failed",
];
/// The aggregate keeps at most this many recent triage durations.
pub const TRIAGE_SAMPLE_LIMIT: usize = 1024;
const TURN_BUCKETS: &[f64] = &[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0];
const TRIAGE_BUCKETS: &[f64] = &[0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1.0, 2.5, 5.0];

/// A count read at scrape time.
pub type CountFn = Arc<dyn Fn() -> f64 + Send + Sync>;

/// `process.memoryUsage()`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MemoryUsage {
    /// Resident set size.
    pub rss: f64,
    /// Heap reserved (V8 in TypeScript).
    pub heap_total: f64,
    /// Heap in use (V8 in TypeScript).
    pub heap_used: f64,
    /// Memory of native objects bound to the runtime's objects.
    pub external: f64,
    /// Memory of buffers.
    pub array_buffers: f64,
}

/// Core readiness and a few counts, read at scrape time.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HealthSnapshot {
    /// The core is ready and the memory engine reports no degradation.
    pub ready: bool,
    /// Capture journal entries not yet stored.
    pub journal_backlog: f64,
    /// Configured agents.
    pub agents: f64,
    /// Seconds since the core started.
    pub uptime_seconds: f64,
}

/// What [`Metrics::new`] takes.
#[derive(Clone)]
pub struct MetricsOptions {
    /// `METHODS_BY_SERVER.core`: the RPC methods the core serves (the closed enumeration of the `method` label).
    pub methods: Vec<String>,
    /// Open RPC connections now.
    pub connections: CountFn,
    /// Process memory (a seam for tests; the flip PR passes the platform reading).
    pub memory_usage: Arc<dyn Fn() -> MemoryUsage + Send + Sync>,
    /// Core readiness and a few counts (default: not ready, zeros).
    pub health: Option<Arc<dyn Fn() -> HealthSnapshot + Send + Sync>>,
}

/// One final per-turn tool/skill observation (`TurnTelemetry`). The closed enumerations are strings so that an unknown
/// value is folded, as in TypeScript.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnTelemetry {
    /// Model rounds.
    pub rounds: f64,
    /// Real tool calls (excludes the three meta-tools).
    pub tool_calls: f64,
    /// `metaCalls.search`.
    pub meta_search: f64,
    /// `metaCalls.skillLoad`.
    pub meta_skill_load: f64,
    /// `metaCalls.skillRead`.
    pub meta_skill_read: f64,
    /// `skills.injected`.
    pub skills_injected: f64,
    /// `skills.loaded`.
    pub skills_loaded: f64,
    /// `toolChoice.status`.
    pub tool_choice_status: String,
    /// `toolChoice.forced`.
    pub tool_choice_forced: bool,
    /// `toolNeed.detected`.
    pub tool_need_detected: bool,
    /// `toolNeed.reasons`.
    pub tool_need_reasons: Vec<String>,
    /// Tool errors returned to the model.
    pub errors_returned: f64,
    /// The termination reason.
    pub end_reason: String,
    /// `None` means no triage measurement exists, rather than a measured zero.
    pub triage_duration_ms: Option<f64>,
}

impl Default for TurnTelemetry {
    /// `createTurnTelemetry()`.
    fn default() -> Self {
        TurnTelemetry {
            rounds: 0.0,
            tool_calls: 0.0,
            meta_search: 0.0,
            meta_skill_load: 0.0,
            meta_skill_read: 0.0,
            skills_injected: 0.0,
            skills_loaded: 0.0,
            tool_choice_status: "auto".to_owned(),
            tool_choice_forced: false,
            tool_need_detected: false,
            tool_need_reasons: Vec::new(),
            errors_returned: 0.0,
            end_reason: "completed".to_owned(),
            triage_duration_ms: None,
        }
    }
}

/// `TurnTelemetrySummary`: lifetime counters plus nearest-rank quantiles over the recent triage samples.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnTelemetrySummary {
    /// Turns observed.
    pub turns: f64,
    /// Rounds.
    pub rounds: f64,
    /// Real tool calls.
    pub tool_calls: f64,
    /// `metaCalls`: search, skill load, skill read.
    pub meta_calls: [f64; 3],
    /// `skills`: injected, loaded.
    pub skills: [f64; 2],
    /// Tool errors returned.
    pub errors_returned: f64,
    /// Turns with a detected tool need.
    pub tool_need_turns: f64,
    /// Turns that forced tool choice.
    pub forced_turns: f64,
    /// Turns that needed a tool and made no real call.
    pub without_needed_tool: f64,
    /// Turns whose tool choice was unsupported.
    pub tool_choice_unsupported: f64,
    /// Count per termination reason, in [`TURN_END_REASONS`] order.
    pub end_reasons: Vec<f64>,
    /// Retained triage samples.
    pub triage_count: usize,
    /// Median triage duration.
    pub triage_p50_ms: Option<f64>,
    /// 95th percentile triage duration.
    pub triage_p95_ms: Option<f64>,
}

fn number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.0e15 {
        #[allow(clippy::cast_possible_truncation, reason = "integral and below 2^53")]
        return Value::from(n as i64);
    }
    serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
}

impl TurnTelemetrySummary {
    /// The summary as the TypeScript object, JSON-encoded (keys sorted).
    pub fn to_json(&self) -> Value {
        let mut end = Map::new();
        for (reason, n) in TURN_END_REASONS.iter().zip(&self.end_reasons) {
            end.insert((*reason).to_owned(), number(*n));
        }
        let mut triage = Map::new();
        triage.insert("count".into(), Value::from(self.triage_count));
        triage.insert(
            "p50Ms".into(),
            self.triage_p50_ms.map_or(Value::Null, number),
        );
        triage.insert(
            "p95Ms".into(),
            self.triage_p95_ms.map_or(Value::Null, number),
        );
        let mut meta = Map::new();
        meta.insert("search".into(), number(self.meta_calls[0]));
        meta.insert("skillLoad".into(), number(self.meta_calls[1]));
        meta.insert("skillRead".into(), number(self.meta_calls[2]));
        let mut skills = Map::new();
        skills.insert("injected".into(), number(self.skills[0]));
        skills.insert("loaded".into(), number(self.skills[1]));
        let mut out = Map::new();
        out.insert("turns".into(), number(self.turns));
        out.insert("rounds".into(), number(self.rounds));
        out.insert("toolCalls".into(), number(self.tool_calls));
        out.insert("metaCalls".into(), Value::Object(meta));
        out.insert("skills".into(), Value::Object(skills));
        out.insert("errorsReturned".into(), number(self.errors_returned));
        out.insert("toolNeedTurns".into(), number(self.tool_need_turns));
        out.insert("forcedTurns".into(), number(self.forced_turns));
        out.insert("withoutNeededTool".into(), number(self.without_needed_tool));
        out.insert(
            "toolChoiceUnsupported".into(),
            number(self.tool_choice_unsupported),
        );
        out.insert("endReasons".into(), Value::Object(end));
        out.insert("triage".into(), Value::Object(triage));
        Value::Object(out)
    }
}

/// `createTurnTelemetryAggregate()`: process-local, bounded, identifier-free aggregation.
#[derive(Debug)]
pub struct TurnTelemetryAggregate {
    total: TurnTelemetrySummary,
    samples: Vec<f64>,
    next_sample: usize,
}

impl Default for TurnTelemetryAggregate {
    fn default() -> Self {
        TurnTelemetryAggregate {
            total: TurnTelemetrySummary {
                turns: 0.0,
                rounds: 0.0,
                tool_calls: 0.0,
                meta_calls: [0.0; 3],
                skills: [0.0; 2],
                errors_returned: 0.0,
                tool_need_turns: 0.0,
                forced_turns: 0.0,
                without_needed_tool: 0.0,
                tool_choice_unsupported: 0.0,
                end_reasons: vec![0.0; TURN_END_REASONS.len()],
                triage_count: 0,
                triage_p50_ms: None,
                triage_p95_ms: None,
            },
            samples: Vec::new(),
            next_sample: 0,
        }
    }
}

fn count(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        0.0
    }
}

impl TurnTelemetryAggregate {
    /// `observe(telemetry)`.
    pub fn observe(&mut self, t: &TurnTelemetry) {
        let total = &mut self.total;
        total.turns += 1.0;
        total.rounds += count(t.rounds);
        total.tool_calls += count(t.tool_calls);
        total.meta_calls[0] += count(t.meta_search);
        total.meta_calls[1] += count(t.meta_skill_load);
        total.meta_calls[2] += count(t.meta_skill_read);
        total.skills[0] += count(t.skills_injected);
        total.skills[1] += count(t.skills_loaded);
        total.errors_returned += count(t.errors_returned);
        if t.tool_need_detected {
            total.tool_need_turns += 1.0;
        }
        if t.tool_need_detected && t.tool_calls == 0.0 {
            total.without_needed_tool += 1.0;
        }
        if t.tool_choice_forced {
            total.forced_turns += 1.0;
        }
        if t.tool_choice_status == "unsupported" {
            total.tool_choice_unsupported += 1.0;
        }
        let at = TURN_END_REASONS
            .iter()
            .position(|r| *r == t.end_reason)
            .unwrap_or(TURN_END_REASONS.len() - 1); // "failed"
        total.end_reasons[at] += 1.0;
        if let Some(ms) = t.triage_duration_ms.filter(|m| m.is_finite() && *m >= 0.0) {
            if self.next_sample < self.samples.len() {
                self.samples[self.next_sample] = ms;
            } else {
                self.samples.push(ms);
            }
            self.next_sample = (self.next_sample + 1) % TRIAGE_SAMPLE_LIMIT;
        }
    }

    /// `snapshot()`: an independent copy with the quantiles filled in.
    pub fn snapshot(&self) -> TurnTelemetrySummary {
        let mut sorted = self.samples.clone();
        sorted.sort_by(f64::total_cmp);
        let rank = |quantile: f64| -> Option<f64> {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                clippy::cast_precision_loss,
                reason = "the rank is a small non-negative integer"
            )]
            let at = (sorted.len() as f64 * quantile).ceil() as usize;
            at.checked_sub(1).and_then(|i| sorted.get(i)).copied()
        };
        TurnTelemetrySummary {
            triage_count: sorted.len(),
            triage_p50_ms: rank(0.5),
            triage_p95_ms: rank(0.95),
            ..self.total.clone()
        }
    }
}

/// One learning finding of [`Metrics::learn_run`].
#[derive(Clone, Debug)]
pub struct LearnFinding {
    /// `desiredTier`.
    pub desired_tier: String,
    /// `status`.
    pub status: String,
}

fn declare(
    r: &Registry,
    name: &str,
    help: &str,
    labels: &LabelSpec,
) -> Result<Counter, RegistryError> {
    r.counter(name, help, labels, CounterOptions::default())
}

/// The harness's metrics: record with the methods, `render` the exposition.
pub struct Metrics {
    registry: Registry,
    learning_runs: Counter,
    learning_findings: Counter,
    learning_tokens: Counter,
    rpc: Counter,
    turns: Histogram,
    provider_errors: Counter,
    inbox: Counter,
    aggregate: Mutex<TurnTelemetryAggregate>,
    rounds: Counter,
    tool_calls: Counter,
    skills: Counter,
    tool_choice: Counter,
    forced: Counter,
    tool_need: Counter,
    unused: Counter,
    tool_errors: Counter,
    end: Counter,
    triage: Histogram,
}

impl Metrics {
    /// `createMetrics(options)`.
    pub fn new(o: &MetricsOptions) -> Result<Metrics, RegistryError> {
        let r = Registry::new();
        let learning_runs = declare(
            &r,
            "plur1bus_learn_runs_total",
            "Learning attempts by outcome and fixed reason.",
            &spec(&[
                ("outcome", &["completed", "skipped", "failed", "deferred"]),
                (
                    "reason",
                    &[
                        "none",
                        "transcript-cap",
                        "disabled",
                        "no-sessions",
                        "budget",
                        "breaker-open",
                        "no-model",
                        "local-only",
                        "source-unavailable",
                        "invalid-output",
                        "provider-failed",
                        "rights-changed",
                        "interrupted",
                    ],
                ),
            ]),
        )?;
        let learning_findings = declare(
            &r,
            "plur1bus_learn_findings_total",
            "Published learning findings and human decision transitions.",
            &spec(&[
                ("tier", &["A", "B", "C"]),
                (
                    "status",
                    &["pending", "accepted", "rejected", "waiting-h3", "withdrawn"],
                ),
            ]),
        )?;
        let learning_tokens = declare(
            &r,
            "plur1bus_learn_tokens_total",
            "Measured learning input and output tokens; no estimates.",
            &spec(&[]),
        )?;
        let health: Arc<dyn Fn() -> HealthSnapshot + Send + Sync> = o
            .health
            .clone()
            .unwrap_or_else(|| Arc::new(HealthSnapshot::default));

        let methods: Vec<String> = o.methods.clone();
        let rpc = r.counter(
            "plur1bus_rpc_calls_total",
            "RPC calls handled by the core, by method and result class.",
            &vec![
                ("method".to_owned(), methods.clone()),
                (
                    "result".to_owned(),
                    RESULTS.iter().map(|s| (*s).to_owned()).collect(),
                ),
            ],
            CounterOptions {
                max_series: Some(rpc_calls_max_series(methods.len())),
            },
        )?;
        let turns = r.histogram(
            "plur1bus_turn_duration_seconds",
            "Duration of chat turns, by outcome.",
            &spec(&[("outcome", TURN_OUTCOMES)]),
            TURN_BUCKETS,
        )?;
        let provider_errors = declare(
            &r,
            "plur1bus_provider_errors_total",
            "Failed provider calls, by provider and failure kind.",
            &spec(&[("provider", PROVIDERS), ("kind", PROVIDER_ERROR_KINDS)]),
        )?;
        let inbox = declare(
            &r,
            "plur1bus_inbox_entries_total",
            "Inbox entries created, by kind.",
            &spec(&[("kind", INBOX_KINDS)]),
        )?;
        let rounds = declare(
            &r,
            "plur1bus_turn_rounds_total",
            "Model rounds in finished turns.",
            &spec(&[]),
        )?;
        let tool_calls = declare(
            &r,
            "plur1bus_turn_tool_calls_total",
            "Real and meta tool calls in finished turns.",
            &spec(&[("kind", &["real", "search", "skill_load", "skill_read"])]),
        )?;
        let skills = declare(
            &r,
            "plur1bus_turn_skills_total",
            "Injected and loaded skills in finished turns.",
            &spec(&[("kind", &["injected", "loaded"])]),
        )?;
        let tool_choice = declare(
            &r,
            "plur1bus_turn_tool_choice_total",
            "Tool-choice status observed in finished turns.",
            &spec(&[("status", TOOL_CHOICE_STATUSES)]),
        )?;
        let forced = declare(
            &r,
            "plur1bus_turn_tool_choice_forced_total",
            "Turns that forced tool choice.",
            &spec(&[]),
        )?;
        let mut need_reasons: Vec<&str> = TOOL_NEED_REASONS.to_vec();
        need_reasons.push("none");
        let tool_need = declare(
            &r,
            "plur1bus_turn_tool_need_total",
            "Recognized tool need, by bounded reason.",
            &spec(&[("reason", need_reasons.as_slice())]),
        )?;
        let unused = declare(
            &r,
            "plur1bus_turn_needed_tool_unused_total",
            "Turns needing a tool without a real tool call.",
            &spec(&[]),
        )?;
        let tool_errors = declare(
            &r,
            "plur1bus_turn_tool_errors_returned_total",
            "Tool errors returned to the model.",
            &spec(&[]),
        )?;
        let end = declare(
            &r,
            "plur1bus_turn_end_total",
            "Finished turns by termination reason.",
            &spec(&[("reason", TURN_END_REASONS)]),
        )?;
        let triage = r.histogram(
            "plur1bus_turn_triage_duration_seconds",
            "Triage duration in finished turns.",
            &spec(&[]),
            TRIAGE_BUCKETS,
        )?;
        turns.init_all();
        provider_errors.init_all();
        inbox.init_all();
        for metric in [
            &rounds,
            &tool_calls,
            &skills,
            &tool_choice,
            &forced,
            &tool_need,
            &unused,
            &tool_errors,
            &end,
        ] {
            metric.init_all();
        }
        triage.init_all();

        let mem = o.memory_usage.clone();
        let gauge = |name: &str, help: &str, f: Arc<dyn Fn() -> f64 + Send + Sync>| {
            r.gauge_fn(name, help, move || f())
        };
        let m = mem.clone();
        gauge(
            "plur1bus_process_resident_memory_bytes",
            "Resident set size of the core process.",
            Arc::new(move || m().rss),
        )?;
        let m = mem.clone();
        gauge(
            "plur1bus_process_heap_used_bytes",
            "V8 heap in use.",
            Arc::new(move || m().heap_used),
        )?;
        let m = mem.clone();
        gauge(
            "plur1bus_process_heap_total_bytes",
            "V8 heap reserved.",
            Arc::new(move || m().heap_total),
        )?;
        let m = mem.clone();
        gauge(
            "plur1bus_process_external_memory_bytes",
            "Memory of C++ objects bound to JavaScript objects.",
            Arc::new(move || m().external),
        )?;
        let m = mem;
        gauge(
            "plur1bus_process_array_buffers_bytes",
            "Memory of ArrayBuffers and Buffers.",
            Arc::new(move || m().array_buffers),
        )?;
        let connections = o.connections.clone();
        gauge(
            "plur1bus_rpc_connections_open",
            "Open RPC connections.",
            Arc::new(move || connections()),
        )?;
        let h = health.clone();
        gauge(
            "plur1bus_engine_ready",
            "1 when the core is ready and the memory engine reports no degradation, else 0.",
            Arc::new(move || if h().ready { 1.0 } else { 0.0 }),
        )?;
        let h = health.clone();
        gauge(
            "plur1bus_journal_backlog_entries",
            "Capture journal entries not yet stored.",
            Arc::new(move || h().journal_backlog),
        )?;
        let h = health.clone();
        gauge(
            "plur1bus_agents",
            "Number of configured agents (a count, never names).",
            Arc::new(move || h().agents),
        )?;
        let h = health;
        gauge(
            "plur1bus_core_uptime_seconds",
            "Seconds since the core started.",
            Arc::new(move || h().uptime_seconds),
        )?;

        Ok(Metrics {
            registry: r,
            learning_runs,
            learning_findings,
            learning_tokens,
            rpc,
            turns,
            provider_errors,
            inbox,
            aggregate: Mutex::new(TurnTelemetryAggregate::default()),
            rounds,
            tool_calls,
            skills,
            tool_choice,
            forced,
            tool_need,
            unused,
            tool_errors,
            end,
            triage,
        })
    }

    /// `learnRun(run, findings, tokens)`: a missing outcome is `other`, a missing reason `none`.
    pub fn learn_run(
        &self,
        outcome: Option<&str>,
        reason: Option<&str>,
        findings: &[LearnFinding],
        tokens: f64,
    ) {
        self.learning_runs.inc(&[
            ("outcome", outcome.unwrap_or("other")),
            ("reason", reason.unwrap_or("none")),
        ]);
        for f in findings {
            self.learning_findings.inc(&[
                ("tier", f.desired_tier.as_str()),
                ("status", f.status.as_str()),
            ]);
        }
        self.learning_tokens.inc_by(&[], tokens);
    }

    /// `learnFinding(tier, status)`.
    pub fn learn_finding(&self, tier: &str, status: &str) {
        self.learning_findings
            .inc(&[("tier", tier), ("status", status)]);
    }

    /// `inboxPublished(kind)`: only the closed inbox kinds are counted.
    pub fn inbox_published(&self, kind: &str) {
        if INBOX_KINDS.contains(&kind) {
            self.inbox.inc(&[("kind", kind)]);
        }
    }

    /// `rpcCall(method, result)`: one finished RPC call; `result` is `ok` or the RPC error code, both folded into
    /// enumerations.
    pub fn rpc_call(&self, method: &str, result: &str) {
        let class = RESULT_BY_CODE
            .iter()
            .find(|(code, _)| *code == result)
            .map_or("other", |(_, class)| class);
        self.rpc.inc(&[("method", method), ("result", class)]);
    }

    /// `turn(seconds, outcome)`: an unknown outcome is `error`.
    pub fn turn(&self, seconds: f64, outcome: &str) {
        let outcome = if TURN_OUTCOMES.contains(&outcome) {
            outcome
        } else {
            "error"
        };
        self.turns.observe(&[("outcome", outcome)], seconds);
    }

    /// `turnTelemetry(telemetry)`: one final per-turn observation.
    pub fn turn_telemetry(&self, t: &TurnTelemetry) {
        self.aggregate
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .observe(t);
        self.rounds.inc_by(&[], t.rounds);
        self.tool_calls.inc_by(&[("kind", "real")], t.tool_calls);
        self.tool_calls.inc_by(&[("kind", "search")], t.meta_search);
        self.tool_calls
            .inc_by(&[("kind", "skill_load")], t.meta_skill_load);
        self.tool_calls
            .inc_by(&[("kind", "skill_read")], t.meta_skill_read);
        self.skills
            .inc_by(&[("kind", "injected")], t.skills_injected);
        self.skills.inc_by(&[("kind", "loaded")], t.skills_loaded);
        self.tool_choice
            .inc(&[("status", t.tool_choice_status.as_str())]);
        if t.tool_choice_forced {
            self.forced.inc(&[]);
        }
        if t.tool_need_detected {
            let mut reasons: Vec<&str> = Vec::new();
            for reason in &t.tool_need_reasons {
                if !reasons.contains(&reason.as_str()) {
                    reasons.push(reason);
                }
            }
            if reasons.is_empty() {
                reasons.push("other");
            }
            for reason in reasons {
                self.tool_need.inc(&[("reason", reason)]);
            }
            if t.tool_calls == 0.0 {
                self.unused.inc(&[]);
            }
        } else {
            self.tool_need.inc(&[("reason", "none")]);
        }
        self.tool_errors.inc_by(&[], t.errors_returned);
        self.end.inc(&[("reason", t.end_reason.as_str())]);
        if let Some(ms) = t.triage_duration_ms {
            self.triage.observe(&[], ms / 1000.0);
        }
    }

    /// `turnTelemetrySummary()`: lifetime tool-use counters and bounded recent triage p50/p95.
    pub fn turn_telemetry_summary(&self) -> TurnTelemetrySummary {
        self.aggregate
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .snapshot()
    }

    /// `providerError(provider, kind)`: one failed provider call.
    pub fn provider_error(&self, provider: &str, kind: &str) {
        self.provider_errors
            .inc(&[("provider", provider), ("kind", kind)]);
    }

    /// `render()`: the exposition.
    pub fn render(&self) -> String {
        self.registry.render()
    }
}

#[cfg(test)]
mod tests {
    use super::super::registry::exposition::{family, parse, Family};
    use super::*;

    fn methods() -> Vec<String> {
        // The shape of the schema's list: dotted names, some with capitals.
        (0..150)
            .map(|i| format!("area{}.method{}", i % 17, i))
            .chain(["core.status", "memory.recall"].map(String::from))
            .collect()
    }

    fn options(methods: Vec<String>) -> MetricsOptions {
        MetricsOptions {
            methods,
            connections: Arc::new(|| 0.0),
            memory_usage: Arc::new(|| MemoryUsage {
                rss: 100.0,
                heap_total: 50.0,
                heap_used: 40.0,
                external: 7.0,
                array_buffers: 3.0,
            }),
            health: None,
        }
    }

    fn make() -> Metrics {
        Metrics::new(&options(methods())).unwrap()
    }

    fn fams(m: &Metrics) -> Vec<Family> {
        parse(&m.render()).unwrap()
    }

    #[test]
    fn counts_rpc_calls_per_known_method_and_result_class() {
        let m = make();
        m.rpc_call("memory.recall", "ok");
        m.rpc_call("memory.recall", "ok");
        m.rpc_call("memory.recall", "E_UNAUTHORIZED");
        m.rpc_call("core.status", "E_INTERNAL");
        let all = fams(&m);
        let f = family(&all, "plur1bus_rpc_calls_total");
        let v = |method: &str, result: &str| {
            f.find(|s| s.labels["method"] == method && s.labels["result"] == result)
                .map(|s| s.value)
        };
        assert_eq!(v("memory.recall", "ok"), Some(2.0));
        assert_eq!(v("memory.recall", "unauthorized"), Some(1.0));
        assert_eq!(v("core.status", "internal"), Some(1.0));
    }

    #[test]
    fn never_turns_a_caller_supplied_method_name_or_error_code_into_a_label() {
        let m = make();
        for i in 0..500 {
            m.rpc_call(&format!("agent.{i}.secret"), &format!("E_NOPE{i}"));
        }
        m.rpc_call("agent.x", "constructor");
        let all = fams(&m);
        let f = family(&all, "plur1bus_rpc_calls_total");
        assert_eq!(f.samples.len(), 1);
        assert_eq!(f.samples[0].labels["method"], "other");
        assert_eq!(f.samples[0].labels["result"], "other");
        assert_eq!(f.samples[0].value, 501.0);
    }

    #[test]
    fn knows_every_method_the_core_serves() {
        let methods = methods();
        let m = Metrics::new(&options(methods.clone())).unwrap();
        for method in &methods {
            m.rpc_call(method, "ok");
        }
        let all = fams(&m);
        let f = family(&all, "plur1bus_rpc_calls_total");
        assert!(f.find(|s| s.labels["method"] == "other").is_none());
        assert_eq!(f.samples.len(), methods.len());
    }

    #[test]
    fn observes_turn_durations_with_a_fixed_outcome_enumeration() {
        let m = make();
        m.turn(0.4, "ok");
        m.turn(70.0, "error");
        m.turn(1.0, "who-knows");
        let all = fams(&m);
        let f = family(&all, "plur1bus_turn_duration_seconds");
        assert_eq!(f.kind, "histogram");
        let count = |o: &str| {
            f.find(|s| s.name.ends_with("_count") && s.labels["outcome"] == o)
                .unwrap()
                .value
        };
        assert_eq!(
            [count("ok"), count("error"), count("aborted")],
            [1.0, 2.0, 0.0]
        );
    }

    #[test]
    fn counts_provider_errors_under_fixed_enumerations_all_series_present_from_the_start() {
        let m = make();
        let before = fams(&m);
        let before = family(&before, "plur1bus_provider_errors_total");
        assert!(!before.samples.is_empty() && before.samples.iter().all(|s| s.value == 0.0));
        m.provider_error("anthropic", "rate_limit");
        m.provider_error("my-private-endpoint.example", "weird");
        let after = fams(&m);
        let f = family(&after, "plur1bus_provider_errors_total");
        assert_eq!(f.samples.len(), before.samples.len());
        let get = |p: &str, k: &str| {
            f.find(|s| s.labels["provider"] == p && s.labels["kind"] == k)
                .unwrap()
                .value
        };
        assert_eq!(get("anthropic", "rate_limit"), 1.0);
        assert_eq!(get("other", "other"), 1.0);
    }

    #[test]
    fn exposes_memory_connections_readiness_backlog_and_agent_count_as_numbers() {
        let mut o = options(methods());
        o.connections = Arc::new(|| 3.0);
        o.health = Some(Arc::new(|| HealthSnapshot {
            ready: true,
            journal_backlog: 4.0,
            agents: 2.0,
            uptime_seconds: 12.0,
        }));
        let all = fams(&Metrics::new(&o).unwrap());
        let val = |n: &str| family(&all, n).samples[0].value;
        assert_eq!(val("plur1bus_rpc_connections_open"), 3.0);
        assert_eq!(val("plur1bus_process_resident_memory_bytes"), 100.0);
        assert_eq!(val("plur1bus_process_heap_used_bytes"), 40.0);
        assert_eq!(val("plur1bus_process_heap_total_bytes"), 50.0);
        assert_eq!(val("plur1bus_process_external_memory_bytes"), 7.0);
        assert_eq!(val("plur1bus_process_array_buffers_bytes"), 3.0);
        assert_eq!(val("plur1bus_engine_ready"), 1.0);
        assert_eq!(val("plur1bus_journal_backlog_entries"), 4.0);
        assert_eq!(val("plur1bus_agents"), 2.0);
        assert_eq!(val("plur1bus_core_uptime_seconds"), 12.0);
        // Default health: not ready, zeros.
        let none = fams(&make());
        assert_eq!(family(&none, "plur1bus_engine_ready").samples[0].value, 0.0);
    }

    #[test]
    fn stays_below_the_global_series_bound_even_when_every_enumeration_is_exercised() {
        let methods = methods();
        let m = Metrics::new(&options(methods.clone())).unwrap();
        for method in &methods {
            for r in [
                "ok",
                "E_INVALID_PARAMS",
                "E_UNAUTHORIZED",
                "E_NOT_AVAILABLE",
                "E_INTERNAL",
                "E_NOPE",
            ] {
                m.rpc_call(method, r);
            }
        }
        let n: usize = fams(&m).iter().map(|f| f.samples.len()).sum();
        assert!(n as u64 <= max_total_series(methods.len()), "{n} series");
    }

    #[test]
    fn starts_with_the_full_method_list_even_when_its_label_space_exceeds_the_generic_cap() {
        let big: Vec<String> = (0..150).map(|i| format!("m.{i}")).collect();
        let m = Metrics::new(&options(big.clone())).unwrap(); // 151 * 7 > 1024
        m.rpc_call("m.0", "ok");
        assert!(rpc_calls_max_series(big.len()) >= (big.len() as u64 + 1) * 7);
        assert_eq!(rpc_calls_max_series(150), 151 * 7);
        assert_eq!(max_total_series(150), 151 * 7 + 1000);
    }

    #[test]
    fn carries_no_agent_user_path_or_host_label_anywhere() {
        let all = fams(&make());
        let allowed = [
            "method", "result", "outcome", "provider", "kind", "le", "reason", "status", "tier",
        ];
        for f in &all {
            for s in &f.samples {
                for l in s.labels.keys() {
                    assert!(allowed.contains(&l.as_str()), "label {l}");
                }
            }
        }
    }

    fn telemetry() -> TurnTelemetry {
        TurnTelemetry {
            rounds: 3.0,
            tool_calls: 2.0,
            meta_search: 1.0,
            meta_skill_load: 2.0,
            meta_skill_read: 3.0,
            skills_injected: 1.0,
            skills_loaded: 2.0,
            tool_choice_status: "required".into(),
            tool_choice_forced: true,
            tool_need_detected: true,
            tool_need_reasons: vec!["path".into(), "url".into()],
            errors_returned: 1.0,
            end_reason: "completed".into(),
            triage_duration_ms: Some(25.0),
        }
    }

    #[test]
    fn counts_bounded_tool_usage_need_reasons_skill_loading_and_triage_latency() {
        let m = make();
        m.turn_telemetry(&telemetry());
        let all = fams(&m);
        let value = |name: &str, key: Option<&str>| {
            family(&all, name)
                .find(|s| key.is_none_or(|k| s.labels.values().any(|v| v == k)))
                .unwrap()
                .value
        };
        assert_eq!(value("plur1bus_turn_rounds_total", None), 3.0);
        assert_eq!(value("plur1bus_turn_tool_calls_total", Some("real")), 2.0);
        assert_eq!(value("plur1bus_turn_tool_calls_total", Some("search")), 1.0);
        assert_eq!(
            value("plur1bus_turn_tool_calls_total", Some("skill_load")),
            2.0
        );
        assert_eq!(
            value("plur1bus_turn_tool_calls_total", Some("skill_read")),
            3.0
        );
        assert_eq!(value("plur1bus_turn_skills_total", Some("injected")), 1.0);
        assert_eq!(value("plur1bus_turn_skills_total", Some("loaded")), 2.0);
        assert_eq!(value("plur1bus_turn_tool_need_total", Some("path")), 1.0);
        assert_eq!(value("plur1bus_turn_tool_need_total", Some("url")), 1.0);
        assert_eq!(
            value("plur1bus_turn_tool_choice_total", Some("required")),
            1.0
        );
        assert_eq!(value("plur1bus_turn_tool_choice_forced_total", None), 1.0);
        assert_eq!(value("plur1bus_turn_tool_errors_returned_total", None), 1.0);
        assert_eq!(value("plur1bus_turn_end_total", Some("completed")), 1.0);
        let latency = family(&all, "plur1bus_turn_triage_duration_seconds");
        assert_eq!(
            latency.find(|s| s.name.ends_with("_sum")).unwrap().value,
            0.025
        );
        let s = m.turn_telemetry_summary();
        assert_eq!(
            (s.triage_count, s.triage_p50_ms, s.triage_p95_ms),
            (1, Some(25.0), Some(25.0))
        );
        assert_eq!(
            s.to_json()["triage"],
            serde_json::json!({"count": 1, "p50Ms": 25, "p95Ms": 25})
        );
    }

    #[test]
    fn folds_unknown_telemetry_strings_and_bounds_the_retained_triage_quantile_sample() {
        let m = make();
        for i in 0..1100 {
            m.turn_telemetry(&TurnTelemetry {
                rounds: 1.0,
                tool_choice_status: "private-value".into(),
                tool_need_detected: true,
                tool_need_reasons: vec!["private-value".into()],
                end_reason: "private-value".into(),
                triage_duration_ms: Some(f64::from(i)),
                ..TurnTelemetry::default()
            });
        }
        let text = m.render();
        assert!(!text.contains("private-value"));
        let s = m.turn_telemetry_summary();
        assert_eq!(s.turns, 1100.0);
        assert_eq!(s.without_needed_tool, 1100.0);
        assert_eq!(
            (s.triage_count, s.triage_p50_ms, s.triage_p95_ms),
            (1024, Some(587.0), Some(1048.0))
        );
        // An unknown end reason counts as `failed`.
        assert_eq!(s.end_reasons[TURN_END_REASONS.len() - 1], 1100.0);
    }

    #[test]
    fn a_turn_without_a_need_counts_none_and_an_empty_reason_list_counts_other() {
        let m = make();
        m.turn_telemetry(&TurnTelemetry::default());
        m.turn_telemetry(&TurnTelemetry {
            tool_need_detected: true,
            ..TurnTelemetry::default()
        });
        let all = fams(&m);
        let f = family(&all, "plur1bus_turn_tool_need_total");
        let get = |r: &str| f.find(|s| s.labels["reason"] == r).unwrap().value;
        assert_eq!((get("none"), get("other")), (1.0, 1.0));
        assert_eq!(
            family(&all, "plur1bus_turn_needed_tool_unused_total").samples[0].value,
            1.0
        );
        assert!(TurnTelemetry::default().triage_duration_ms.is_none());
    }

    #[test]
    fn learning_and_inbox_counters_fold_unknown_values() {
        let m = make();
        m.learn_run(
            Some("completed"),
            None,
            &[LearnFinding {
                desired_tier: "A".into(),
                status: "pending".into(),
            }],
            12.0,
        );
        m.learn_run(None, Some("zzz"), &[], f64::NAN);
        m.learn_finding("D", "accepted");
        m.inbox_published("approval");
        m.inbox_published("not-a-kind");
        let all = fams(&m);
        let runs = family(&all, "plur1bus_learn_runs_total");
        assert_eq!(
            runs.find(|s| s.labels["outcome"] == "completed" && s.labels["reason"] == "none")
                .unwrap()
                .value,
            1.0
        );
        assert_eq!(
            runs.find(|s| s.labels["outcome"] == "other" && s.labels["reason"] == "other")
                .unwrap()
                .value,
            1.0
        );
        assert_eq!(
            family(&all, "plur1bus_learn_tokens_total").samples[0].value,
            12.0
        );
        let findings = family(&all, "plur1bus_learn_findings_total");
        assert_eq!(
            findings
                .find(|s| s.labels["tier"] == "other")
                .unwrap()
                .value,
            1.0
        );
        let inbox = family(&all, "plur1bus_inbox_entries_total");
        assert_eq!(inbox.samples.iter().map(|s| s.value).sum::<f64>(), 1.0);
    }

    #[test]
    fn the_result_classes_are_the_distinct_values_in_order() {
        let mut seen: Vec<&str> = Vec::new();
        for (_, class) in RESULT_BY_CODE {
            if !seen.contains(class) {
                seen.push(class);
            }
        }
        assert_eq!(seen, RESULTS);
    }
}

/// Replay of the parity vectors recorded from the TypeScript registry and metric set
/// (`scripts/parity/export-metrics.ts`, `fixtures/parity/metrics/*.json`). Vectors are recorded, never edited by hand.
#[cfg(test)]
mod vectors {
    use super::*;
    use crate::metrics::registry::{Gauge, LabelSpec};
    use serde_json::{json, Value};
    use std::collections::HashMap;

    fn fixture(name: &str) -> Value {
        let path = format!(
            "{}/../../fixtures/parity/metrics/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
    }

    /// A number as the exporter writes it: a string `Number(text)` reads.
    fn num(v: &Value) -> f64 {
        match v.as_str().unwrap() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            other => other.parse::<f64>().unwrap(),
        }
    }

    fn expand(v: &Value) -> Vec<String> {
        match v {
            Value::Array(a) => a.iter().map(|s| s.as_str().unwrap().to_owned()).collect(),
            gen => {
                let prefix = gen["gen"].as_str().unwrap();
                (0..gen["count"].as_u64().unwrap())
                    .map(|i| format!("{prefix}{i}"))
                    .collect()
            }
        }
    }

    fn label_spec(v: &Value) -> LabelSpec {
        v.as_array()
            .unwrap()
            .iter()
            .map(|pair| (pair[0].as_str().unwrap().to_owned(), expand(&pair[1])))
            .collect()
    }

    fn given(v: &Value) -> Vec<(String, String)> {
        v.as_object()
            .map(|o| {
                o.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
                    .collect()
            })
            .unwrap_or_default()
    }

    enum Handle {
        C(Counter),
        G(Gauge),
        H(Histogram),
    }

    fn with_labels<R>(op: &Value, f: impl FnOnce(&[(&str, &str)]) -> R) -> R {
        let owned = given(&op["labels"]);
        let borrowed: Vec<(&str, &str)> = owned
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        f(&borrowed)
    }

    fn run_registry(ops: &[Value]) -> Vec<Value> {
        let r = Registry::new();
        let mut handles: HashMap<String, Handle> = HashMap::new();
        let mut out = Vec::new();
        for op in ops {
            let id = op["id"].as_str().unwrap_or("").to_owned();
            let name = op["name"].as_str().unwrap_or("");
            let help = op["help"].as_str().unwrap_or("");
            let mut result: Result<Option<String>, RegistryError> = Ok(None);
            match op["op"].as_str().unwrap() {
                "counter" => {
                    // A bound JSON gives as a non-integer or negative number is invalid: 0 is invalid the same way.
                    let max_series = op.get("maxSeries").map(|m| {
                        let n = m.as_f64().unwrap();
                        if n.fract() == 0.0 && n >= 0.0 {
                            n as u64
                        } else {
                            0
                        }
                    });
                    match r.counter(
                        name,
                        help,
                        &label_spec(&op["labels"]),
                        CounterOptions { max_series },
                    ) {
                        Ok(c) => {
                            handles.insert(id, Handle::C(c));
                        }
                        Err(e) => result = Err(e),
                    }
                }
                "gauge" => match r.gauge(name, help, &label_spec(&op["labels"])) {
                    Ok(g) => {
                        handles.insert(id, Handle::G(g));
                    }
                    Err(e) => result = Err(e),
                },
                "gaugeFn" => {
                    let value = op["value"].as_str().unwrap().to_owned();
                    result = r
                        .gauge_fn(name, help, move || {
                            assert_ne!(value, "throw", "boom");
                            num(&Value::String(value.clone()))
                        })
                        .map(|()| None);
                }
                "histogram" => {
                    let buckets: Vec<f64> =
                        op["buckets"].as_array().unwrap().iter().map(num).collect();
                    match r.histogram(name, help, &label_spec(&op["labels"]), &buckets) {
                        Ok(h) => {
                            handles.insert(id, Handle::H(h));
                        }
                        Err(e) => result = Err(e),
                    }
                }
                "inc" => {
                    if let Some(Handle::C(c)) = handles.get(&id) {
                        with_labels(op, |l| match op.get("by") {
                            Some(by) => c.inc_by(l, num(by)),
                            None => c.inc(l),
                        });
                    }
                }
                "set" => {
                    if let Some(Handle::G(g)) = handles.get(&id) {
                        with_labels(op, |l| g.set(l, num(&op["value"])));
                    }
                }
                "observe" => {
                    if let Some(Handle::H(h)) = handles.get(&id) {
                        with_labels(op, |l| h.observe(l, num(&op["value"])));
                    }
                }
                "initAll" => match handles.get(&id) {
                    Some(Handle::C(c)) => c.init_all(),
                    Some(Handle::H(h)) => h.init_all(),
                    _ => {}
                },
                "render" => result = Ok(Some(r.render())),
                other => panic!("unknown op {other}"),
            }
            out.push(match result {
                Ok(Some(text)) => json!({"text": text}),
                Ok(None) => json!({"ok": true}),
                Err(e) => json!({"error": e.0}),
            });
        }
        out
    }

    #[test]
    fn registry_vectors() {
        let fx = fixture("registry");
        let cases = fx["cases"].as_array().unwrap();
        assert!(cases.len() >= 25, "{} cases", cases.len());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let got = run_registry(case["ops"].as_array().unwrap());
            let want = case["results"].as_array().unwrap();
            assert_eq!(got.len(), want.len(), "{name}");
            for (i, (g, w)) in got.iter().zip(want).enumerate() {
                assert_eq!(g, w, "{name}: op {i} {}", case["ops"][i]);
            }
        }
    }

    fn telemetry(t: &Value, triage: Option<f64>) -> TurnTelemetry {
        TurnTelemetry {
            rounds: num(&t["rounds"]),
            tool_calls: num(&t["toolCalls"]),
            meta_search: num(&t["metaCalls"]["search"]),
            meta_skill_load: num(&t["metaCalls"]["skillLoad"]),
            meta_skill_read: num(&t["metaCalls"]["skillRead"]),
            skills_injected: num(&t["skills"]["injected"]),
            skills_loaded: num(&t["skills"]["loaded"]),
            tool_choice_status: t["toolChoice"]["status"].as_str().unwrap().to_owned(),
            tool_choice_forced: t["toolChoice"]["forced"].as_bool().unwrap(),
            tool_need_detected: t["toolNeed"]["detected"].as_bool().unwrap(),
            tool_need_reasons: t["toolNeed"]["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r.as_str().unwrap().to_owned())
                .collect(),
            errors_returned: num(&t["errorsReturned"]),
            end_reason: t["endReason"].as_str().unwrap().to_owned(),
            triage_duration_ms: triage.or_else(|| {
                (!t["triageDurationMs"].is_null()).then(|| num(&t["triageDurationMs"]))
            }),
        }
    }

    fn run_metrics(case: &Value, methods: &[String]) -> Vec<Value> {
        let read = |k: &str| num(&case["memory"][k]);
        let memory = MemoryUsage {
            rss: read("rss"),
            heap_total: read("heapTotal"),
            heap_used: read("heapUsed"),
            external: read("external"),
            array_buffers: read("arrayBuffers"),
        };
        let connections = num(&case["connections"]);
        let health = (!case["health"].is_null()).then(|| {
            let h = &case["health"];
            HealthSnapshot {
                ready: h["ready"].as_bool().unwrap(),
                journal_backlog: num(&h["journalBacklog"]),
                agents: num(&h["agents"]),
                uptime_seconds: num(&h["uptimeSeconds"]),
            }
        });
        let m = Metrics::new(&MetricsOptions {
            methods: methods.to_vec(),
            connections: Arc::new(move || connections),
            memory_usage: Arc::new(move || memory),
            health: health
                .map(|h| Arc::new(move || h) as Arc<dyn Fn() -> HealthSnapshot + Send + Sync>),
        })
        .unwrap();
        let mut out = Vec::new();
        for op in case["ops"].as_array().unwrap() {
            let text = |k: &str| op[k].as_str().unwrap();
            match op["op"].as_str().unwrap() {
                "rpcCall" => m.rpc_call(text("method"), text("result")),
                "rpcCalls" => {
                    let list = if text("methods") == "core" {
                        methods
                    } else {
                        &methods[..5]
                    };
                    for method in list {
                        for result in op["results"].as_array().unwrap() {
                            m.rpc_call(method, result.as_str().unwrap());
                        }
                    }
                }
                "turn" => m.turn(num(&op["seconds"]), text("outcome")),
                "providerError" => m.provider_error(text("provider"), text("kind")),
                "inboxPublished" => m.inbox_published(text("kind")),
                "learnRun" => {
                    let findings: Vec<LearnFinding> = op["findings"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|f| LearnFinding {
                            desired_tier: f["desiredTier"].as_str().unwrap().to_owned(),
                            status: f["status"].as_str().unwrap().to_owned(),
                        })
                        .collect();
                    m.learn_run(
                        op["outcome"].as_str(),
                        op["reason"].as_str(),
                        &findings,
                        num(&op["tokens"]),
                    );
                }
                "learnFinding" => m.learn_finding(text("tier"), text("status")),
                "turnTelemetry" => m.turn_telemetry(&telemetry(&op["t"], None)),
                "repeatTelemetry" => {
                    let from = op["triageFrom"].as_u64().unwrap();
                    for i in 0..op["count"].as_u64().unwrap() {
                        m.turn_telemetry(&telemetry(&op["t"], Some((from + i) as f64)));
                    }
                }
                "summary" => {
                    out.push(json!({"summary": m.turn_telemetry_summary().to_json()}));
                    continue;
                }
                "render" => {
                    out.push(json!({"text": m.render()}));
                    continue;
                }
                other => panic!("unknown op {other}"),
            }
            out.push(json!({"ok": true}));
        }
        out
    }

    #[test]
    fn metrics_vectors() {
        let fx = fixture("metrics");
        let methods: Vec<String> = fx["methods"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m.as_str().unwrap().to_owned())
            .collect();
        assert!(methods.len() > 100, "the recorded core method list");
        let cases = fx["cases"].as_array().unwrap();
        assert!(cases.len() >= 15, "{} cases", cases.len());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let got = run_metrics(case, &methods);
            let want = case["results"].as_array().unwrap();
            assert_eq!(got.len(), want.len(), "{name}");
            for (i, (g, w)) in got.iter().zip(want).enumerate() {
                assert_eq!(g, w, "{name}: op {i} {}", case["ops"][i]);
            }
        }
    }
}

/// `http.test.ts`: "no secret appears in the exposition", against the endpoint over a socket.
#[cfg(test)]
mod endpoint {
    use super::super::http::{MetricsServer, MetricsServerOptions};
    use super::super::logger_port::MetricsLog;
    use super::super::registry::exposition::{family, parse};
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    const TOKEN: &str = "tttttttttttttttttttttttttttttttttttttttttttttttt";

    struct Quiet;

    impl MetricsLog for Quiet {
        fn info(&self, _: &str, _: &Map<String, Value>) {}
        fn warn(&self, _: &str, _: &Map<String, Value>) {}
        fn error(&self, _: &str, _: &Map<String, Value>) {}
    }

    #[test]
    fn no_secret_appears_in_the_exposition() {
        let metrics = Arc::new(
            Metrics::new(&MetricsOptions {
                methods: vec!["core.status".into(), "memory.recall".into()],
                connections: Arc::new(|| 1.0),
                memory_usage: Arc::new(|| MemoryUsage {
                    rss: 1.0,
                    ..MemoryUsage::default()
                }),
                health: None,
            })
            .unwrap(),
        );
        metrics.rpc_call("core.status", "ok");
        metrics.learn_run(Some("completed"), None, &[], 5.0);
        let m = metrics.clone();
        let server = MetricsServer::new(MetricsServerOptions {
            token: TOKEN.into(),
            port: 0,
            host: None,
            render: Arc::new(move || m.render()),
            logger: Arc::new(Quiet),
            access: None,
            clock: None,
            headers_timeout: None,
        })
        .unwrap();
        let addr = server.listen().unwrap();
        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let request = format!(
            "GET /metrics HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n",
            addr.port()
        );
        stream.write_all(request.as_bytes()).unwrap();
        let mut text = String::new();
        stream.read_to_string(&mut text).unwrap();
        server.close();
        assert!(text.starts_with("HTTP/1.1 200 "), "{text}");
        let body = text.split_once("\r\n\r\n").unwrap().1;
        assert_eq!(body, metrics.render());
        assert!(!body.contains(TOKEN));
        // The public token-usage counter is not an authentication token. Only its exact static metadata is exempt; all
        // labels and values retain the secret check.
        let fams = parse(body).unwrap();
        let usage = family(&fams, "plur1bus_learn_tokens_total");
        assert_eq!(
            usage.help,
            "Measured learning input and output tokens; no estimates."
        );
        assert!(usage
            .samples
            .iter()
            .all(|s| s.labels.is_empty() && s.value.is_finite()));
        let checked = body
            .replace("plur1bus_learn_tokens_total", "learning_usage")
            .replace(
                "Measured learning input and output tokens; no estimates.",
                "Measured learning usage.",
            )
            .to_lowercase();
        for word in ["token", "secret", "password", "bearer"] {
            assert!(!checked.contains(word), "{word}");
        }
        for sep in ["", "_", "-"] {
            assert!(!checked.contains(&format!("api{sep}key")), "api{sep}key");
        }
    }
}

/// `zabbix-template.test.ts`: the Zabbix 7 template against the metric names. The template is checked structurally,
/// line by line (no YAML dependency). `zabbix-template-validation.test.ts` reads it through `yaml-lite` and stays
/// TypeScript until the import module is ported.
#[cfg(test)]
mod zabbix {
    use super::super::registry::exposition::parse;
    use super::*;
    use std::collections::HashSet;

    fn template() -> String {
        let path = format!(
            "{}/../../docs/ops/zabbix/plur1bus-template.yaml",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read_to_string(path).unwrap().replace("\r\n", "\n")
    }

    fn lines_with_indent<'a>(text: &'a str, indent: usize, rest: &str) -> Vec<&'a str> {
        let prefix = format!("{}{rest}", " ".repeat(indent));
        text.lines()
            .filter(|l| l.starts_with(&prefix) && !l[indent..].starts_with(' '))
            .collect()
    }

    fn count(text: &str, needle: &str) -> usize {
        text.matches(needle).count()
    }

    /// The `uuid: <32 hex>` values (`/uuid: ([0-9a-f]{32})\b/g`).
    fn uuids(text: &str) -> Vec<String> {
        let mut out = Vec::new();
        for (at, _) in text.match_indices("uuid: ") {
            let rest = &text[at + 6..];
            let hex: String = rest
                .chars()
                .take_while(|c| matches!(c, '0'..='9' | 'a'..='f'))
                .collect();
            let next = rest[hex.len()..].chars().next();
            if hex.len() == 32 && !next.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
                out.push(hex);
            }
        }
        out
    }

    #[test]
    fn is_a_7_0_export_with_one_template_and_valid_unique_v4_uuids() {
        let text = template();
        assert!(text.starts_with("zabbix_export:\n  version: '7.0'\n"));
        // the template group and the template
        assert_eq!(lines_with_indent(&text, 4, "- uuid:").len(), 2);
        let ids = uuids(&text);
        assert_eq!(
            ids.len(),
            count(&text, "uuid:"),
            "every uuid is 32 hex chars"
        );
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), ids.len());
        for u in &ids {
            let b = u.as_bytes();
            assert_eq!(b[12], b'4', "{u}");
            assert!(matches!(b[16], b'8' | b'9' | b'a' | b'b'), "{u}");
        }
    }

    /// Lines `master_item:` followed by an indented `key: plur1bus.metrics.get`.
    fn master_items(text: &str) -> usize {
        let lines: Vec<&str> = text.lines().collect();
        lines
            .windows(2)
            .filter(|w| {
                w[0].trim_end().trim_start() == "master_item:"
                    && w[1].starts_with(' ')
                    && w[1].trim_start().starts_with("key: plur1bus.metrics.get")
            })
            .count()
    }

    #[test]
    fn has_one_http_agent_master_item_with_a_bearer_header_from_a_macro_and_only_dependent_items_besides(
    ) {
        let text = template();
        assert_eq!(count(&text, "type: HTTP_AGENT"), 1);
        assert!(text
            .contains("url: 'http://{$PLUR1BUS.METRICS.HOST}:{$PLUR1BUS.METRICS.PORT}/metrics'"));
        assert!(text.contains("value: 'Bearer {$PLUR1BUS.METRICS.TOKEN}'"));
        let dependents = count(&text, "type: DEPENDENT");
        assert!(dependents >= 8, "{dependents}");
        assert_eq!(master_items(&text), dependents);
        assert_eq!(count(&text, "type: PROMETHEUS_PATTERN"), dependents);
    }

    #[test]
    fn has_exactly_three_triggers() {
        let text = template();
        let from = text.find("      triggers:").unwrap();
        let to = text.find("      macros:").unwrap();
        assert_eq!(lines_with_indent(&text[from..to], 8, "- uuid:").len(), 3);
    }

    #[test]
    fn the_token_macro_is_a_secret_and_ships_empty() {
        let text = template();
        let lines: Vec<&str> = text.lines().collect();
        let at = lines
            .iter()
            .position(|l| l.contains("macro: '{$PLUR1BUS.METRICS.TOKEN}'"))
            .unwrap();
        assert_eq!(lines[at + 1].trim_start(), "type: SECRET_TEXT");
        assert_eq!(lines[at + 2].trim_start(), "value: ''");
        let leaked = text.match_indices("Bearer ").any(|(i, _)| {
            text[i + 7..]
                .chars()
                .take_while(|c| matches!(c, '0'..='9' | 'a'..='f'))
                .count()
                >= 20
        });
        assert!(!leaked);
    }

    #[test]
    fn every_metric_a_preprocessing_step_reads_exists_in_the_exposition() {
        let text = template();
        let metrics = Metrics::new(&MetricsOptions {
            methods: vec!["core.status".into()],
            connections: Arc::new(|| 0.0),
            memory_usage: Arc::new(MemoryUsage::default),
            health: None,
        })
        .unwrap();
        let rendered = parse(&metrics.render()).unwrap();
        let names: HashSet<String> = rendered
            .iter()
            .flat_map(|f| {
                std::iter::once(f.name.clone()).chain(f.samples.iter().map(|s| s.name.clone()))
            })
            .collect();
        // `^ {16}- '(plur1bus_[a-z_]+)(?:\{[^']*\})?'$`
        let wanted: Vec<String> = text
            .lines()
            .filter_map(|l| {
                let inner = l.strip_prefix("                - '")?.strip_suffix('\'')?;
                let tail = inner.strip_prefix("plur1bus_")?;
                let tail_len = tail
                    .find(|c: char| !(c.is_ascii_lowercase() || c == '_'))
                    .unwrap_or(tail.len());
                let rest = &tail[tail_len..];
                let selector_ok = rest.is_empty()
                    || (rest.starts_with('{')
                        && rest.ends_with('}')
                        && !rest[..rest.len() - 1].contains('\''));
                (tail_len > 0 && selector_ok).then(|| format!("plur1bus_{}", &tail[..tail_len]))
            })
            .collect();
        assert!(wanted.len() >= 8, "{wanted:?}");
        for n in &wanted {
            assert!(names.contains(n), "{n} is not exposed");
        }
    }

    #[test]
    fn every_item_key_a_trigger_uses_is_an_item_of_the_template() {
        let text = template();
        let keys: HashSet<&str> = text
            .lines()
            .filter_map(|l| l.strip_prefix("          key: "))
            .filter(|k| !k.is_empty() && !k.contains(char::is_whitespace))
            .collect();
        assert!(keys.contains("plur1bus.metrics.get"));
        let marker = "/PLUR1BUS Harness by HTTP/";
        let mut used = 0;
        for (at, _) in text.match_indices(marker) {
            let rest = &text[at + marker.len()..];
            let key: String = rest
                .chars()
                .take_while(|c| matches!(c, 'a'..='z' | '0'..='9' | '_' | '.'))
                .collect();
            if !key.is_empty() && matches!(rest[key.len()..].chars().next(), Some(',' | ')')) {
                assert!(keys.contains(key.as_str()), "{key}");
                used += 1;
            }
        }
        assert!(used >= 1, "the triggers reference item keys");
    }
}
