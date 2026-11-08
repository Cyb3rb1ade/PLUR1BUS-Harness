//! Raw Node dynamics bytes, including encoding flags and Unicode-preserving entry spreads.
#![allow(clippy::unwrap_used, clippy::panic)]

use plur1bus_engine::text;
use serde_json::Value;
use text::json::{parse_json, write_json, TolerantJsonValue as Json};

use plur1bus_engine::capture::dynamics;

fn number(value: &Json) -> f64 {
    if let Json::Number(raw) = value {
        raw.parse().unwrap()
    } else {
        panic!("expected recorded number")
    }
}

fn string(value: &Json) -> String {
    if let Json::String(value) = value {
        value.to_utf8_lossy()
    } else {
        panic!("expected recorded string")
    }
}

fn evaluate(name: &str, args: &[Json]) -> Json {
    match name {
        "isLiveRow" => Json::Bool(dynamics::is_live_row(&args[0])),
        "isManualCoreMarker" => Json::Bool(dynamics::is_manual_core_marker(&args[0])),
        "isCoreMemory" => Json::Bool(dynamics::is_core_memory(&args[0])),
        "computeFlashbulbScore" => {
            dynamics::json_number(dynamics::compute_flashbulb_score(&args[0]))
        }
        "computeCoreMemoryScore" => {
            dynamics::json_number(dynamics::compute_core_memory_score(&args[0]))
        }
        "computeDecayedStrength" => dynamics::json_number(dynamics::compute_decayed_strength(
            &args[0],
            number(&args[1]),
        )),
        "applyRetrievalReinforcement" => {
            dynamics::apply_retrieval_reinforcement(&args[0], number(&args[1]))
        }
        "applyDailyDecay" => dynamics::apply_daily_decay(&args[0], number(&args[1])),
        "computePromotionCandidate" => {
            dynamics::compute_promotion_candidate(&args[0], number(&args[1]))
        }
        "applyDynamicsDefaults" => {
            dynamics::apply_dynamics_defaults(&args[0], number(&args[1]), &args[2], &args[3])
        }
        "applyFlashbulbEncoding" => dynamics::apply_flashbulb_encoding(
            &args[0],
            number(&args[1]),
            number(&args[2]),
            number(&args[3]),
            number(&args[4]),
        )
        .unwrap_or(Json::Null),
        "applyCoreMemoryEncoding" => {
            dynamics::apply_core_memory_encoding(&args[0], number(&args[1]), number(&args[2]))
                .unwrap_or(Json::Null)
        }
        "resolveHalfLifeDays" => dynamics::resolve_half_life_days(
            &string(&args[0]),
            match &args[1] {
                Json::Null => None,
                value => Some(string(value)),
            }
            .as_deref(),
            &args[2],
        ),
        "resolveHalfLifeFromEncoding" => dynamics::json_number(
            dynamics::resolve_half_life_from_encoding(&args[0], args[1] == Json::Bool(true)),
        ),
        "modulateHalfLifeDays" => dynamics::modulate_half_life_days(&args[0], &args[1], &args[2]),
        "createRetrievalLedgerEntry" => {
            dynamics::create_retrieval_ledger_entry(&args[0], "__UUID__", 1000.0)
        }
        other => panic!("unknown Node export {other}"),
    }
}

#[test]
fn all_dynamics_exports_match_raw_node_goldens_with_both_encoding_flag_states() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/dynamics.json")).unwrap();
    for (index, case) in golden["cases"].as_array().unwrap().iter().enumerate() {
        let Json::Array(args) = parse_json(case["args"].as_str().unwrap()).unwrap() else {
            panic!("args")
        };
        let name = case["name"].as_str().unwrap();
        let actual = evaluate(name, &args);
        assert_eq!(
            write_json(&actual),
            case["raw"].as_str().unwrap(),
            "case {index}, {name}, {}",
            case["args"]
        );
    }
}
