//! Capture row and splitter parity against raw JSON recorded from the pinned Node engine.
#![allow(clippy::unwrap_used)]

use plur1bus_engine::capture::{chunk_decider, chunking, dedupe, row_builder};

use plur1bus_engine::text::js::JsString;

#[test]
fn chunk_plans_equal_the_recorded_node_json_bytes() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/chunk-plans.json")).unwrap();
    for case in fixture["plans"].as_array().unwrap() {
        let input = JsString::from_utf16_units(
            case["textUnits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_u64().unwrap() as u16)
                .collect(),
        );
        let actual = chunking::plan_chunks(&input, chunking::ChunkLimits::default());
        assert_eq!(
            actual.to_node_json().as_bytes(),
            case["json"].as_str().unwrap().as_bytes(),
            "scenario {}",
            case["name"]
        );
    }
}

#[test]
fn capture_max_chars_cuts_utf16_without_replacing_a_lone_surrogate() {
    let input = JsString::from("a😀z");
    let truncated = chunking::truncate_for_capture(&input, 2);
    assert_eq!(truncated.as_utf16_units(), &[0x0061, 0xd83d]);
    assert_eq!(truncated.to_json(), "\"a\\ud83d\"");
}

#[test]
fn actual_engine_recordings_include_every_persisted_column() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/rows.json")).unwrap();
    for case in fixture["recordings"].as_array().unwrap() {
        for line in case["rowLines"].as_array().unwrap() {
            let row: serde_json::Value = serde_json::from_str(line.as_str().unwrap()).unwrap();
            assert_eq!(row.as_object().unwrap().len(), 69);
            assert!(row["vector"].as_array().is_some());
        }
    }
}

#[test]
fn duplicate_threshold_uses_the_pinned_native_distance_score() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/dedupe.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let score = dedupe::distance_to_score(case["distance"].as_f64());
        assert_eq!(score.to_string(), case["scoreJson"].as_str().unwrap());
        assert_eq!(
            dedupe::score_is_duplicate(score, case["threshold"].as_f64().unwrap()),
            case["duplicate"].as_bool().unwrap()
        );
    }
}

#[test]
fn chunk_decider_answer_threshold_and_defaults_equal_node() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/chunk-decider.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let answer = &case["answer"];
        let confidence = match &answer["confidence"] {
            serde_json::Value::Number(number) => number.as_f64(),
            serde_json::Value::String(value) => value.parse().ok(),
            _ => None,
        };
        assert_eq!(
            chunk_decider::storage_for_answer(answer["choice"].as_str(), confidence, 0.85).as_str(),
            case["storage"].as_str().unwrap()
        );
    }
}

#[test]
fn chunk_decider_request_json_equals_the_recorded_http_bytes() {
    let fixtures: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/llm/rows.json")).unwrap();
    let mut requests = 0;
    for fixture in fixtures["scopes"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|scope| scope.as_object().unwrap().values())
    {
        if fixture["transport"] != "chunk-decider" {
            continue;
        }
        let expected = fixture["requestJson"].as_str().unwrap();
        let request: serde_json::Value = serde_json::from_str(expected).unwrap();
        let actual = chunk_decider::request_json(
            request["model"].as_str().unwrap(),
            &JsString::from(request["state"].as_str().unwrap()),
        );
        assert_eq!(actual.as_bytes(), expected.as_bytes());
        requests += 1;
    }
    assert!(requests > 0);
}

#[test]
fn the_flat_embedder_makes_every_text_duplicate_unless_the_threshold_exceeds_one() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/rows.json")).unwrap();
    let scenarios = fixture["recordings"].as_array().unwrap();
    let blocked = scenarios
        .iter()
        .find(|row| row["name"] == "flat-default-threshold")
        .unwrap();
    let allowed = scenarios
        .iter()
        .find(|row| row["name"] == "flat-threshold-above-one")
        .unwrap();
    assert_eq!(blocked["rowLines"].as_array().unwrap().len(), 1);
    assert_eq!(allowed["rowLines"].as_array().unwrap().len(), 2);
    let row = serde_json::from_str(blocked["rowLines"][0].as_str().unwrap()).unwrap();
    let nearest = plur1bus_engine::store::row::Scored { row, distance: 0.0 };
    assert!(dedupe::is_duplicate(Some(&nearest), 1.0));
    assert!(!dedupe::is_duplicate(Some(&nearest), 1.01));
    assert!(!dedupe::is_duplicate(None, 0.0));
}

