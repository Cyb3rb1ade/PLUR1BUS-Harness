//! Cache telemetry (ADR-010 R8, H2-1; `packages/core/src/prompt/telemetry.ts`): one record per turn from the rendered
//! prompt and the provider's usage, the attribution of a miss to its cause, and bounded totals per (agent, model) and
//! per session. No logging backend and no I/O; it retains totals rather than a history of turn records, and it holds
//! hashes and tool names, never prompt text.
use super::builder::sticky_session_id;
use super::canonical::canonical_json;
use super::model_table::{normalize_model_id, Mechanism};
use super::types::{CacheReason, RenderedPrompt, SegmentKind, ZoneName, ZONES};
use crate::approvals::js_json::J;
use crate::js::compare_utf16;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;

/// Provider adapters translate their usage into these non-overlapping token buckets. The counts are JavaScript numbers
/// on the TypeScript side; each must be a nonnegative safe integer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProviderCacheUsage {
    /// Tokens read from the cache.
    pub cache_read: f64,
    /// Tokens written to the cache.
    pub cache_creation: f64,
    /// Uncached input only.
    pub input: f64,
}

/// The causes a miss is attributed to, in the order of the counters.
pub const CACHE_MISS_CAUSES: [&str; 7] = [
    "first-request",
    "model-changed",
    "tools-changed",
    "system-changed",
    "snapshot-changed",
    "ttl-expired",
    "provider",
];
/// Most sessions whose last stable state is retained for miss attribution.
pub const CACHE_SESSION_STATE_LIMIT: usize = 1024;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

/// Why usage was refused. Nothing is recorded then.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TelemetryError {
    /// A count is not a nonnegative safe integer.
    Counts,
    /// The three counts together leave the safe integer range.
    Total,
    /// A running total would leave the safe integer range.
    Aggregate,
}

impl fmt::Display for TelemetryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            TelemetryError::Counts => {
                "cache usage must contain nonnegative safe integer token counts"
            }
            TelemetryError::Total => "cache usage total exceeds safe integer range",
            TelemetryError::Aggregate => "cache usage aggregate exceeds safe integer range",
        })
    }
}

impl std::error::Error for TelemetryError {}

/// Totals of one (agent, model) or of one session of it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CacheUsageSummary {
    /// Turns that hit.
    pub hits: u64,
    /// Turns that missed.
    pub misses: u64,
    /// Turns whose prompt could not be cached.
    pub not_cacheable: u64,
    /// Misses per cause, in the order of [`CACHE_MISS_CAUSES`].
    pub miss_causes: [u64; 7],
    /// Tokens read from the cache.
    pub cache_read_tokens: u64,
    /// Tokens written to the cache.
    pub cache_creation_tokens: u64,
    /// Uncached input tokens.
    pub input_tokens: u64,
    /// The sum of the three.
    pub total_input_tokens: u64,
    /// Weighted token share, not the average of turn ratios.
    pub hit_ratio: f64,
    /// Turns recorded.
    pub turns: u64,
}

fn causes_j(causes: &[u64; 7]) -> J {
    let mut j = J::Obj(Vec::new());
    for (name, n) in CACHE_MISS_CAUSES.iter().zip(causes) {
        j.set(name, J::Num(*n as f64));
    }
    j
}

impl CacheUsageSummary {
    /// The summary as the TypeScript object.
    pub fn to_j(&self) -> J {
        J::obj([
            ("cacheReadTokens", J::Num(self.cache_read_tokens as f64)),
            (
                "cacheCreationTokens",
                J::Num(self.cache_creation_tokens as f64),
            ),
            ("inputTokens", J::Num(self.input_tokens as f64)),
            ("totalInputTokens", J::Num(self.total_input_tokens as f64)),
            ("turns", J::Num(self.turns as f64)),
            ("hitRatio", J::Num(self.hit_ratio)),
            ("hits", J::Num(self.hits as f64)),
            ("misses", J::Num(self.misses as f64)),
            ("notCacheable", J::Num(self.not_cacheable as f64)),
            ("missCauses", causes_j(&self.miss_causes)),
        ])
    }
}

