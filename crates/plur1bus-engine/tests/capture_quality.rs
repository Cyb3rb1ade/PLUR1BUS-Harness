//! Every deterministic quality/category export versus raw pinned Node bytes.
#![allow(clippy::unwrap_used, clippy::panic)]

use plur1bus_engine::text;
use serde_json::Value;
use text::js::JsString;

use plur1bus_engine::capture::{categorize, fact_quality};

fn input(case: &Value) -> JsString {
    JsString::from_utf16_units(
        case["textUnits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|unit| u16::try_from(unit.as_u64().unwrap()).unwrap())
            .collect(),
    )
}

fn evaluate(case: &Value) -> String {
    let args: Value = serde_json::from_str(case["args"].as_str().unwrap()).unwrap();
    match case["name"].as_str().unwrap() {
        "detectTrivialMemory" => fact_quality::detect_trivial_memory(&input(case))
            .unwrap()
            .to_node_json("trivial"),
        "detectTemporaryMemory" => fact_quality::detect_temporary_memory(&input(case))
            .unwrap()
            .to_node_json("temporary"),
        "detectDurablePreference" => fact_quality::detect_durable_preference(&input(case))
            .unwrap()
            .to_node_json("durablePreference"),
        "detectProjectFact" => fact_quality::detect_project_fact(&input(case))
            .unwrap()
            .to_node_json("projectFact"),
        "detectCorrectionSignal" => fact_quality::detect_correction_signal(&input(case))
            .unwrap()
            .to_node_json("correction"),
        "classifyFactDurability" => {
            serde_json::to_string(&fact_quality::classify_fact_durability(&input(case)).unwrap())
                .unwrap()
        }
        "explainFactQuality" => fact_quality::explain_fact_quality(&input(case))
            .unwrap()
            .to_node_json(),
        "categorizeMemoryWithReason" => {
            serde_json::to_string(&categorize::categorize_memory_with_reason(&input(case)).unwrap())
                .unwrap()
        }
        "categorizeMemory" => {
            serde_json::to_string(categorize::categorize_memory(&input(case)).unwrap()).unwrap()
        }
        "computeMemoryImportance" => {
            let reason = args[0]["categoryReason"].as_str().map(JsString::from);
            fact_quality::compute_memory_importance(
                &input(case),
                reason.as_ref(),
                args[0]["explicitImportance"].as_f64(),
            )
            .unwrap()
            .to_node_json()
        }
        "shouldPromoteMemory" => {
            let quality = serde_json::from_value(args[2].clone()).unwrap();
            serde_json::to_string(&fact_quality::should_promote_memory(
                args[0].as_str().unwrap(),
                args[1].as_f64().unwrap(),
                Some(&quality),
                args[3].as_f64().unwrap(),
            ))
            .unwrap()
        }
        "capAutomaticImportance" => {
            fact_quality::number_json(fact_quality::cap_automatic_importance(
                args[0].as_f64().unwrap(),
                args[1].as_bool().unwrap(),
            ))
        }
        "normalizeImportanceScore" => {
            let reasons: Vec<_> = args[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|reason| JsString::from(reason.as_str().unwrap()))
                .collect();
            fact_quality::number_json(
                fact_quality::normalize_importance_score(
                    args[0].as_f64(),
                    &reasons,
                    &fact_quality::ImportanceOptions::from_json(&args[2]),
                )
                .unwrap(),
            )
        }
        other => panic!("unrecognized recorded export {other}"),
    }
}

#[test]
fn all_quality_and_category_results_match_node_including_german_boundary_defects() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/quality.json")).unwrap();
    assert_eq!(
        serde_json::to_value(categorize::MEMORY_CATEGORIES).unwrap(),
        golden["constants"]["categories"]
    );
    assert_eq!(
        serde_json::to_value(categorize::MEMORY_ORIGINS).unwrap(),
        golden["constants"]["origins"]
    );
    assert_eq!(
        serde_json::to_value(categorize::MEMORY_SCOPES).unwrap(),
        golden["constants"]["scopes"]
    );
    assert_eq!(
        fact_quality::AUTOMATIC_IMPORTANCE_MAX,
        golden["constants"]["automaticImportanceMax"]
            .as_f64()
            .unwrap()
    );
    for (index, case) in golden["cases"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            evaluate(case),
            case["raw"].as_str().unwrap(),
            "case {index}, {}",
            case["name"]
        );
    }
}
