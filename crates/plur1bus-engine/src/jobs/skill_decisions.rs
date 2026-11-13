//! The plugin-line v7.18.31 Skill Miner decision cache, over the existing run-state file.
use super::{ledger::json::node_value, metadata::get, rate_limit::RateLimitStore};
use crate::{
    contract::{Cancel, EngineError, MemoryRow, StoreError},
    text::{
        js::{locale_compare, JsString},
        json::{write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};

const VERSION: u8 = 2;
const TTL_MS: f64 = 7. * 86_400_000.;
const MAX_DECISIONS: usize = 300;
const KEY: &str = "skillMinerClusterMemo";

/// Provider and selection policy captured when the evidence is prepared.
pub struct Policy<'a> {
    /// Resolved model id.
    pub model: &'a str,
    /// Resolved route kind.
    pub kind: &'a str,
    /// Resolved base URL, with no credentials.
    pub base_url: &'a str,
    /// Exact prompt version; empty uses extraction prompt v3.
    pub prompt_version: &'a str,
    /// Configured extraction threshold.
    pub min_confidence: Option<f64>,
    /// Configured evidence threshold.
    pub min_evidence_score: Option<f64>,
    /// Ordered catalogue digest.
    pub catalogue: &'a str,
}

/// A selected source row and its explicit contradiction flag from evidence aggregation.
pub struct Evidence<'a> {
    /// Original ACL-checked row.
    pub row: &'a MemoryRow,
    /// Whether the source was marked contradictory during selection.
    pub contradictory: bool,
}

/// An input hash. The cache persists neither source text nor provider credentials.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Fingerprint(String);

impl Fingerprint {
    /// Hash authorized rows and the extraction policy with the pin's Node sort and JSON shape.
    #[must_use]
    pub fn for_cluster(rows: &[Evidence<'_>], policy: &Policy<'_>) -> Self {
        let mut tuples: Vec<_> = rows
            .iter()
            .map(|evidence| {
                let row = evidence.row;
                let tuple = Json::Array(vec![
                    text(&row.id),
                    text(&row.text),
                    text(&row.epistemic_status),
                    text(&row.category),
                    text(&row.source_message_role),
                    Json::Bool(evidence.contradictory),
                    Json::Bool(
                        row.retrieval_count
                            .as_f64()
                            .is_some_and(|count| count >= 3.),
                    ),
                ]);
                (&row.id, write_json(&tuple))
            })
            .collect();
        tuples.sort_by(|left, right| {
            locale_compare(left.0, right.0).then_with(|| locale_compare(&left.1, &right.1))
        });
        let policy = Json::Array(vec![
            text(policy.model),
            text(policy.kind),
            text(policy.base_url),
            text(if policy.prompt_version.is_empty() {
                "3"
            } else {
                policy.prompt_version
            }),
            number(policy.min_confidence.unwrap_or(0.6)),
            number(policy.min_evidence_score.unwrap_or(3.)),
            text(policy.catalogue),
        ]);
        let memories = tuples
            .into_iter()
            .map(|(_, tuple)| tuple)
            .collect::<Vec<_>>()
            .join(",");
        let material = format!("[{VERSION},[{memories}],{}]", write_json(&policy));
        let digest = format!("{:x}", Sha256::digest(material.as_bytes()));
        Self(digest[..24].to_owned())
    }

    /// The Node-compatible 24-character key.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Only terminal negative decisions can enter the cache. Retryable errors are absent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Decision {
    /// The model or configured confidence threshold declined the cluster.
    LowConfidence,
    /// The proposed skill name is blocked.
    BlockedName,
    /// The evidence matches an existing skill.
    Duplicate,
}

impl Decision {
    fn label(self) -> &'static str {
        match self {
            Self::LowConfidence => "low_confidence",
            Self::BlockedName => "blocked_name",
            Self::Duplicate => "duplicate",
        }
    }

    fn from_value(value: &Json) -> Option<Self> {
        [Self::LowConfidence, Self::BlockedName, Self::Duplicate]
            .into_iter()
            .find(|decision| *value == text(decision.label()))
    }
}

