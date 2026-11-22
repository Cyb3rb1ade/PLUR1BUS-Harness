//! Current shortlist signals and scoped promotion receipts.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::candidates::{
    content_hash, evaluate, evaluate_fallback, Candidate, FallbackInput, GateConfig,
};
use super::store::DreamStore;
use super::types::{CandidateSeed, CandidateSignals, CandidateState, RunCounts};
use crate::budget::{Clock, IdSource};

use crate::collab::{CollabError, CollabErrorCode as C};
use crate::logs::methods::AbortSignal;

type R<T> = Result<T, CollabError>;

#[path = "producer.rs"]
pub mod producer;

/// A source entry visible to the checked agent.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateInput {
    /// Transient content. The ledger receives only its digest.
    pub content: String,
    /// Source partition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partition: Option<String>,
    /// The current opaque identity, if the source can prove one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<String>,
    /// Observed recalls.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recalls: Option<i64>,
    /// Observed distinct queries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique_queries: Option<i64>,
    /// Observed score.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    /// Original creation timestamp for diagnostic use only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<f64>,
    /// Importance signal for diagnostics.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub importance: Option<f64>,
    /// Repetition count for diagnostics.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repetitions: Option<f64>,
    /// Last validated recall timestamp when reported.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_recalled_at: Option<Option<f64>>,
}

fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(d).map(Some)
}

/// A shortlist observed for one agent.
pub struct CandidateBatch {
    /// Agent for which source items were resolved.
    pub agent_id: String,
    /// All candidates in this observation.
    pub items: Vec<CandidateInput>,
}

/// Stable states returned by the integration port.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReceiptOutcome {
    /// A new durable integration was observed.
    Promoted,
    /// The item was already durable or could not be integrated.
    Skipped,
}

/// An exact per-ID integration receipt from the authorized destination.
#[derive(Clone, Serialize)]
pub struct ReceiptItem {
    /// Requested item identity.
    pub id: String,
    /// Effect observed by the destination.
    pub outcome: ReceiptOutcome,
    /// Machine-readable confirmation or refusal.
    pub reason: String,
}

/// Response envelope scoped to the recipient agent.
pub struct PromotionReceipt {
    /// Agent whose partition received the operation.
    pub agent_id: String,
    /// Individual confirmations, which may omit unconfirmed IDs.
    pub items: Vec<ReceiptItem>,
}

/// Trusted candidate observation and receipt port.
pub trait CandidateSource {
    /// Observe current source IDs and signals for the authorized agent.
    fn pull(&mut self, agent: &str, abort: &AbortSignal) -> R<CandidateBatch>;
    /// Whether the host can obtain an integration receipt.
    fn can_promote(&self) -> bool;
    /// Apply only these identities in the checked agent-private partition.
    fn promote(&mut self, agent: &str, ids: &[&str], abort: &AbortSignal) -> R<PromotionReceipt>;
}

const TTL: i64 = 72 * 3_600_000;
const PAGE: usize = 500;
const MAX_CANDIDATES: usize = 5000;
const MAX_CONTENT: usize = 262_144;
const SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Default)]
pub(super) struct Prepared {
    pub counts: RunCounts,
    entries: Vec<Pending>,
}

struct Pending {
    candidate: String,
    memory: String,
    expires_at: i64,
    decision: Value,
}

fn invalid() -> CollabError {
    CollabError::new(C::Invalid, "invalid dreaming candidate evidence")
}

fn opaque(id: &str) -> bool {
    !id.is_empty() && id.encode_utf16().count() <= 128 && !id.chars().any(char::is_control)
}

