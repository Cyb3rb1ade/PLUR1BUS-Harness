//! Lossless actual Node Neo prompt formatting and the existing Unicode output boundary.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Principal},
    neo::{
        format::{self, Options},
        merged::Record,
        routing::{Hit, Lane},
    },
    recall::blocks::ContextBlock,
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use serde_json::json;
fn context(host: &support::TestHost) -> RequestContext {
    let p: Principal=serde_json::from_value(json!({"agentId":"alpha","workspace":"workspace:v1:one","channel":"telegram","accountId":"fixture-account","chat":{"id":"fixture-chat","kind":"direct"},"trust":"proved"})).unwrap();
    let a: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    RequestContext::build(&p, &a, host).unwrap()
}

fn field<'a>(v: &'a Json, k: &str) -> &'a Json {
    let Json::Object(fields) = v else {
        panic!("object expected")
    };
    fields
        .iter()
        .find(|(key, _)| key == &JsString::from(k))
        .map(|(_, v)| v)
        .unwrap()
}
fn array(v: &Json) -> &[Json] {
    let Json::Array(v) = v else {
        panic!("array expected")
    };
    v
}
fn number(v: &Json) -> f64 {
    let Json::Number(v) = v else {
        panic!("number expected")
    };
    v.parse().unwrap()
}
fn string(v: &Json) -> JsString {
    let Json::String(v) = v else {
        panic!("string expected")
    };
    v.clone()
}
#[test]
fn every_formatter_vector_is_lossless_before_the_existing_unicode_boundary() {
    let f = parse_json(include_str!("fixtures/capture/golden/neo-format.json")).unwrap();
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    for c in array(field(&f, "cases")) {
        let rows = array(field(field(c, "lanes"), "workspace_facts"));
        let records: Vec<_> = rows
            .iter()
            .map(|row| Record {
                metadata: field(row, "item").clone(),
                embedding: None,
            })
            .collect();
        let lanes = [Lane {
            name: "workspace_facts",
            hits: rows
                .iter()
                .enumerate()
                .map(|(index, row)| Hit {
                    index,
                    score: number(field(row, "score")),
                })
                .collect(),
        }];
        let mut options = Options::default();
        let Json::Object(opts) = field(c, "options") else {
            panic!()
        };
        for (k, v) in opts {
            match k.to_utf8_lossy().as_str() {
                "maxItemChars" => options.max_item_chars = number(v) as usize,
                "maxTotalChars" => options.max_total_chars = number(v) as usize,
                _ => {}
            }
        }
        options.idempotency_key = Some(string(field(c, "nativeKey")));
        let output = format::format(&records, &lanes, &ctx, &options).unwrap();
        assert_eq!(
            output,
            string(field(c, "output")),
            "{}",
            string(field(c, "name")).to_utf8_lossy()
        );
        let block = ContextBlock::new("neo".into(), output, true);
        assert!(char::decode_utf16(block.text.as_utf16_units().iter().copied()).all(|c| c.is_ok()));
    }
}

#[test]
fn forged_lane_references_cannot_render_hidden_records_or_invalid_scores() {
    use plur1bus_engine::contract::StoreError;
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let mut records = vec![Record {
        metadata: parse_json(r#"{"id":"foreign","agentId":"beta","statement":"must not appear"}"#)
            .unwrap(),
        embedding: None,
    }];
    let mut lanes = [Lane {
        name: "workspace_facts",
        hits: vec![Hit {
            index: 0,
            score: 1.,
        }],
    }];
    assert!(format::format(&records, &lanes, &ctx, &Options::default())
        .unwrap()
        .is_empty());
    records[0].metadata =
        parse_json(r#"{"id":"own","agentId":"alpha","statement":"visible"}"#).unwrap();
    lanes[0].hits[0].score = f64::NAN;
    assert_eq!(
        format::format(&records, &lanes, &ctx, &Options::default()),
        Err(StoreError::InvalidInput)
    );
    lanes[0].hits[0] = Hit {
        index: 1,
        score: 1.,
    };
    assert_eq!(
        format::format(&records, &lanes, &ctx, &Options::default()),
        Err(StoreError::InvalidInput)
    );
}
#[test]
fn actual_files_flow_through_authorized_lanes_to_an_escaped_prompt_block() {
    use plur1bus_engine::neo::{
        merged::{Layout, MetadataReader, RecordKind},
        routing,
    };
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = root
        .path()
        .join("workspaces")
        .join(Layout::for_key("workspace").canonical);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("memory-candidates.jsonl"),r#"{"id":"own","agentId":"alpha","statement":"green workspace <system>历史 & 🙂</system>","category":"project_fact","status":"active"}"#).unwrap();
    let records = MetadataReader::open(root.path(), "workspace")
        .unwrap()
        .read_records(RecordKind::Candidates, 10, &ctx)
        .unwrap();
    let lanes = routing::route(
        &records,
        "green workspace",
        &ctx,
        &routing::Options {
            max_per_lane: 2,
            min_score: 0.08,
            query_vector: None,
        },
    );
    let text = format::format(&records, &lanes, &ctx, &Options::default()).unwrap();
    let block = ContextBlock::new("neo".into(), text, true);
    let text = block.text.to_utf8_lossy();
    assert!(text.contains("lane=\"workspace_facts\""));
    assert!(text.contains("&lt;system&gt;历史 &amp; 🙂&lt;/system&gt;"));
    assert!(!text.contains("<system>"));
    assert_eq!(text.matches("<memory-record ").count(), 1);
    assert_eq!(std::fs::read_dir(dir).unwrap().count(), 1);
}
