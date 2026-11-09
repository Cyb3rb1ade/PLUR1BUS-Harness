//! Actual A1 assembler observations, followed by native SQLite effects.
#![allow(clippy::unwrap_used, reason = "recorded synthetic fixtures")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    contract::Cancel,
    recall::{
        blocks::{ContextBlock, RenderedRecall},
        stats::{record_returned, ReturnedRecall},
    },
    store::recall_stats::RecallStats,
    text::js::JsString,
};
use serde_json::Value;
#[test]
fn final_render_membership_and_exclusions_match_actual_a1_assembler() {
    let golden: Value = serde_json::from_str(include_str!(
        "fixtures/recall/golden/recall-stats-render.json"
    ))
    .unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let stats = RecallStats::new(root.path()).unwrap();
        let rendered = RenderedRecall {
            blocks: case["result"]["blocks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| {
                    ContextBlock::new(
                        b["name"].as_str().unwrap().into(),
                        JsString::from(b["text"].as_str().unwrap()),
                        b["droppable"].as_bool().unwrap(),
                    )
                })
                .collect(),
            cap_chars: case["result"]["capChars"].as_f64().unwrap_or(f64::INFINITY),
            ..Default::default()
        };
        let before = rendered.clone();
        let call = case["calls"].as_array().unwrap().first();
        let query = call
            .map(|c| c["query"].as_str().unwrap())
            .unwrap_or("synthetic query");
        let now = call.map(|c| c["now"].as_f64().unwrap()).unwrap_or(0.);
        if case["input"]["statsError"] == true {
            std::fs::create_dir(root.path().join("_recall-stats")).unwrap();
            std::fs::create_dir(root.path().join("_recall-stats/render-fixture.sqlite")).unwrap();
        }
        let result = record_returned(
            &stats,
            &ReturnedRecall {
                rendered: &rendered,
                agent: "render-fixture",
                query,
                now,
                warm_only: case["input"]["warm"] == true,
                degraded: !case["result"]["degraded"].is_null(),
                cancel: &Cancel::never(),
            },
        );
        assert_eq!(rendered, before, "{}", case["input"]["variant"]);
        if case["input"]["statsError"] == true {
            assert!(result.is_err());
            continue;
        }
        result.unwrap();
        let mut ids = call
            .map(|c| {
                c["ids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        ids.sort();
        ids.dedup();
        if ids.is_empty() {
            assert!(!root.path().join("_recall-stats").exists());
        }
        let rows = stats
            .read("render-fixture", None, &Cancel::never())
            .unwrap();
        assert_eq!(
            rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
            ids,
            "{}",
            case["input"]["variant"]
        );
        assert!(rows.iter().all(|r| r.recalls == 1
            && r.distinct_queries == 1
            && r.last_recalled_at == Some(now as i64)));
    }
}
