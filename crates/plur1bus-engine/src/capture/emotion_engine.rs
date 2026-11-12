//! Stateful per-owner emotion routing. Never share one instance across authenticated agents.
//! The host callback receives the caller's cancellation and a narrowed automatic-tier budget.
//! No background job, direct provider, credential lookup or detached thread is created here.
use super::{
    emotion_blends::{detect_blend, detect_transition},
    emotion_json::{entries, get, iso, num, numeric, object, string},
    emotion_score::EmotionScore,
    tier1::Tier1Classifier,
    tier2::Tier2Classifier,
    tier3,
};
use crate::{
    contract::{Cancel, EngineError, LlmPort},
    text::{
        js::JsString,
        json::{write_json, TolerantJsonValue as Json},
    },
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

/// One explicit analysis choice; automatic capture may suppress tier 3 without losing local scores.
#[derive(Clone, Copy, Default)]
pub struct AnalysisOptions {
    /// Explicit tier 1/2/3; other values follow automatic routing, as Node does.
    pub force_tier: Option<u8>,
    /// Suppress automatic tier-3 escalation, leaving explicit forceTier unchanged.
    pub skip_tier3: bool,
}
/// One host-owned, serially used classifier context with no global mutable vocabulary.
pub struct EmotionEngine {
    tier1: Tier1Classifier,
    tier2: Tier2Classifier,
    completion: Option<Arc<dyn LlmPort>>,
    tier2_enabled: bool,
    tier3_enabled: bool,
    tier3_configured: bool,
    escalation: f64,
    timeout: Duration,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    previous: Json,
    counts: [u64; 3],
    elapsed: i64,
}
struct CompletionLease<'a> {
    engine: &'a mut EmotionEngine,
    previous: Option<Arc<dyn LlmPort>>,
    enabled: bool,
}
impl Drop for CompletionLease<'_> {
    fn drop(&mut self) {
        self.engine.completion = self.previous.take();
        self.engine.tier3_enabled = self.enabled;
    }
}
impl EmotionEngine {
    /// Bind the already authorized host callback. Raw keys/direct clients are never accepted.
    pub fn new(
        config: &Json,
        completion: Option<Arc<dyn LlmPort>>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Self, EngineError> {
        let timeout = numeric(get(get(config, "tier3"), "timeoutMs"))
            .filter(|n| n.is_finite())
            .unwrap_or(4000.);
        // Node timers clamp nonpositive/overflowing values to one millisecond.
        let timeout = if !(1. ..=2_147_483_647.).contains(&timeout) {
            1.
        } else {
            timeout.floor()
        };
        Ok(Self {
            tier1: Tier1Classifier::new(get(config, "tier1"))?,
            tier2: Tier2Classifier::new()?,
            tier2_enabled: get(get(config, "tier2"), "enabled") != &Json::Bool(false),
            tier3_enabled: get(get(config, "tier3"), "enabled") != &Json::Bool(false)
                && completion.is_some(),
            tier3_configured: get(get(config, "tier3"), "enabled") != &Json::Bool(false),
            completion,
            escalation: numeric(get(config, "escalationConfidence"))
                .filter(|n| n.is_finite())
                .unwrap_or(0.7),
            timeout: Duration::from_millis(timeout as u64),
            clock,
            previous: object([
                ("previous_top_emotion", Json::Null),
                ("previous_timestamp", Json::Null),
            ]),
            counts: [0; 3],
            elapsed: 0,
        })
    }
    /// Use a fresh caller-bound callback for one analysis, restoring the prior binding even on error.
    /// This permits a private emotional history to outlive an individual provider lease.
    pub fn analyze_with_completion(
        &mut self,
        input: &JsString,
        source: &str,
        options: AnalysisOptions,
        cancel: &Cancel,
        completion: Option<Arc<dyn LlmPort>>,
    ) -> Result<EmotionScore, EngineError> {
        let enabled = self.tier3_enabled;
        self.tier3_enabled = self.tier3_configured && completion.is_some();
        let previous = std::mem::replace(&mut self.completion, completion);
        let lease = CompletionLease {
            engine: self,
            previous,
            enabled,
        };
        lease.engine.analyze(input, source, options, cancel)
    }

    /// Analyze and advance the private context only after successful, non-cancelled completion.
    pub fn analyze(
        &mut self,
        input: &JsString,
        source: &str,
        options: AnalysisOptions,
        cancel: &Cancel,
    ) -> Result<EmotionScore, EngineError> {
        cancel.check()?;
        let start = (self.clock)();
        let mut result = match options.force_tier {
            Some(1) => self.tier1_only(input, source, start)?,
            Some(2) if self.tier2_enabled => self.tier2.classify(input, source, start)?,
            Some(2) => self.tier1_only(input, source, start)?,
            Some(3) if self.tier3_enabled => tier3::classify(
                self.completion
                    .as_deref()
                    .ok_or_else(super::emotion_json::invalid)?,
                input,
                source,
                None,
                self.clock.as_ref(),
                cancel,
            )?,
            Some(3) => tier3::neutral(source, 1, start)?,
            _ => self.automatic(input, source, start, options.skip_tier3, cancel)?,
        };
        cancel.check()?;
        if let Some(blend) = detect_blend(
            &object(result.emotion_labels.clone()),
            input,
            &self.previous,
        )? {
            result.blend_factors = entries(get(get(&blend, "evidence"), "base_blend"));
            result.complex_emotion = Some(blend);
        }
        if let Some(transition) = detect_transition(&result.primary_emotion, &self.previous) {
            result.emotional_context = Some(object([
                (
                    "previous_top_emotion",
                    get(&self.previous, "previous_top_emotion").clone(),
                ),
                (
                    "previous_timestamp",
                    get(&self.previous, "previous_timestamp").clone(),
                ),
                ("transition", string(&transition)),
                ("target_entity", Json::Null),
            ]));
        }
        let now = (self.clock)();
        self.previous = object([
            ("previous_top_emotion", string(&result.primary_emotion)),
            ("previous_timestamp", string(&iso(now)?)),
        ]);
        self.elapsed = self.elapsed.saturating_add(now.saturating_sub(start));
        if (1..=3).contains(&result.tier_used) {
            self.counts[usize::from(result.tier_used - 1)] += 1;
        }
        Ok(result)
    }
    fn tier1_only(
        &self,
        input: &JsString,
        source: &str,
        now: i64,
    ) -> Result<EmotionScore, EngineError> {
        self.tier1
            .classify(input, source, now)?
            .map_or_else(|| tier3::neutral(source, 1, now), Ok)
    }
    fn automatic(
        &self,
        input: &JsString,
        source: &str,
        now: i64,
        skip: bool,
        cancel: &Cancel,
    ) -> Result<EmotionScore, EngineError> {
        let Some(t1) = self.tier1.classify(input, source, now)? else {
            if !self.tier2_enabled {
                return tier3::neutral(source, 1, now);
            }
            let t2 = self.tier2.classify(input, source, now)?;
            return if t2.confidence >= self.escalation {
                Ok(t2)
            } else {
                self.maybe_t3(input, source, t2, skip, cancel)
            };
        };
        if t1.valence.abs() < 0.2 || t1.confidence < 0.5 {
            if !self.tier2_enabled {
                return self.maybe_t3(input, source, t1, skip, cancel);
            }
            let t2 = self.tier2.classify(input, source, now)?;
            if t2.primary_emotion != t1.primary_emotion {
                let better = if t2.confidence > t1.confidence {
                    t2
                } else {
                    t1
                };
                return self.maybe_t3(input, source, better, skip, cancel);
            }
            let best = if t2.confidence > t1.confidence + 0.2 {
                t2
            } else {
                t1
            };
            return if best.confidence >= self.escalation {
                Ok(best)
            } else {
                self.maybe_t3(input, source, best, skip, cancel)
            };
        }
        if t1.confidence >= self.escalation {
            Ok(t1)
        } else {
            self.maybe_t3(input, source, t1, skip, cancel)
        }
    }
    fn maybe_t3(
        &self,
        input: &JsString,
        source: &str,
        local: EmotionScore,
        skip: bool,
        cancel: &Cancel,
    ) -> Result<EmotionScore, EngineError> {
        if !self.tier3_enabled || skip {
            return Ok(local);
        }
        let Some(port) = self.completion.as_deref() else {
            return Ok(local);
        };
        let budget = cancel.limited_to(Instant::now() + self.timeout);
        let result = tier3::classify(
            port,
            input,
            source,
            Some(&local),
            self.clock.as_ref(),
            &budget,
        );
        cancel.check()?;
        if budget.is_cancelled() {
            return Ok(local);
        }
        Ok(result.unwrap_or(local))
    }
    /// Node-order counters. Clock/identity/content are never taken from caller text.
    pub fn stats_json(&self) -> String {
        let total = self.counts.iter().sum::<u64>();
        let pct = |n| {
            if total > 0 {
                ((n as f64 / total as f64) * 1000. + 0.5).floor() / 10.
            } else {
                0.
            }
        };
        let average = if total > 0 {
            ((self.elapsed as f64 / total as f64) * 10. + 0.5).floor() / 10.
        } else {
            0.
        };
        write_json(&object([
            ("tier1", num(self.counts[0] as f64)),
            ("tier2", num(self.counts[1] as f64)),
            ("tier3", num(self.counts[2] as f64)),
            ("total_ms", num(self.elapsed as f64)),
            ("total", num(total as f64)),
            ("pct_tier1", num(pct(self.counts[0]))),
            ("pct_tier2", num(pct(self.counts[1]))),
            ("pct_tier3", num(pct(self.counts[2]))),
            ("avg_ms", num(average)),
        ]))
    }
}
