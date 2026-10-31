//! Associative spread and graph-only hydration.
//!
//! Hydration relevance of a vector read back from Lance is non-finite. The pinned
//! pipeline calls `cosineSimilarityVec`, which indexes a Lance Arrow vector with
//! `a[i]`. Those reads are `undefined`, the cosine is `NaN`, and `NaN < 0.25` is
//! false, so the row stays. A decoded `Vec<f32>` would be finite and would drop the
//! orthogonal neighbour in `graph-only-hit-excluded`.

use super::hash_embed::cosine_similarity;

/// Default traversal bounds from `DEFAULT_TRAVERSAL_CONFIG`.
pub const SEED_COUNT: usize = 5;
/// Maximum edge depth, including the step off a seed.
pub const MAX_DEPTH: usize = 2;
/// Neighbours taken from one node after sorting by strength.
pub const MAX_NEIGHBORS_PER_NODE: usize = 8;
/// Base cumulative-relevance floor. Depth 1 multiplies it by 1.5.
pub const MIN_CUMULATIVE_RELEVANCE: f64 = 0.2;
/// Added to the floor once per depth step.
pub const DEPTH_RELEVANCE_SCALE: f64 = 0.5;
/// Cap on dequeued nodes.
pub const MAX_VISITED_NODES: usize = 150;
/// Cap on associative rows.
pub const MAX_ASSOCIATED_RESULTS: usize = 40;
/// Scale used when a graph row has no vector anchor.
pub const GRAPH_NO_ANCHOR_SCALE: f64 = 0.7;
/// Graph-only rows must stay under this fraction of the best vector score.
pub const GRAPH_ANCHOR_CAP: f64 = 0.85;
/// Default cosine floor. The Lance path never produces a finite value to compare.
pub const HYDRATION_RELEVANCE_THRESHOLD: f64 = 0.25;
/// Edges inspected while collecting endpoints.
pub const GRAPH_ACL_MAX_INSPECTED_EDGES: usize = 400;
/// Distinct endpoints the authorization walk may name.
pub const GRAPH_ACL_MAX_ENDPOINT_IDS: usize = 200;

/// One recorder edge. `kind` is the Node `type` field.
#[derive(Clone, Debug, PartialEq)]
pub struct GraphEdge {
    /// Source memory id.
    pub source: String,
    /// Target memory id.
    pub target: String,
    /// Edge weight in `[0, 1]`.
    pub strength: f64,
    /// When false, traversal walks both directions.
    pub directed: bool,
    /// Edge type. Undirected dedup sorts the two ids.
    pub kind: String,
}

#[derive(Clone, Debug)]
struct Link {
    target: String,
    strength: f64,
}

#[derive(Clone, Debug)]
struct Queued {
    memory_id: String,
    score: f64,
    cumulative: f64,
    depth: usize,
}

/// A neighbour found by walking out from the seeds.
#[derive(Clone, Debug, PartialEq)]
pub struct AssociativeHit {
    /// Memory id that was not itself a seed at depth 0.
    pub memory_id: String,
    /// Score before the anchor cap.
    pub associated_score: f64,
    /// Depth, starting at 1.
    pub depth: usize,
}

/// Relevance the pinned hydration check computes for a Lance-backed vector.
///
/// A stored vector whose length matches the query follows the Arrow-vector path and
/// is `NaN`. A different length returns 0 so the caller can re-embed and use
/// [`cosine_similarity`].
#[must_use]
pub fn lance_stored_relevance(stored: &[f32], query: &[f32]) -> f64 {
    if !query.is_empty() && stored.len() == query.len() {
        f64::NAN
    } else {
        0.0
    }
}

/// True when a finite relevance is below the hydration floor. `NaN` stays.
#[must_use]
pub fn relevance_below_threshold(relevance: f64, threshold: f64) -> bool {
    relevance < threshold
}

/// Format of the hydration rejection reason.
///
/// JavaScript `(NaN).toFixed(3)` is the string `NaN`. The threshold is printed with
/// its ordinary number text (`0.25`), not `toFixed`.
#[must_use]
pub fn relevance_reason(relevance: f64, threshold: f64) -> String {
    let rendered = if relevance.is_finite() {
        format!("{relevance:.3}")
    } else {
        "NaN".to_owned()
    };
    format!("relevance {rendered} below threshold {threshold}")
}

/// Ids reachable from `seeds` within the default depth, capped like the pipeline.
#[must_use]
pub fn reachable_endpoint_ids(edges: &[GraphEdge], seeds: &[String]) -> Vec<String> {
    let inspected = edges.iter().take(GRAPH_ACL_MAX_INSPECTED_EDGES);
    let mut adjacency: std::collections::HashMap<&str, Vec<&str>> =
        std::collections::HashMap::new();
    for edge in inspected {
        if edge.source.is_empty() || edge.target.is_empty() {
            continue;
        }
        adjacency
            .entry(edge.source.as_str())
            .or_default()
            .push(edge.target.as_str());
        if !edge.directed {
            adjacency
                .entry(edge.target.as_str())
                .or_default()
                .push(edge.source.as_str());
        }
    }
    let mut reachable = Vec::new();
    for seed in seeds.iter().take(GRAPH_ACL_MAX_ENDPOINT_IDS) {
        if !reachable.iter().any(|id: &String| id == seed) {
            reachable.push(seed.clone());
        }
    }
    let mut frontier = reachable.clone();
    for _depth in 0..MAX_DEPTH.min(GRAPH_ACL_MAX_ENDPOINT_IDS) {
        if frontier.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for current in &frontier {
            for neighbor in adjacency.get(current.as_str()).into_iter().flatten() {
                if reachable.iter().any(|id| id == *neighbor) {
                    continue;
                }
                if reachable.len() >= GRAPH_ACL_MAX_ENDPOINT_IDS {
                    continue;
                }
                reachable.push((*neighbor).to_owned());
                next.push((*neighbor).to_owned());
            }
        }
        frontier = next;
    }
    reachable
}

