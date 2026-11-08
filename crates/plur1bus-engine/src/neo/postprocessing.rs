//! Frozen S2 completion and episode replay rules; no jobs, state writes or implicit authority.
use crate::text::js::JsString;
use std::collections::HashSet;

/// Node default for the remembered turn-ID suffix.
pub const DEFAULT_EPISODE_ID_CAP: usize = 2000;

/// Result of all required postprocessing paths for a single accepted batch.
pub struct AdvanceDecision {
    /// Whether the caller may propose an advancement under the session's compare-and-set lock.
    pub advance: bool,
    /// Consecutive failures to record if advancement is withheld.
    pub next_failures: f64,
    /// The caller must explicitly report this exhausted-retry outcome; it is not successful work.
    pub gave_up: bool,
}
/// Resolve actual boolean path outcomes with Node's numeric retry normalization.
/// An empty path set or all-success set advances immediately. Exhaustion is distinct from success.
/// This pure decision does not advance a checkpoint or authorize skipping required work.
pub fn resolve_advance(results: &[bool], failures: f64, max_retries: f64) -> AdvanceDecision {
    let previous = if failures.is_finite() && failures > 0. {
        failures.floor()
    } else {
        0.
    };
    let limit = if max_retries.is_finite() && max_retries > 0. {
        max_retries.floor()
    } else {
        1.
    };
    if results.iter().all(|result| *result) {
        return AdvanceDecision {
            advance: true,
            next_failures: 0.,
            gave_up: false,
        };
    }
    let attempt = previous + 1.;
    if attempt >= limit {
        AdvanceDecision {
            advance: true,
            next_failures: 0.,
            gave_up: true,
        }
    } else {
        AdvanceDecision {
            advance: false,
            next_failures: attempt,
            gave_up: false,
        }
    }
}
/// References into the caller's episode list, avoiding copies of episode contents.
pub struct Selection {
    /// Episodes with no source IDs or at least one previously unseen ID, in input order.
    pub indices: Vec<usize>,
    /// Episodes whose every source ID was already recorded.
    pub skipped: usize,
}
/// Filter typed string turn identities after the caller has validated episode/source authority.
/// Empty source lists are retained; partial overlap never discards a newly processed turn.
pub fn filter_already_episoded(episodes: &[Vec<JsString>], previous: &[JsString]) -> Selection {
    let seen: HashSet<_> = previous.iter().collect();
    let indices: Vec<_> = episodes
        .iter()
        .enumerate()
        .filter_map(|(index, ids)| {
            (ids.is_empty() || !ids.iter().all(|id| seen.contains(id))).then_some(index)
        })
        .collect();
    Selection {
        skipped: episodes.len() - indices.len(),
        indices,
    }
}
/// Merge typed string IDs using Node Set insertion order, then keep the bounded suffix.
/// Seeing an existing ID again does not move its slot. Nonpositive/nonfinite limits use 2,000;
/// a positive fractional limit below one becomes zero, whose Node `slice(-0)` keeps all IDs.
/// Inputs remain caller-owned; returning owned IDs requires one clone per distinct retained ID.
pub fn merge_episoded_ids(
    previous: &[JsString],
    episodes: &[Vec<JsString>],
    limit: f64,
) -> Vec<JsString> {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for id in previous.iter().chain(episodes.iter().flatten()) {
        if seen.insert(id) {
            merged.push(id);
        }
    }
    let cap = if limit.is_finite() && limit > 0. {
        limit.floor()
    } else {
        DEFAULT_EPISODE_ID_CAP as f64
    };
    let start = if cap == 0. || cap >= merged.len() as f64 {
        0
    } else {
        merged.len() - cap as usize
    };
    // Materialize only the retained opaque IDs, without UTF-8 replacement or coercion.
    merged[start..].iter().map(|id| (*id).clone()).collect()
}
