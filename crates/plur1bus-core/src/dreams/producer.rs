//! Candidate listing and recall-statistics validation over trusted ports.

use super::{invalid, opaque, CandidateInput, MAX_CANDIDATES, MAX_CONTENT, PAGE, R, SAFE_INTEGER};
use crate::dreams::candidates::content_hash;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

/// One card from the public memory listing.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    /// Current public identity when available.
    pub id: Option<String>,
    /// Transient scoped content.
    pub text: String,
    /// Actual memory scope.
    pub scope: String,
    /// Last reported score.
    pub score: Option<f64>,
    /// Reported creation instant.
    pub created_at: Option<f64>,
    /// Reported importance.
    pub importance: Option<f64>,
}

/// One response to an inclusive time query.
#[derive(Deserialize)]
pub struct Page {
    /// Public card slice.
    pub items: Vec<Card>,
    /// Additional cards might exist.
    pub truncated: bool,
}

/// Time-bounded listing port.
pub trait Listing {
    /// Read the current authorized interval.
    fn page(&mut self, since: i64, until: f64, limit: usize) -> R<Page>;
}

/// Scoped persistent recall observations.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Statistics {
    /// Agent for which the data was measured.
    pub agent_id: String,
    /// Observations for requested IDs only.
    pub items: Vec<Statistic>,
}

/// Observation for one known source identity.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Statistic {
    /// Requested memory identity.
    pub id: String,
    /// Measured number of recalls.
    pub recalls: i64,
    /// Measured number of distinct queries.
    pub distinct_queries: i64,
    /// Last measured recall timestamp.
    pub last_recalled_at: Option<f64>,
}

/// Live recall-statistics capability.
pub trait Recall {
    /// Read exact measured stats for the checked agent and IDs.
    fn statistics(&mut self, agent: &str, ids: &[&str]) -> R<Statistics>;
}

const PAGE_SIZE: usize = 100;

fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|n| n.is_finite())
}

/// Refuse incomplete listings and project only agent-private cards.
pub fn project(list: Page) -> R<Vec<CandidateInput>> {
    if list.truncated || list.items.len() > MAX_CANDIDATES {
        return Err(invalid());
    }
    let mut repeats: HashMap<String, HashSet<String>> = HashMap::new();
    for card in list.items.iter().filter(|c| c.scope == "agent-private") {
        if card.text.len() > MAX_CONTENT {
            return Err(invalid());
        }
        if let Some(id) = card.id.as_deref().filter(|id| opaque(id)) {
            repeats
                .entry(content_hash(&card.text))
                .or_default()
                .insert(id.to_owned());
        }
    }
    let results = list
        .items
        .into_iter()
        .filter(|card| card.scope == "agent-private")
        .map(|card| {
            let repetitions = repeats
                .get(&content_hash(&card.text))
                .map(HashSet::len)
                .filter(|n| *n > 1)
                .map(|n| n as f64);
            CandidateInput {
                content: card.text,
                partition: Some("agent-private".into()),
                memory_id: card.id.filter(|id| opaque(id)),
                recalls: None,
                unique_queries: None,
                score: finite(card.score),
                created_at: finite(card.created_at),
                importance: finite(card.importance),
                repetitions,
                last_recalled_at: None,
            }
        })
        .collect();
    Ok(results)
}

/// Exhaust a bounded, progress-checked time listing.
pub fn read(listing: &mut dyn Listing, until: i64) -> R<Vec<CandidateInput>> {
    if !(0..=SAFE_INTEGER).contains(&until) {
        return Err(invalid());
    }
    let mut until = until as f64;
    let mut seen = HashSet::new();
    let mut cards = Vec::new();
    for _ in 0..MAX_CANDIDATES.div_ceil(PAGE_SIZE) {
        let page = listing.page(0, until, PAGE_SIZE)?;
        if page.items.len() > PAGE_SIZE {
            return Err(invalid());
        }
        let mut next = until;
        for card in page.items {
            let id = card
                .id
                .as_deref()
                .filter(|id| opaque(id))
                .ok_or_else(invalid)?;
            if page.truncated {
                let at = card
                    .created_at
                    .filter(|at| (0.0..=until).contains(at))
                    .ok_or_else(invalid)?;
                next = next.min(at);
            }
            if seen.insert(id.to_owned()) {
                if cards.len() >= MAX_CANDIDATES {
                    return Err(invalid());
                }
                cards.push(card);
            }
        }
        if !page.truncated {
            return project(Page {
                items: cards,
                truncated: false,
            });
        }
        if next >= until {
            return Err(invalid());
        }
        until = next;
    }
    Err(invalid())
}

/// Enrich private cards only with observations validated for this exact request.
pub fn signals(
    agent: &str,
    items: Vec<CandidateInput>,
    recall: Option<&mut dyn Recall>,
) -> R<Vec<CandidateInput>> {
    if items.len() > MAX_CANDIDATES {
        return Err(invalid());
    }
    let mut items: Vec<_> = items
        .into_iter()
        .filter(|c| c.partition.as_deref().is_none_or(|p| p == "agent-private"))
        .collect();
    let Some(recall) = recall else {
        return Ok(items);
    };
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for input in &items {
        if let Some(id) = input.memory_id.as_deref() {
            if !opaque(id) {
                return Err(invalid());
            }
            if seen.insert(id) {
                ids.push(id);
            }
        }
    }
    let mut validated = HashMap::new();
    for ids in ids.chunks(PAGE) {
        let receipt = recall.statistics(agent, ids)?;
        if receipt.agent_id != agent || receipt.items.len() > ids.len() {
            return Err(invalid());
        }
        for stat in receipt.items {
            if !ids.contains(&stat.id.as_str())
                || validated.contains_key(&stat.id)
                || !(0..=SAFE_INTEGER).contains(&stat.recalls)
                || !(0..=SAFE_INTEGER).contains(&stat.distinct_queries)
                || stat
                    .last_recalled_at
                    .is_some_and(|n| !n.is_finite() || n < 0.0)
            {
                return Err(invalid());
            }
            validated.insert(stat.id.clone(), stat);
        }
    }
    for card in &mut items {
        let stat = card.memory_id.as_ref().and_then(|id| validated.get(id));
        card.recalls = stat.map(|s| s.recalls);
        card.unique_queries = stat.map(|s| s.distinct_queries);
        card.last_recalled_at = stat.map(|s| s.last_recalled_at);
    }
    Ok(items)
}

#[cfg(test)]
#[path = "producer_vectors.rs"]
mod vectors;