pub(super) fn observe(
    store: &DreamStore,
    agent: &str,
    run: &str,
    at: i64,
    ids: &dyn IdSource,
    batch: &CandidateBatch,
    workspace: bool,
) -> R<Prepared> {
    if batch.agent_id != agent || batch.items.len() > MAX_CANDIDATES {
        return Err(invalid());
    }
    let mut current = HashMap::new();
    let mut sorted = Vec::new();
    for input in &batch.items {
        let partition = input.partition.as_deref().unwrap_or("agent-private");
        if partition != "agent-private" && !(workspace && partition == "workspace") {
            continue;
        }
        if input.content.len() > MAX_CONTENT
            || input.memory_id.as_deref().is_some_and(|id| !opaque(id))
            || [input.recalls, input.unique_queries]
                .into_iter()
                .flatten()
                .any(|n| !(0..=SAFE_INTEGER).contains(&n))
            || input.score.is_some_and(|s| !s.is_finite())
        {
            return Err(invalid());
        }
        let hash = content_hash(&input.content);
        let key = (partition, hash);
        if let Some(last) = current.insert(key.clone(), input) {
            if last.memory_id != input.memory_id {
                return Err(invalid());
            }
        }
        sorted.push(key);
    }
    store.update_candidates(|| {
        let mut stats = Prepared::default();
        let mut candidates = 0;
        let mut deduped = 0;
        for (partition, hash) in sorted {
            let input = current[&(partition, hash.clone())];
            let signals = CandidateSignals {
                recalls: input.recalls.unwrap_or(0),
                unique_queries: input.unique_queries.unwrap_or(0),
                score: input.score,
            };
            let inserted = store.insert_candidate(
                &CandidateSeed {
                    candidate_id: ids.next_id(),
                    agent_id: agent.into(),
                    partition: partition.into(),
                    content_hash: hash.clone(),
                    source_run_id: run.into(),
                    first_seen_at: at,
                    expires_at: at.saturating_add(TTL),
                    signals,
                },
                CandidateState::Shortlisted,
            )?;
            if inserted {
                candidates += 1;
            } else {
                deduped += 1;
                store.update_signals(agent, partition, &hash, signals)?;
            }
        }
        let expired = store.expire_candidates(agent, at)?;
        let mut rejected = 0;
        for row in store.candidates(agent, Some(CandidateState::Shortlisted))? {
            let seed = row.seed;
            let decision = evaluate(
                &Candidate {
                    expires_at: seed.expires_at,
                    recalls: seed.signals.recalls,
                    unique_queries: seed.signals.unique_queries,
                    score: seed.signals.score,
                },
                at,
                GateConfig::default(),
            );
            let mut evidence = serde_json::to_value(&decision).map_err(|_| invalid())?;
            let input = current.get(&(seed.partition.as_str(), seed.content_hash));
            if let Some(input) = input.filter(|i| i.recalls.is_none() || i.unique_queries.is_none())
            {
                evidence["fallback"] = serde_json::to_value(evaluate_fallback(
                    &FallbackInput {
                        created_at: input.created_at,
                        importance: input.importance,
                        repetitions: input.repetitions,
                    },
                    at as f64,
                ))
                .map_err(|_| invalid())?;
            }
            store.set_candidate_state(
                agent,
                &seed.candidate_id,
                CandidateState::Shortlisted,
                &evidence,
            )?;
            if !decision.promote {
                rejected += 1;
            }
            if decision.promote && seed.partition == "agent-private" {
                if let Some(memory) = input
                    .filter(|i| i.recalls.is_some() && i.unique_queries.is_some())
                    .and_then(|i| i.memory_id.as_ref())
                {
                    stats.entries.push(Pending {
                        candidate: seed.candidate_id,
                        memory: memory.clone(),
                        expires_at: seed.expires_at,
                        decision: evidence,
                    });
                }
            }
        }
        stats.counts.extend([
            ("candidates".into(), candidates as f64),
            ("deduped".into(), deduped as f64),
            ("expired".into(), expired as f64),
            ("rejected".into(), rejected as f64),
        ]);
        Ok(stats)
    })
}

pub(super) fn integrate(
    store: &DreamStore,
    agent: &str,
    prepared: Prepared,
    port: &mut dyn CandidateSource,
    abort: &AbortSignal,
    clock: &dyn Clock,
    check: impl Fn() -> R<()>,
) -> R<RunCounts> {
    let mut counts = RunCounts::new();
    let entries: Vec<_> = prepared
        .entries
        .into_iter()
        .filter(|entry| entry.expires_at > clock.now())
        .collect();
    if entries.is_empty() {
        return Ok(counts);
    }
    if !port.can_promote() {
        counts.insert("promotionUnavailable".into(), entries.len() as f64);
        return Ok(counts);
    }
    let mut seen = HashSet::new();
    let ids: Vec<_> = entries
        .iter()
        .filter_map(|p| seen.insert(p.memory.as_str()).then_some(p.memory.as_str()))
        .collect();
    let mut receipts = HashMap::new();
    for batch in ids.chunks(PAGE) {
        check()?;
        let receipt = port.promote(agent, batch, abort)?;
        if receipt.agent_id != agent || receipt.items.len() > batch.len() {
            return Err(invalid());
        }
        for item in receipt.items {
            if !batch.contains(&item.id.as_str())
                || item.reason.len() > 128
                || (item.outcome == ReceiptOutcome::Promoted && item.reason != "integrated")
                || receipts.contains_key(&item.id)
            {
                return Err(invalid());
            }
            receipts.insert(item.id.clone(), item);
        }
    }
    check()?;
    store.update_candidates(|| {
        let now = clock.now();
        let mut promoted = 0;
        let mut skipped = 0;
        for mut candidate in entries {
            let receipt = receipts.get(&candidate.memory);
            let confirmed = receipt.is_some_and(|r| {
                r.outcome == ReceiptOutcome::Promoted || r.reason == "already-promoted"
            });
            candidate.decision["engine"] = receipt.map_or_else(
                || json!({"id":candidate.memory,"outcome":"missing","reason":"no-confirmation"}),
                |r| json!(r),
            );
            let state = if candidate.expires_at <= now {
                CandidateState::Expired
            } else if confirmed {
                CandidateState::Promoted
            } else {
                CandidateState::Shortlisted
            };
            let changed = store.set_candidate_state(
                agent,
                &candidate.candidate,
                state,
                &candidate.decision,
            )?;
            if changed && state == CandidateState::Promoted {
                promoted += 1;
            } else {
                skipped += 1;
            }
        }
        counts.insert("promoted".into(), promoted as f64);
        if skipped > 0 {
            counts.insert("promotionSkipped".into(), skipped as f64);
        }
        Ok(counts)
    })
}

#[cfg(test)]
#[path = "promotion_vectors.rs"]
mod vectors;