/// What a turn was.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CacheOutcome {
    /// The provider read at least the stable prefix from its cache.
    Hit,
    /// A miss, with the index of its cause in [`CACHE_MISS_CAUSES`] and, for a tool change, how many tool names were
    /// added and removed.
    Miss {
        /// Index into [`CACHE_MISS_CAUSES`].
        cause: usize,
        /// `(added, removed)` for `tools-changed`.
        tools: Option<(usize, usize)>,
    },
    /// The prompt could not be cached at all; never counted as a miss.
    NotCacheable(&'static str),
}

/// The record of one turn.
#[derive(Clone, Debug, PartialEq)]
pub struct CacheUsageRecord {
    /// The agent.
    pub agent_id: String,
    /// The model as given.
    pub model: String,
    /// The sticky session id.
    pub session_id: String,
    /// The turn number within the session and model.
    pub turn: u64,
    /// The usage of this turn.
    pub usage: ProviderCacheUsage,
    /// The sum of the three counts.
    pub total_input_tokens: u64,
    /// The token share read from the cache this turn.
    pub hit_ratio: f64,
    /// Breakpoints of the prompt.
    pub breakpoint_count: usize,
    /// The zone hashes of the prompt.
    pub zone_hashes: [String; 5],
    /// What the turn was.
    pub outcome: CacheOutcome,
}

impl CacheUsageRecord {
    /// The record as the TypeScript object.
    pub fn to_j(&self) -> J {
        let mut zone_hashes = J::Obj(Vec::new());
        for (zone, hash) in ZONES.iter().zip(&self.zone_hashes) {
            zone_hashes.set(zone.as_str(), J::s(hash));
        }
        let mut causes = [0u64; 7];
        if let CacheOutcome::Miss { cause, .. } = &self.outcome {
            causes[*cause] = 1;
        }
        let flag = |on: bool| J::Num(if on { 1.0 } else { 0.0 });
        let mut j = J::obj([
            ("agentId", J::s(&self.agent_id)),
            ("model", J::s(&self.model)),
            ("session_id", J::s(&self.session_id)),
            ("turn", J::Num(self.turn as f64)),
            ("cacheReadTokens", J::Num(self.usage.cache_read + 0.0)),
            (
                "cacheCreationTokens",
                J::Num(self.usage.cache_creation + 0.0),
            ),
            ("inputTokens", J::Num(self.usage.input + 0.0)),
            ("totalInputTokens", J::Num(self.total_input_tokens as f64)),
            ("hitRatio", J::Num(self.hit_ratio)),
            ("breakpointCount", J::Num(self.breakpoint_count as f64)),
            ("zoneHashes", zone_hashes),
            ("hits", flag(self.outcome == CacheOutcome::Hit)),
            (
                "misses",
                flag(matches!(self.outcome, CacheOutcome::Miss { .. })),
            ),
            (
                "notCacheable",
                flag(matches!(self.outcome, CacheOutcome::NotCacheable(_))),
            ),
            ("missCauses", causes_j(&causes)),
        ]);
        match &self.outcome {
            CacheOutcome::Hit => j.set("outcome", J::s("hit")),
            CacheOutcome::Miss { cause, tools } => {
                j.set("outcome", J::s("miss"));
                j.set("cause", J::s(CACHE_MISS_CAUSES[*cause]));
                if let Some((added, removed)) = tools {
                    j.set("toolsAdded", J::Num(*added as f64));
                    j.set("toolsRemoved", J::Num(*removed as f64));
                }
            }
            CacheOutcome::NotCacheable(reason) => {
                j.set("outcome", J::s("not-cacheable"));
                j.set("notCacheableReason", J::s(reason));
            }
        }
        j
    }
}

struct StableState {
    model: String,
    tools: String,
    system: String,
    memory: String,
    tool_names: Vec<String>,
}