/// Bound memo access to the existing caller-selected partition and run-state writer.
/// A partition hash is a namespace only. The job must authenticate the data first.
pub struct Memo<'a> {
    state: &'a RateLimitStore,
    partition_id: &'a str,
}

impl<'a> Memo<'a> {
    /// Use the plugin-line's 32-hex scan state id for this authenticated partition.
    pub fn new(state: &'a RateLimitStore, partition_id: &'a str) -> Result<Self, EngineError> {
        if partition_id.len() != 32 || !partition_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(Self {
            state,
            partition_id,
        })
    }

    /// Read a v2 decision strictly before its seven-day expiry. Reads create no files.
    pub fn get(
        &self,
        fingerprint: &Fingerprint,
        now: f64,
        cancel: &Cancel,
    ) -> Result<Option<Decision>, EngineError> {
        let state = self.state.snapshot(cancel)?;
        let cached = state
            .as_ref()
            .and_then(|state| get(state, KEY))
            .and_then(|memos| get(memos, self.partition_id))
            .and_then(|entries| get(entries, fingerprint.as_str()));
        Ok(cached.and_then(|entry| reusable(entry, now)))
    }

    /// Record terminal outcomes in one atomic publication. An empty batch writes nothing.
    pub fn record(
        &self,
        entries: &[(Fingerprint, Decision)],
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if entries.is_empty() {
            return Ok(());
        }
        if entries.len() > MAX_DECISIONS {
            return Err(StoreError::InvalidInput.into());
        }
        self.state.update(cancel, |before, now| {
            if !now.is_finite() {
                return Err(StoreError::InvalidInput.into());
            }
            let mut state = object(before)?;
            let mut memos = object(get_from(&state, KEY))?;
            let mut partition = object(get_from(&memos, self.partition_id))?;
            for (fingerprint, decision) in entries {
                cancel.check()?;
                set(
                    &mut partition,
                    fingerprint.as_str(),
                    Json::Object(vec![
                        ("reason".into(), text(decision.label())),
                        ("at".into(), number(now)),
                        ("version".into(), Json::Number(VERSION.to_string())),
                    ]),
                );
            }
            partition.sort_by(|(_, a), (_, b)| timestamp(b).total_cmp(&timestamp(a)));
            partition.truncate(MAX_DECISIONS);
            set(&mut memos, self.partition_id, Json::Object(partition));
            set(&mut state, KEY, Json::Object(memos));
            Ok(node_value(Json::Object(state)))
        })
    }
}

fn reusable(entry: &Json, now: f64) -> Option<Decision> {
    let at = get(entry, "at").and_then(finite)?;
    if get(entry, "version").and_then(finite) == Some(f64::from(VERSION))
        && at <= now
        && now - at < TTL_MS
    {
        return get(entry, "reason").and_then(Decision::from_value);
    }
    None
}
fn timestamp(entry: &Json) -> f64 {
    get(entry, "at").and_then(finite).unwrap_or(0.)
}
fn finite(value: &Json) -> Option<f64> {
    let Json::Number(value) = value else {
        return None;
    };
    value.parse::<f64>().ok().filter(|value| value.is_finite())
}
fn number(value: f64) -> Json {
    if value.is_finite() {
        Json::Number(ryu_js::Buffer::new().format_finite(value).into())
    } else {
        Json::Null
    }
}
fn text(value: &str) -> Json {
    Json::String(value.into())
}
type Fields = Vec<(JsString, Json)>;

