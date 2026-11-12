//! Exact actual Node lane scores and deterministic selection.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Principal},
    neo::{
        merged::Record,
        routing::{self, Options},
    },
    text::json::{parse_json, write_json},
};
use serde_json::{json, Value};
fn context(host: &support::TestHost) -> RequestContext {
    let p: Principal=serde_json::from_value(json!({"agentId":"alpha","workspace":"workspace:v1:one","channel":"telegram","accountId":"fixture-account","chat":{"id":"fixture-chat","kind":"direct"},"trust":"proved"})).unwrap();
    let a: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    RequestContext::build(&p, &a, host).unwrap()
}

// Preserve Node's shortest decimal round-trip. serde_json without float_roundtrip
// rounds some 17-digit golden decimals to the adjacent f64 during initial parsing.
fn exact_json(raw: &str) -> Value {
    use plur1bus_engine::text::json::TolerantJsonValue as J;
    fn convert(v: J) -> Value {
        match v {
            J::Null => Value::Null,
            J::Bool(v) => json!(v),
            J::String(v) => json!(v.to_utf8_lossy()),
            J::Number(n) => {
                if let Ok(v) = n.parse::<i64>() {
                    return json!(v);
                }
                if let Ok(v) = n.parse::<u64>() {
                    return json!(v);
                }
                json!(n.parse::<f64>().unwrap())
            }
            J::Array(v) => Value::Array(v.into_iter().map(convert).collect()),
            J::Object(v) => Value::Object(
                v.into_iter()
                    .map(|(k, v)| (k.to_utf8_lossy(), convert(v)))
                    .collect(),
            ),
        }
    }
    convert(parse_json(raw).unwrap())
}
#[test]
fn scores_routes_and_global_text_dedupe_match_actual_node() {
    let f = exact_json(include_str!("fixtures/capture/golden/neo-routing.json"));
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    for c in f["cases"].as_array().unwrap() {
        let records: Vec<_> = c["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| Record {
                metadata: parse_json(&v.to_string()).unwrap(),
                embedding: v
                    .get("embedding")
                    .map(|e| serde_json::from_value(e.clone()).unwrap()),
            })
            .collect();
        let query = c["prompt"].as_str().unwrap();
        let vector: Option<Vec<f64>> = serde_json::from_value(c["queryVector"].clone()).unwrap();
        for lane in c["scores"].as_array().unwrap() {
            for (item, expected) in records.iter().zip(lane["values"].as_array().unwrap()) {
                let score = routing::score(
                    item,
                    query,
                    lane["lane"].as_str().unwrap(),
                    vector.as_deref(),
                );
                if expected.is_null() {
                    assert!(!score.is_finite(), "{}", c["name"]);
                } else {
                    assert_eq!(
                        score,
                        expected.as_f64().unwrap(),
                        "{} / {}",
                        c["name"],
                        lane["lane"]
                    );
                }
            }
        }
        let mut lanes = routing::route(
            &records,
            query,
            &ctx,
            &Options {
                max_per_lane: 2,
                min_score: c["minScore"].as_f64().unwrap(),
                query_vector: vector.as_deref(),
            },
        );
        let project = |lanes: &[routing::Lane]| -> Value {
            Value::Object(lanes.iter().map(|lane|(lane.name.to_owned(),Value::Array(lane.hits.iter().map(|hit|json!({"item":serde_json::from_str::<Value>(&write_json(&records[hit.index].metadata)).unwrap(),"score":hit.score})).collect()))).collect())
        };
        assert_eq!(project(&lanes), c["lanes"], "{}", c["name"]);
        let exclude: Vec<String> = serde_json::from_value(c["exclude"].clone()).unwrap();
        let only_ids: Option<Vec<String>> = c
            .get("onlyIds")
            .map(|v| serde_json::from_value(v.clone()).unwrap());
        let dropped = routing::dedupe(
            &mut lanes,
            &records,
            &exclude,
            only_ids.as_deref(),
            c["threshold"].as_f64().unwrap_or(0.8),
        );
        assert_eq!(
            dropped,
            c["deduped"]["dropped"].as_u64().unwrap() as usize,
            "{}",
            c["name"]
        );
        assert_eq!(project(&lanes), c["deduped"]["lanes"], "{}", c["name"]);
    }
}

#[test]
fn actual_file_records_are_reauthorized_at_routing_and_newer_hidden_revisions_win() {
    use plur1bus_engine::neo::merged::{Layout, MetadataReader, RecordKind};
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = root
        .path()
        .join("workspaces")
        .join(Layout::for_key("workspace").canonical);
    std::fs::create_dir_all(&dir).unwrap();
    let own =
        json!({"id":"a","agentId":"alpha","statement":"green memory workspace","createdAt":1});
    let foreign =
        json!({"id":"b","agentId":"beta","statement":"green memory workspace","createdAt":1});
    std::fs::write(
        dir.join("memory-candidates.jsonl"),
        format!("{own}\n{foreign}\n"),
    )
    .unwrap();
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let records = reader
        .read_records(RecordKind::Candidates, 10, &ctx)
        .unwrap();
    assert_eq!(records.len(), 1);
    let options = Options {
        max_per_lane: 2,
        min_score: 0.08,
        query_vector: None,
    };
    assert_eq!(
        routing::route(&records, "green workspace", &ctx, &options)
            .iter()
            .map(|l| l.hits.len())
            .sum::<usize>(),
        1
    );
    let p:Principal=serde_json::from_value(json!({"agentId":"beta","workspace":"workspace:v1:one","channel":"telegram","accountId":"fixture-account","chat":{"id":"fixture-chat","kind":"direct"},"trust":"proved"})).unwrap();
    let a: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let other = RequestContext::build(&p, &a, &host).unwrap();
    assert!(
        routing::route(&records, "green workspace", &other, &options)
            .iter()
            .all(|l| l.hits.is_empty())
    );
    let mut revisions = records;
    revisions.push(Record {metadata:parse_json(&json!({"id":"a","agentId":"beta","statement":"green workspace","createdAt":1,"updatedAt":2}).to_string()).unwrap(),embedding:None});
    assert!(
        routing::route(&revisions, "green workspace", &ctx, &options)
            .iter()
            .all(|l| l.hits.is_empty())
    );
}

#[test]
fn global_dedupe_subset_preserves_opaque_utf16_ids() {
    use plur1bus_engine::text::js::JsString;
    let records = [
        Record {
            metadata: parse_json(r#"{"id":"\ud800","statement":"same selected memory text"}"#)
                .unwrap(),
            embedding: None,
        },
        Record {
            metadata: parse_json(r#"{"id":"�","statement":"same selected memory text"}"#).unwrap(),
            embedding: None,
        },
    ];
    let mut lanes = [routing::Lane {
        name: "workspace_facts",
        hits: vec![
            routing::Hit {
                index: 0,
                score: 1.,
            },
            routing::Hit {
                index: 1,
                score: 1.,
            },
        ],
    }];
    assert_eq!(
        routing::dedupe_lossless(
            &mut lanes,
            &records,
            &["same selected memory text".into()],
            Some(&[JsString::from_utf16_units(vec![0xd800])]),
            0.8
        ),
        1
    );
    assert_eq!(lanes[0].hits.len(), 1);
    assert_eq!(lanes[0].hits[0].index, 1);
}
