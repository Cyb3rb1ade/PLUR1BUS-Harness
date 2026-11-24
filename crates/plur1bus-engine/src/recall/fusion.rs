//! Reciprocal rank fusion for ordered source IDs.
use super::namespace_identity::DEFAULT_RRF_K;
use std::collections::{HashMap, HashSet};

/// Sum one reciprocal rank per distinct source and ID. Equal totals retain discovery order.
pub fn rrf<'a>(sources: &[&[&'a str]]) -> Vec<&'a str> {
    let mut scores = HashMap::new();
    let mut ordered = Vec::new();
    for source in sources {
        let mut seen = HashSet::new();
        for (rank, id) in source
            .iter()
            .copied()
            .filter(|id| seen.insert(*id))
            .enumerate()
        {
            let score = scores.entry(id).or_insert_with(|| {
                ordered.push(id);
                0.0
            });
            *score += 1.0 / (DEFAULT_RRF_K + rank as f64 + 1.0);
        }
    }
    ordered.sort_by(|a, b| scores[b].total_cmp(&scores[a]));
    ordered
}