fn object(value: Option<&Json>) -> Result<Fields, EngineError> {
    match value {
        None | Some(Json::Null) => Ok(Vec::new()),
        Some(Json::Object(fields)) => Ok(fields.clone()),
        _ => Err(StoreError::Corrupt.into()),
    }
}
fn get_from<'a>(fields: &'a Fields, key: &str) -> Option<&'a Json> {
    fields
        .iter()
        .find(|(name, _)| *name == key.into())
        .map(|(_, value)| value)
}
fn set(fields: &mut Fields, key: &str, value: Json) {
    if let Some((_, old)) = fields.iter_mut().find(|(name, _)| *name == key.into()) {
        *old = value;
    } else {
        fields.push((key.into(), value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::row_defaults::schema_defaults;
    use serde_json::{json, Value};
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };

    fn golden() -> Value {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/jobs/skill-decisions.json"
        ))
        .unwrap()
    }

    #[test]
    fn fingerprint_matches_node_for_duplicate_ids_and_changed_prompt_versions() {
        let fixture = golden();
        let rows: Vec<_> = fixture["memories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|input| {
                let mut row = schema_defaults(Vec::new());
                row.id = input["id"].as_str().unwrap().into();
                row.text = input["text"].as_str().unwrap().into();
                row.epistemic_status = input["epistemicStatus"].as_str().unwrap_or("").into();
                row.category = input["category"].as_str().unwrap_or("").into();
                row.source_message_role = input["sourceMessageRole"].as_str().unwrap_or("").into();
                row.retrieval_count = input["retrievalCount"].as_u64().unwrap_or(0).into();
                (row, input["contradictory"] == true)
            })
            .collect();
        let mut evidence: Vec<_> = rows
            .iter()
            .map(|(row, contradictory)| Evidence {
                row,
                contradictory: *contradictory,
            })
            .collect();
        let mut policy = Policy {
            model: "fixture",
            kind: "host",
            base_url: "",
            prompt_version: "",
            min_confidence: Some(0.6),
            min_evidence_score: Some(3.),
            catalogue: "digest",
        };
        let actual = Fingerprint::for_cluster(&evidence, &policy);
        assert_eq!(Some(actual.as_str()), fixture["fingerprint"].as_str());
        evidence.reverse();
        assert_eq!(Fingerprint::for_cluster(&evidence, &policy), actual);
        policy.prompt_version = "4";
        assert_eq!(
            Some(Fingerprint::for_cluster(&evidence, &policy).as_str()),
            fixture["newTemplateFingerprint"].as_str()
        );
    }

    #[test]
    fn reuse_matches_node_at_every_expiry_boundary() {
        for case in golden()["lookups"].as_array().unwrap() {
            let entry = crate::text::json::parse_json(&case["entry"].to_string()).unwrap();
            assert_eq!(
                reusable(&entry, case["now"].as_f64().unwrap()).is_some(),
                case["reusable"].as_bool().unwrap()
            );
        }
    }

    #[test]
    fn memo_preserves_other_run_state_and_publishes_only_terminal_decisions() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let clock = Arc::new(AtomicU64::new(1_768_305_600_000));
        let time = clock.clone();
        let state = RateLimitStore::open(
            temp.path(),
            Arc::new(move || time.load(Ordering::Acquire) as f64),
        )
        .unwrap();
        let partition = "1234567890abcdef1234567890abcdef";
        let other = "0234567890abcdef1234567890abcdef";
        let memo = Memo::new(&state, partition).unwrap();
        let cancel = Cancel::never();
        memo.record(&[], &cancel).unwrap();
        let file = temp.path().join("run-state.json");
        assert!(!file.exists());
        std::fs::write(&file, json!({"jobRateLimits":{"legacy":{"runCount":2}},
            "skillMinerClusterMemo":{other:{"legacy":{"reason":"duplicate","at":1_768_305_600_000_u64,"version":1}}}}).to_string()).unwrap();
        let fingerprint = Fingerprint("a".repeat(24));
        memo.record(&[(fingerprint.clone(), Decision::BlockedName)], &cancel)
            .unwrap();
        let now = clock.load(Ordering::Acquire) as f64;
        assert_eq!(
            memo.get(&fingerprint, now, &cancel).unwrap(),
            Some(Decision::BlockedName)
        );
        assert_eq!(
            Memo::new(&state, other)
                .unwrap()
                .get(&fingerprint, now, &cancel)
                .unwrap(),
            None
        );
        assert_eq!(memo.get(&fingerprint, now + TTL_MS, &cancel).unwrap(), None);
        let value: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
        assert_eq!(value["jobRateLimits"]["legacy"]["runCount"], 2);
        assert_eq!(value[KEY][other]["legacy"]["version"], 1);
        assert_eq!(value[KEY][partition][fingerprint.as_str()]["version"], 2);
    }
}