/// The names of the tools in the prompt, read back from the tool segments. A segment that is not a JSON object with a
/// string `name` is skipped.
fn tool_names(prompt: &RenderedPrompt) -> Vec<String> {
    prompt
        .segments
        .iter()
        .filter(|s| s.zone == ZoneName::Tools && s.kind == SegmentKind::ToolDef)
        .filter_map(|s| serde_json::from_str::<Value>(&s.text).ok())
        .filter_map(|v| v.get("name").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

fn classify(
    prompt: &RenderedPrompt,
    usage: &ProviderCacheUsage,
    prev: Option<&StableState>,
    names: &[String],
) -> CacheOutcome {
    let c = &prompt.cache;
    match c.reason {
        CacheReason::EmptyPrefix | CacheReason::UnknownModel | CacheReason::BelowMinimum => {
            return CacheOutcome::NotCacheable(c.reason.as_str());
        }
        CacheReason::Eligible | CacheReason::ImplicitProvider => {}
    }
    if c.mechanism == Mechanism::None {
        return CacheOutcome::NotCacheable("no-cache-mechanism");
    }
    if c.mechanism == Mechanism::Explicit && prompt.breakpoints.is_empty() {
        return CacheOutcome::NotCacheable("no-breakpoints");
    }
    // An implicit cache reports in coarser steps than the estimate.
    let tolerance = if c.mechanism == Mechanism::Implicit {
        128.0
    } else {
        0.0
    };
    if usage.cache_read >= prompt.stable_tokens_estimate as f64 - tolerance {
        return CacheOutcome::Hit;
    }
    let miss = |cause: usize| CacheOutcome::Miss { cause, tools: None };
    let Some(prev) = prev else {
        return miss(0);
    };
    if normalize_model_id(&prompt.model) != prev.model {
        return miss(1);
    }
    if prompt.zone_hash(ZoneName::Tools) != prev.tools {
        let before: HashSet<&str> = prev.tool_names.iter().map(String::as_str).collect();
        let now: HashSet<&str> = names.iter().map(String::as_str).collect();
        return CacheOutcome::Miss {
            cause: 2,
            tools: Some((
                now.difference(&before).count(),
                before.difference(&now).count(),
            )),
        };
    }
    if prompt.zone_hash(ZoneName::System) != prev.system {
        return miss(3);
    }
    if prompt.zone_hash(ZoneName::Memory) != prev.memory {
        return miss(4);
    }
    if let (Some(age), Some(ttl)) = (c.age_ms, c.ttl_ms) {
        if age >= ttl {
            return miss(5);
        }
    }
    miss(6)
}

fn key(agent_id: &str, model: &str, session_id: Option<&str>) -> String {
    let mut o = json!({ "agentId": agent_id, "model": normalize_model_id(model) });
    if let (Some(session), Some(map)) = (session_id, o.as_object_mut()) {
        map.insert("session_id".to_owned(), json!(session));
    }
    canonical_json(&o).unwrap_or_default()
}

fn safe_count(n: f64) -> Option<u64> {
    (n.is_finite() && n.fract() == 0.0 && (0.0..=MAX_SAFE as f64).contains(&n)).then_some(n as u64)
}

/// `createCacheTelemetry()`.
#[derive(Default)]
pub struct CacheTelemetry {
    totals: HashMap<String, CacheUsageSummary>,
    /// The last stable state per session, with the sequence number of its last record (the eviction order).
    states: HashMap<String, (u64, StableState)>,
    order: BTreeMap<u64, String>,
    next: u64,
    session_model_ids: HashMap<String, Vec<String>>,
}

impl CacheTelemetry {
    /// A telemetry with nothing recorded.
    pub fn new() -> Self {
        Self::default()
    }

    /// One successful provider-usage report per turn. Invalid usage is refused before anything is counted.
    pub fn record(
        &mut self,
        prompt: &RenderedPrompt,
        usage: ProviderCacheUsage,
    ) -> Result<CacheUsageRecord, TelemetryError> {
        let (Some(read), Some(creation), Some(input)) = (
            safe_count(usage.cache_read),
            safe_count(usage.cache_creation),
            safe_count(usage.input),
        ) else {
            return Err(TelemetryError::Counts);
        };
        let total = read + creation + input;
        if total > MAX_SAFE {
            return Err(TelemetryError::Total);
        }
        let names = tool_names(prompt);
        let outcome = classify(
            prompt,
            &usage,
            self.states.get(&prompt.session_id).map(|(_, s)| s),
            &names,
        );
        let keys = [
            key(&prompt.agent_id, &prompt.model, None),
            key(&prompt.agent_id, &prompt.model, Some(&prompt.session_id)),
        ];
        let mut updated: Vec<CacheUsageSummary> = Vec::with_capacity(2);
        for k in &keys {
            let mut next = self.totals.get(k).cloned().unwrap_or_default();
            next.cache_read_tokens += read;
            next.cache_creation_tokens += creation;
            next.input_tokens += input;
            next.total_input_tokens += total;
            next.turns += 1;
            match &outcome {
                CacheOutcome::Hit => next.hits += 1,
                CacheOutcome::Miss { cause, .. } => {
                    next.misses += 1;
                    next.miss_causes[*cause] += 1;
                }
                CacheOutcome::NotCacheable(_) => next.not_cacheable += 1,
            }
            if [
                next.cache_read_tokens,
                next.cache_creation_tokens,
                next.input_tokens,
                next.total_input_tokens,
            ]
            .iter()
            .any(|n| *n > MAX_SAFE)
            {
                return Err(TelemetryError::Aggregate);
            }
            next.hit_ratio = if next.total_input_tokens == 0 {
                0.0
            } else {
                next.cache_read_tokens as f64 / next.total_input_tokens as f64
            };
            updated.push(next);
        }
        let turn = updated[1].turns;
        for (k, v) in keys.into_iter().zip(updated) {
            self.totals.insert(k, v);
        }
        let model_id = normalize_model_id(&prompt.model);
        // The session moves to the end of the eviction order with every record.
        if let Some((seq, _)) = self.states.remove(&prompt.session_id) {
            self.order.remove(&seq);
        }
        self.next += 1;
        self.order.insert(self.next, prompt.session_id.clone());
        self.states.insert(
            prompt.session_id.clone(),
            (
                self.next,
                StableState {
                    model: model_id.clone(),
                    tools: prompt.zone_hash(ZoneName::Tools).to_owned(),
                    system: prompt.zone_hash(ZoneName::System).to_owned(),
                    memory: prompt.zone_hash(ZoneName::Memory).to_owned(),
                    tool_names: names,
                },
            ),
        );
        let ids = self
            .session_model_ids
            .entry(prompt.session_id.clone())
            .or_default();
        if !ids.contains(&model_id) {
            ids.push(model_id);
        }
        if self.states.len() > CACHE_SESSION_STATE_LIMIT {
            if let Some((_, oldest)) = self.order.pop_first() {
                self.states.remove(&oldest);
                self.session_model_ids.remove(&oldest);
            }
        }
        Ok(CacheUsageRecord {
            agent_id: prompt.agent_id.clone(),
            model: prompt.model.clone(),
            session_id: prompt.session_id.clone(),
            turn,
            usage,
            total_input_tokens: total,
            hit_ratio: if total == 0 {
                0.0
            } else {
                read as f64 / total as f64
            },
            breakpoint_count: prompt.breakpoints.len(),
            zone_hashes: prompt.zone_hashes.clone(),
            outcome,
        })
    }

    /// The totals of an (agent, model), or of one session of it when `session_id` (the host's original identity) is
    /// given. A detached copy.
    pub fn summary(
        &self,
        agent_id: &str,
        model: &str,
        session_id: Option<&str>,
    ) -> Option<CacheUsageSummary> {
        let sticky = session_id.map(|s| sticky_session_id(agent_id, Some(s)));
        self.totals
            .get(&key(agent_id, model, sticky.as_deref()))
            .cloned()
    }

    /// Per-model summaries of one harness session, sorted by model id (the default JavaScript sort); empty when
    /// nothing was recorded.
    pub fn session_models(
        &self,
        agent_id: &str,
        session_id: &str,
    ) -> Vec<(String, CacheUsageSummary)> {
        let sticky = sticky_session_id(agent_id, Some(session_id));
        let Some(ids) = self.session_model_ids.get(&sticky) else {
            return Vec::new();
        };
        let mut ids = ids.clone();
        ids.sort_by(|a, b| compare_utf16(a, b));
        ids.into_iter()
            .filter_map(|model| {
                let v = self.totals.get(&key(agent_id, &model, Some(&sticky)))?;
                Some((model, v.clone()))
            })
            .collect()
    }
}