/// Edges whose endpoints are both in `allowed`.
#[must_use]
pub fn edges_between(edges: &[GraphEdge], allowed: &[String]) -> Vec<GraphEdge> {
    edges
        .iter()
        .filter(|edge| {
            allowed.iter().any(|id| id == &edge.source)
                && allowed.iter().any(|id| id == &edge.target)
        })
        .cloned()
        .collect()
}

/// Beam search. Seeds at depth 0 are not results. The returned score is uncapped.
#[must_use]
pub fn traverse(seeds: &[(String, f64)], edges: &[GraphEdge]) -> Vec<AssociativeHit> {
    let adjacency = adjacency_of(edges);
    let mut visited = Vec::new();
    let mut results = Vec::new();
    let mut queue = Vec::new();
    for (memory_id, score) in seeds.iter().take(SEED_COUNT) {
        if memory_id.is_empty() {
            continue;
        }
        queue.push(Queued {
            memory_id: memory_id.clone(),
            score: nonzero(*score, 0.5),
            cumulative: 1.0,
            depth: 0,
        });
    }
    while !queue.is_empty()
        && visited.len() < MAX_VISITED_NODES
        && results.len() < MAX_ASSOCIATED_RESULTS
    {
        queue.sort_by(|left, right| right.score.total_cmp(&left.score));
        let Some(current) = queue.first().cloned() else {
            break;
        };
        queue.remove(0);
        if visited.iter().any(|id: &String| id == &current.memory_id) {
            continue;
        }
        visited.push(current.memory_id.clone());
        if current.depth > 0 {
            let depth_penalty = 1.0 / (1.0 + current.depth as f64 * 0.5);
            let associated_score = nonzero(current.score, 0.5) * current.cumulative * depth_penalty;
            results.push(AssociativeHit {
                memory_id: current.memory_id.clone(),
                associated_score,
                depth: current.depth,
            });
        }
        if current.depth >= MAX_DEPTH {
            continue;
        }
        let Some(neighbors) = adjacency.get(&current.memory_id) else {
            continue;
        };
        let mut ordered = neighbors.clone();
        ordered.sort_by(|left, right| right.strength.total_cmp(&left.strength));
        for edge in ordered.into_iter().take(MAX_NEIGHBORS_PER_NODE) {
            if visited.iter().any(|id| id == &edge.target) {
                continue;
            }
            let strength = nonzero(edge.strength, 0.1);
            let next_cumulative = current.cumulative * strength;
            let threshold = MIN_CUMULATIVE_RELEVANCE
                * (1.0 + (current.depth + 1) as f64 * DEPTH_RELEVANCE_SCALE);
            if next_cumulative < threshold {
                continue;
            }
            queue.push(Queued {
                memory_id: edge.target,
                score: current.score,
                cumulative: next_cumulative,
                depth: current.depth + 1,
            });
        }
    }
    results
}

/// Cap a graph-only score under the best vector score, or scale it when there is no anchor.
#[must_use]
pub fn cap_graph_score(raw: f64, max_vector_score: f64) -> f64 {
    if max_vector_score > 0.0 {
        raw.min(max_vector_score * GRAPH_ANCHOR_CAP)
    } else {
        raw * GRAPH_NO_ANCHOR_SCALE
    }
}

/// Cosine used after a re-embed, when the stored vector length did not match.
#[must_use]
pub fn reembedded_relevance(query: &[f32], embedded: &[f32]) -> f64 {
    cosine_similarity(query, embedded)
}

fn adjacency_of(edges: &[GraphEdge]) -> std::collections::HashMap<String, Vec<Link>> {
    let mut by_key: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut unique: Vec<&GraphEdge> = Vec::new();
    for edge in edges {
        if edge.source.is_empty() || edge.target.is_empty() {
            continue;
        }
        let key = format!(
            "{}:unbound",
            canonical_key(&edge.source, &edge.target, &edge.kind, edge.directed)
        );
        if let Some(index) = by_key.get(&key).copied() {
            if edge.strength > unique[index].strength {
                unique[index] = edge;
            }
        } else {
            by_key.insert(key, unique.len());
            unique.push(edge);
        }
    }
    let mut adjacency: std::collections::HashMap<String, Vec<Link>> =
        std::collections::HashMap::new();
    // Node's Map retains the first insertion position when a stronger edge replaces
    // a duplicate. Keep that order so strength ties select the same eight neighbours.
    for edge in unique {
        adjacency
            .entry(edge.source.clone())
            .or_default()
            .push(Link {
                target: edge.target.clone(),
                strength: edge.strength,
            });
        if !edge.directed {
            adjacency
                .entry(edge.target.clone())
                .or_default()
                .push(Link {
                    target: edge.source.clone(),
                    strength: edge.strength,
                });
        }
    }
    adjacency
}

fn canonical_key(source: &str, target: &str, kind: &str, directed: bool) -> String {
    if directed {
        return format!("{source}:{target}:{kind}");
    }
    if source <= target {
        format!("{source}:{target}:{kind}")
    } else {
        format!("{target}:{source}:{kind}")
    }
}

fn nonzero(value: f64, fallback: f64) -> f64 {
    if value == 0.0 || value.is_nan() {
        fallback
    } else {
        value
    }
}
