//! Inter-result dedupe.
//!
//! Ports `dedupResults`, `chunkGroupKey` and `hasDisjointValidityWindows`.
//! Jaccard uses [`crate::text::legacy::text_utils::jaccard_similarity`]. A whole row
//! replaces its chunk parts in place and does not consume the slot break.

use std::collections::HashMap;

use super::candidate::RecallCandidate;
use crate::text::legacy::text_utils::jaccard_similarity;

const MAX_PER_GROUP: i32 = 2;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Drop near-duplicates and extras past `max_out`.
///
/// `max_out == 0` returns an empty list. Group cap is 2. A third chunk of the same
/// group is dropped before the Jaccard check. Disjoint validity windows stay.
#[must_use]
pub fn dedup_results(
    results: &[RecallCandidate],
    max_out: usize,
    jaccard_threshold: f64,
) -> Vec<RecallCandidate> {
    if max_out == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut groups = HashMap::new();
    for row in results {
        if out.iter().any(|kept| is_whole_of(kept, row)) {
            continue;
        }
        if replace_parts(&mut out, &mut groups, row) {
            continue;
        }
        if group_full(&groups, row) {
            continue;
        }
        if !near_duplicate(&out, row, jaccard_threshold) {
            adjust_group(&mut groups, row, 1);
            out.push(row.clone());
        }
        if out.len() >= max_out {
            break;
        }
    }
    out
}

fn replace_parts(
    out: &mut Vec<RecallCandidate>,
    groups: &mut HashMap<String, i32>,
    row: &RecallCandidate,
) -> bool {
    let positions: Vec<usize> = out
        .iter()
        .enumerate()
        .filter(|(_, kept)| is_whole_of(row, kept))
        .map(|(index, _)| index)
        .collect();
    if positions.is_empty() {
        return false;
    }
    let position = positions[0];
    for index in &positions {
        adjust_group(groups, &out[*index], -1);
    }
    let mut rest: Vec<RecallCandidate> = out
        .iter()
        .enumerate()
        .filter(|(index, _)| !positions.contains(index))
        .map(|(_, kept)| kept.clone())
        .collect();
    rest.insert(position.min(rest.len()), row.clone());
    *out = rest;
    adjust_group(groups, row, 1);
    true
}

fn group_full(groups: &HashMap<String, i32>, row: &RecallCandidate) -> bool {
    chunk_group_key(row).is_some_and(|key| groups.get(&key).copied().unwrap_or(0) >= MAX_PER_GROUP)
}

fn near_duplicate(out: &[RecallCandidate], row: &RecallCandidate, threshold: f64) -> bool {
    let text = dedupe_text(row);
    out.iter().any(|kept| {
        jaccard_similarity(&text, &dedupe_text(kept)) >= threshold
            && !has_disjoint_validity_windows(row, kept)
    })
}

fn adjust_group(groups: &mut HashMap<String, i32>, row: &RecallCandidate, delta: i32) {
    let Some(key) = chunk_group_key(row) else {
        return;
    };
    let next = groups.get(&key).copied().unwrap_or(0) + delta;
    groups.insert(key, next);
}

fn chunk_group_key(row: &RecallCandidate) -> Option<String> {
    let raw = if !row.chunk_group_id.is_empty() {
        row.chunk_group_id.as_str()
    } else if !row.source_turn_id.is_empty() {
        row.source_turn_id.as_str()
    } else {
        ""
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn turn_of(row: &RecallCandidate) -> Option<&str> {
    let turn = row.source_turn_id.trim();
    if turn.is_empty() {
        None
    } else {
        Some(turn)
    }
}

fn is_chunk_part(row: &RecallCandidate) -> bool {
    !row.chunk_group_id.trim().is_empty() && turn_of(row).is_some()
}

fn is_whole_of(whole: &RecallCandidate, part: &RecallCandidate) -> bool {
    !is_chunk_part(whole) && is_chunk_part(part) && turn_of(whole) == turn_of(part)
}

fn dedupe_text(row: &RecallCandidate) -> String {
    if row.summary.is_empty() {
        row.text.clone()
    } else {
        row.summary.clone()
    }
}

fn has_disjoint_validity_windows(left: &RecallCandidate, right: &RecallCandidate) -> bool {
    let left_from = known_bound(left.valid_from);
    let left_until = known_bound(left.valid_until);
    let right_from = known_bound(right.valid_from);
    let right_until = known_bound(right.valid_until);
    if left_from.is_none() && left_until.is_none() {
        return false;
    }
    if right_from.is_none() && right_until.is_none() {
        return false;
    }
    if bounds_separate(left_until, right_from) || bounds_separate(right_until, left_from) {
        return true;
    }
    false
}

fn bounds_separate(until: Option<f64>, from: Option<f64>) -> bool {
    until.is_some_and(|until| from.is_some_and(|from| until <= from))
}

fn known_bound(value: f64) -> Option<f64> {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER && value > 0.0 {
        Some(value)
    } else {
        None
    }
}