#[test]
fn every_default_equals_the_actual_node_bootstrap_row() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/schema-seed.json")).unwrap();
    let row = row_builder::schema_defaults(vec![0.0; 384]);
    assert_eq!(
        row_builder::to_node_json(&row).unwrap().as_bytes(),
        fixture["rowLine"].as_str().unwrap().as_bytes()
    );
}

#[test]
fn persisted_row_text_keeps_the_node_field_order_and_number_bytes() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/rows.json")).unwrap();
    for scenario in fixture["recordings"].as_array().unwrap() {
        for expected in scenario["rowLines"].as_array().unwrap() {
            let expected = expected.as_str().unwrap();
            let row = serde_json::from_str(expected).unwrap();
            assert_eq!(
                row_builder::to_node_json(&row).unwrap().as_bytes(),
                expected.as_bytes(),
                "scenario {}",
                scenario["name"]
            );
        }
    }
}

#[test]
fn expansion_keeps_whole_and_parts_in_the_recorded_node_order() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/capture/golden/chunk-expansions.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let text = JsString::from_utf16_units(
            case["textUnits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_u64().unwrap() as u16)
                .collect(),
        );
        let (mode, decision) = match case["mode"].as_str().unwrap() {
            "disabled" => (
                chunking::ExpansionMode::Disabled,
                chunking::StorageDecision::Both,
            ),
            "both" => (
                chunking::ExpansionMode::WholeAndParts,
                chunking::StorageDecision::Both,
            ),
            "parts" => (
                chunking::ExpansionMode::PartsOnly,
                chunking::StorageDecision::Parts,
            ),
            "decided-whole" => (
                chunking::ExpansionMode::Decided,
                chunking::StorageDecision::Whole,
            ),
            "decided-parts" => (
                chunking::ExpansionMode::Decided,
                chunking::StorageDecision::Parts,
            ),
            "decided-both" => (
                chunking::ExpansionMode::Decided,
                chunking::StorageDecision::Both,
            ),
            _ => unreachable!(),
        };
        let mut group = 0;
        let expansion = chunking::expand_for_capture(
            &[chunking::PreparedCapture {
                item: 0,
                text,
                chunk_group_id: None,
            }],
            mode,
            |_| decision,
            || {
                group += 1;
                format!("capture-group-{group}")
            },
        );
        let items = expansion
            .items
            .iter()
            .map(|item| {
                let group = item
                    .chunk_group_id
                    .as_ref()
                    .map_or_else(String::new, |value| {
                        format!(
                            ",\"chunkGroupId\":{}",
                            JsString::from(value.as_str()).to_json()
                        )
                    });
                format!(
                    "{{\"it\":{{\"ordinal\":{}}},\"text\":{},\"ok\":true{group}}}",
                    item.item,
                    item.text.to_json()
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let decisions = expansion.decisions.map_or_else(String::new, |counts| {
            format!(
                ",\"decisions\":{{\"whole\":{},\"parts\":{},\"both\":{}}}",
                counts.whole, counts.parts, counts.both
            )
        });
        let actual = format!(
            "{{\"items\":[{items}],\"split\":{},\"parts\":{},\"needsLlm\":{}{decisions}}}",
            expansion.split, expansion.parts, expansion.needs_llm
        );
        assert_eq!(
            actual.as_bytes(),
            case["json"].as_str().unwrap().as_bytes(),
            "{} {}",
            case["name"],
            case["mode"]
        );
    }
}

#[test]
fn capture_duplicate_predicate_is_exact_and_leaves_other_store_callers_unchanged() {
    assert_eq!(
        plur1bus_engine::store::filter::CAPTURE_DUPLICATE_FILTER,
        "(status = 'active' OR status IS NULL) AND epistemicStatus != 'invalidated'"
    );
    let ordinary = plur1bus_engine::store::RowFilter {
        status: Some("active".into()),
        ..Default::default()
    };
    assert!(ordinary.to_sql().contains("status = ''"));
}
