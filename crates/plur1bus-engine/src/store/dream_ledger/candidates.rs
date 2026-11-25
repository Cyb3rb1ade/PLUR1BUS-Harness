//! ADR-009 candidate observations and the durable promotion-gate decisions.

use std::collections::HashMap;

use icu_normalizer::ComposingNormalizerBorrowed;
use plur1bus_log_schema::redact::js_number_string;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{Cancel, EngineError, StoreError};

const TTL_MS: i64 = 72 * 60 * 60 * 1000;
const MAX_OBSERVATIONS: usize = 1_000;
const MAX_CONTENT_BYTES: usize = 64 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Prepare {
    pub(super) run_id: String,
    observations: Vec<Observation>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    content: String,
    memory_id: Option<String>,
    recalls: Option<i64>,
    unique_queries: Option<i64>,
    score: Option<f64>,
    created_at: Option<f64>,
    importance: Option<f64>,
    repetitions: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FallbackInput {
    created_at: Option<f64>,
    importance: Option<f64>,
    repetitions: Option<f64>,
}

impl Prepare {
    pub(super) fn valid(&self) -> bool {
        self.observations.len() <= MAX_OBSERVATIONS
            && self.observations.iter().all(|item| {
                item.content.len() <= MAX_CONTENT_BYTES
                    && item.memory_id.as_ref().is_none_or(|id| {
                        !id.is_empty()
                            && id.chars().count() <= 256
                            && !id.chars().any(char::is_control)
                    })
                    && item
                        .recalls
                        .is_none_or(|count| (0..=9_007_199_254_740_991).contains(&count))
                    && item
                        .unique_queries
                        .is_none_or(|count| (0..=9_007_199_254_740_991).contains(&count))
                    && item.score.is_none_or(f64::is_finite)
            })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    expires_at: i64,
    recalls: i64,
    unique_queries: i64,
    score: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thresholds {
    min_score: f64,
    min_recall_count: i64,
    min_unique_queries: i64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            min_score: 0.75,
            min_recall_count: 3,
            min_unique_queries: 3,
        }
    }
}

fn content_hash(text: &str) -> String {
    let normalized = ComposingNormalizerBorrowed::new_nfc().normalize(text);
    format!(
        "{:x}",
        Sha256::digest(crate::text::js::js_trim(&normalized).as_bytes())
    )
}

fn result(gate: &str, passed: bool, reason: impl FnOnce() -> String) -> Value {
    if passed {
        json!({"gate":gate,"passed":true})
    } else {
        json!({"gate":gate,"passed":false,"detail":reason()})
    }
}

fn evaluate(c: &Candidate, now: i64, g: &Thresholds) -> Value {
    let gates = [
        result("expiry", c.expires_at > now, || {
            format!("expired at {}", c.expires_at)
        }),
        result("utility", c.recalls > 0, || "recalls = 0".to_owned()),
        result("recall-count", c.recalls >= g.min_recall_count, || {
            format!("{} < {}", c.recalls, g.min_recall_count)
        }),
        result(
            "unique-queries",
            c.unique_queries >= g.min_unique_queries,
            || format!("{} < {}", c.unique_queries, g.min_unique_queries),
        ),
        result(
            "score",
            c.score.is_none_or(|score| score >= g.min_score),
            || {
                format!(
                    "{} < {}",
                    c.score.map(js_number_string).unwrap_or_default(),
                    js_number_string(g.min_score)
                )
            },
        ),
    ];
    let rejected = gates
        .iter()
        .find(|gate| gate["passed"] == false)
        .and_then(|gate| gate["gate"].as_str());
    json!({"promote":rejected.is_none(),"rejectedBy":rejected,"gates":gates,"at":now})
}

fn fallback(input: &FallbackInput, now: i64) -> Value {
    let age = input
        .created_at
        .is_some_and(|at| at.is_finite() && at >= 0.0 && now as f64 - at >= 86_400_000.0);
    let importance = input
        .importance
        .is_some_and(|value| value.is_finite() && value >= 0.75);
    let repetition = input.repetitions.is_some_and(|value| {
        value.fract() == 0.0 && (2.0..=9_007_199_254_740_991.0).contains(&value)
    });
    json!({"eligible":age && (importance || repetition),"age":age,"importance":importance,"repetition":repetition})
}

pub(super) fn prepare(
    db: &Connection,
    agent: &str,
    phase: &str,
    request: &Prepare,
    now: i64,
    cancel: &Cancel,
    response_bytes: usize,
) -> Result<Option<Value>, EngineError> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS dream_candidate_preparation (
            run_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS dream_candidate_preparation_finished
          AFTER UPDATE OF outcome ON dream_run WHEN NEW.outcome IS NOT NULL BEGIN
            DELETE FROM dream_candidate_preparation WHERE run_id = NEW.run_id;
          END;
        CREATE TRIGGER IF NOT EXISTS dream_candidate_preparation_removed
          AFTER DELETE ON dream_run BEGIN
            DELETE FROM dream_candidate_preparation WHERE run_id = OLD.run_id;
          END;",
    )
    .map_err(StoreError::from)?;
    let bytes = serde_json::to_vec(request).map_err(|_| StoreError::InvalidInput)?;
    let fingerprint = format!("{:x}", Sha256::digest(bytes));
    let existing = db
        .query_row(
            "SELECT fingerprint,result_json FROM dream_candidate_preparation WHERE run_id=?1",
            [&request.run_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(StoreError::from)?;
    if let Some((saved, result)) = existing {
        return if saved != fingerprint {
            Ok(None)
        } else {
            check_response_size(&result, response_bytes)?;
            Ok(Some(
                serde_json::from_str(&result).map_err(|_| StoreError::Corrupt)?,
            ))
        };
    }
    let result = prepare_once(db, agent, phase, request, now, cancel)?;
    let serialized = result.to_string();
    check_response_size(&serialized, response_bytes)?;
    db.execute(
        "INSERT INTO dream_candidate_preparation (run_id,fingerprint,result_json) VALUES (?1,?2,?3)",
        params![request.run_id, fingerprint, serialized],
    ).map_err(StoreError::from)?;
    Ok(Some(result))
}

fn check_response_size(result: &str, budget: usize) -> Result<(), EngineError> {
    if result.len() <= budget {
        Ok(())
    } else {
        Err(EngineError::NotAvailable {
            reason: "dream-candidate-response-too-large".into(),
        })
    }
}

fn prepare_once(
    db: &Connection,
    agent: &str,
    phase: &str,
    request: &Prepare,
    now: i64,
    cancel: &Cancel,
) -> Result<Value, EngineError> {
    let mut current = HashMap::new();
    let mut inserted = 0;
    for item in &request.observations {
        cancel.check()?;
        let hash = content_hash(&item.content);
        let changed = db.execute(
            "INSERT INTO dream_candidate (candidate_id,agent_id,partition,content_hash,source_run_id,first_seen_at,expires_at,recalls,unique_queries,score,state)
             VALUES (?1,?2,'agent-private',?3,?4,?5,?6,?7,?8,?9,'shortlisted')
             ON CONFLICT(agent_id,partition,content_hash) DO NOTHING",
            params![uuid::Uuid::new_v4().to_string(), agent, hash, request.run_id, now, now.saturating_add(TTL_MS),
                item.recalls.unwrap_or(0), item.unique_queries.unwrap_or(0), item.score],
        ).map_err(StoreError::from)?;
        inserted += changed;
        if changed == 0 {
            db.execute(
                "UPDATE dream_candidate SET recalls=?1,unique_queries=?2,score=?3
                 WHERE agent_id=?4 AND content_hash=?5 AND partition='agent-private' AND state='shortlisted'",
                params![item.recalls.unwrap_or(0), item.unique_queries.unwrap_or(0), item.score, agent, hash],
            ).map_err(StoreError::from)?;
        }
        current.insert(hash, item);
    }
    cancel.check()?;
    let expired = db
        .execute(
            "UPDATE dream_candidate SET state='expired', decision_json=?1
         WHERE agent_id=?2 AND state='shortlisted' AND expires_at <= ?3",
            params![
                json!({"gate":"expiry","passed":false,"at":now}).to_string(),
                agent,
                now
            ],
        )
        .map_err(StoreError::from)?;

    let mut select = db
        .prepare(
            "SELECT candidate_id,partition,content_hash,expires_at,recalls,unique_queries,score
         FROM dream_candidate WHERE agent_id=?1 AND state='shortlisted'
         ORDER BY first_seen_at,candidate_id LIMIT ?2",
        )
        .map_err(StoreError::from)?;
    let mut rows = select
        .query(params![agent, MAX_OBSERVATIONS as i64])
        .map_err(StoreError::from)?;
    let thresholds = Thresholds::default();
    let mut prepared = Vec::new();
    let mut rejected = 0;
    let mut eligible = Vec::new();
    while let Some(row) = rows.next().map_err(StoreError::from)? {
        cancel.check()?;
        let field = |index| row.get::<_, String>(index).map_err(StoreError::from);
        let id = field(0)?;
        let partition = field(1)?;
        let hash = field(2)?;
        let candidate = Candidate {
            expires_at: row.get(3).map_err(StoreError::from)?,
            recalls: row.get(4).map_err(StoreError::from)?,
            unique_queries: row.get(5).map_err(StoreError::from)?,
            score: row.get(6).map_err(StoreError::from)?,
        };
        let mut decision = evaluate(&candidate, now, &thresholds);
        if decision["promote"] == false {
            rejected += 1;
        }
        if let Some(item) = current.get(&hash).filter(|_| partition == "agent-private") {
            if item.recalls.is_none() || item.unique_queries.is_none() {
                decision["fallback"] = fallback(
                    &FallbackInput {
                        created_at: item.created_at,
                        importance: item.importance,
                        repetitions: item.repetitions,
                    },
                    now,
                );
            }
            if let Some(memory) = item
                .memory_id
                .as_ref()
                .filter(|_| phase == "deep" && decision["promote"] == true)
            {
                eligible.push(json!({"candidateId":id,"memoryId":memory}));
            }
        }
        prepared.push((id, decision));
    }
    drop(rows);
    let mut update = db
        .prepare(
            "UPDATE dream_candidate SET decision_json=?1 WHERE candidate_id=?2 AND agent_id=?3",
        )
        .map_err(StoreError::from)?;
    for (id, decision) in prepared {
        cancel.check()?;
        update
            .execute(params![decision.to_string(), id, agent])
            .map_err(StoreError::from)?;
    }
    Ok(json!({"counts":{
        "candidates":inserted,"deduped":request.observations.len()-inserted,"expired":expired,"rejected":rejected
    },"eligible":eligible}))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn recorded_candidate_gates_match_typescript() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../fixtures/parity/dreams/candidates.json"
        ))
        .unwrap();
        for row in fixture["gates"].as_array().unwrap() {
            let input = serde_json::from_value(row["input"].clone()).unwrap();
            let config = serde_json::from_value(row["config"].clone()).unwrap();
            let now = row["now"].as_i64().unwrap();
            assert_eq!(
                evaluate(&input, now, &config),
                row["result"],
                "{}",
                row["name"]
            );
        }
        for row in fixture["fallback"].as_array().unwrap() {
            let input = serde_json::from_value(row["input"].clone()).unwrap();
            assert_eq!(
                fallback(&input, row["now"].as_i64().unwrap()),
                row["result"],
                "{}",
                row["name"]
            );
        }
        for row in fixture["hashes"].as_array().unwrap() {
            assert_eq!(content_hash(row["text"].as_str().unwrap()), row["hash"]);
        }
    }
}
