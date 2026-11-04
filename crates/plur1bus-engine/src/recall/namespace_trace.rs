//! Stable, bounded replay of child trace streams into the namespace master.
//! Trace collection, timing and secret redaction are owned by RE-04/T6.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Merge-owned trace streams. Opaque fields survive replay without exposing store text.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NamespaceTrace {
    /// Candidate observations.
    pub candidates: Vec<Value>,
    /// Inclusion, rejection and deduplication decisions.
    pub decisions: Vec<Value>,
    /// Guard outcomes.
    pub guards: Vec<Value>,
    /// Store decisions.
    pub store_decisions: Vec<Value>,
}

/// Stream caps, matching the Node trace defaults. Zero normalizes to one.
#[derive(Clone, Copy, Debug)]
pub struct TraceLimits {
    /// Candidate suffix cap.
    pub candidates: usize,
    /// Decision suffix cap.
    pub decisions: usize,
    /// Guard suffix cap.
    pub guards: usize,
    /// Store-decision suffix cap.
    pub store_decisions: usize,
}
impl Default for TraceLimits {
    fn default() -> Self {
        Self {
            candidates: 50,
            decisions: 200,
            guards: 200,
            store_decisions: 100,
        }
    }
}

struct Bucket {
    phase: &'static str,
    namespace: Option<String>,
    entries: Vec<Value>,
}
pub(crate) struct Replay {
    trace: NamespaceTrace,
    buckets: Vec<Bucket>,
    limits: TraceLimits,
}
impl Replay {
    pub(crate) fn new(limits: TraceLimits) -> Self {
        Self {
            trace: NamespaceTrace::default(),
            buckets: Vec::new(),
            limits,
        }
    }

    pub(crate) fn children(&mut self, sources: &[(Option<String>, &NamespaceTrace)]) {
        for field in 0..4 {
            let streams = sources
                .iter()
                .map(|(namespace, trace)| {
                    let values = match field {
                        0 => &trace.candidates,
                        1 => &trace.decisions,
                        2 => &trace.guards,
                        _ => &trace.store_decisions,
                    };
                    values
                        .iter()
                        .filter_map(|entry| {
                            let mut tagged = entry.as_object()?.clone();
                            tagged.remove("namespace");
                            if let Some(namespace) = namespace {
                                tagged.insert("namespace".into(), json!(namespace));
                            }
                            Some(Value::Object(tagged))
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            for entry in fair(&streams) {
                match field {
                    0 => self.trace.candidates.push(entry),
                    1 => {
                        let namespace = entry["namespace"].as_str().map(str::to_owned);
                        self.push("child", namespace, entry);
                    }
                    2 => self.trace.guards.push(entry),
                    _ => self.trace.store_decisions.push(entry),
                }
            }
        }
    }

    pub(crate) fn decision(
        &mut self,
        namespace: Option<String>,
        id: String,
        stage: &str,
        reason: String,
    ) {
        let mut entry = json!({"action":"deduped","stage":stage});
        entry["memoryId"] = Value::String(id);
        entry["reason"] = Value::String(reason);
        if let Some(namespace) = &namespace {
            entry["namespace"] = json!(namespace);
        }
        self.push("global", namespace, entry);
    }

    fn push(&mut self, phase: &'static str, namespace: Option<String>, entry: Value) {
        let index = self
            .buckets
            .iter()
            .position(|bucket| bucket.phase == phase && bucket.namespace == namespace);
        let index = index.unwrap_or_else(|| {
            self.buckets.push(Bucket {
                phase,
                namespace,
                entries: Vec::new(),
            });
            self.buckets.len() - 1
        });
        self.buckets[index].entries.push(entry);
        cap(&mut self.buckets[index].entries, self.limits.decisions);
    }

    pub(crate) fn finish(mut self) -> NamespaceTrace {
        let streams = self
            .buckets
            .into_iter()
            .map(|bucket| bucket.entries)
            .collect::<Vec<_>>();
        self.trace.decisions = fair(&streams);
        cap(&mut self.trace.candidates, self.limits.candidates);
        cap(&mut self.trace.decisions, self.limits.decisions);
        cap(&mut self.trace.guards, self.limits.guards);
        cap(&mut self.trace.store_decisions, self.limits.store_decisions);
        self.trace
    }
}

fn fair(streams: &[Vec<Value>]) -> Vec<Value> {
    let width = streams.iter().map(Vec::len).max().unwrap_or(0);
    let mut out = Vec::new();
    for distance in (1..=width).rev() {
        for stream in streams {
            if let Some(index) = stream.len().checked_sub(distance) {
                out.push(stream[index].clone()); // Replay retains each child's unchanged record.
            }
        }
    }
    out
}
fn cap(values: &mut Vec<Value>, limit: usize) {
    let excess = values.len().saturating_sub(limit.max(1));
    if excess > 0 {
        values.drain(..excess);
    }
}
