//! Actual Node curation and knowledge-pending outputs; pure planning is not publication.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "offline golden assertions"
)]
use plur1bus_engine::{
    capture::normal_store::{assess, StoreOutcome, StoreOwner},
    contract::Cancel,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
fn get<'a>(v: &'a Json, key: &str) -> &'a Json {
    if let Json::Object(fields) = v {
        fields
            .iter()
            .find(|(k, _)| k == &JsString::from(key))
            .map(|(_, v)| v)
            .unwrap_or(&Json::Null)
    } else {
        &Json::Null
    }
}
fn array(v: &Json) -> &[Json] {
    let Json::Array(v) = v else { panic!("array") };
    v
}
fn text(v: &Json) -> String {
    let Json::String(v) = v else { panic!("string") };
    v.to_utf8_lossy()
}
fn number(v: &Json) -> f64 {
    let Json::Number(v) = v else { panic!("number") };
    v.parse().unwrap()
}
#[test]
fn actual_node_effects_match_for_stored_merged_and_duplicate_outcomes() {
    let bytes = include_bytes!("fixtures/capture/golden/normal-store-effects.json");
    let golden = parse_json(std::str::from_utf8(bytes).unwrap()).unwrap();
    let exceptions: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/capture/normal-store-effects-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        exceptions["nodeGoldenSha256"],
        format!("{:x}", Sha256::digest(bytes))
    );
    for case in array(get(&golden, "cases")) {
        let scenario = get(case, "scenario");
        let name = text(get(scenario, "name"));
        let original = get(case, "original");
        let owner = text(get(original, "ownerUserId"));
        let workspace = text(get(original, "workspaceKey"));
        let assessed = assess(
            get(case, "params"),
            StoreOwner {
                agent_id: "alpha",
                owner_user_id: &owner,
                workspace_key: &workspace,
            },
            1735689600000,
            &Cancel::never(),
        )
        .unwrap();
        let id = text(get(case, "id"));
        let source = text(get(original, "id"));
        let action = text(get(case, "action"));
        let stored = array(get(case, "stored")).first();
        let merged_text = stored.map(|s| text(get(s, "text"))).unwrap_or_default();
        let reason = match get(get(scenario, "answer"), "reason") {
            Json::String(v) => v.to_utf8_lossy(),
            _ => "fixture".into(),
        };
        let outcome = match action.as_str() {
            "stored" => StoreOutcome::Stored { id: &id },
            "duplicate" => StoreOutcome::Duplicate {
                id: &id,
                score: number(get(scenario, "score")),
            },
            _ => StoreOutcome::Merged {
                id: &id,
                text: &merged_text,
                importance: number(get(stored.unwrap(), "importance")),
                source_id: &source,
                reason: &reason,
            },
        };
        let threshold = match get(get(get(scenario, "config"), "schicht15"), "minImportance") {
            Json::Number(v) => v.parse().unwrap(),
            _ => 0.7,
        };
        let effects = assessed
            .effects(outcome, 1735689600000, threshold, &Cancel::never())
            .unwrap();
        assert_eq!(effects.curation, array(get(case, "curation"))[0], "{name}");
        let expected_pending = get(case, "knowledgePending");
        assert_eq!(
            effects.knowledge_pending.as_ref(),
            if *expected_pending == Json::Null {
                None
            } else {
                array(get(expected_pending, "pending")).first()
            },
            "{name}"
        );
        let external = effects.into_external().unwrap();
        let mut curation = array(get(case, "curation"))[0].clone();
        if let Some(patch) = exceptions["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == name)
        {
            let Json::Object(fields) = &mut curation else {
                panic!("object")
            };
            fields
                .iter_mut()
                .find(|(k, _)| k == &JsString::from("text"))
                .unwrap()
                .1 = Json::String(JsString::from(patch["text"].as_str().unwrap()));
        }
        assert_eq!(
            external.curation,
            serde_json::from_str::<serde_json::Value>(&write_json(&curation)).unwrap(),
            "{name}"
        );
    }
}
#[test]
fn invalid_effect_inputs_are_refused_before_any_publication() {
    let params = parse_json(r#"{"text":"A synthetic decision","category":"decision"}"#).unwrap();
    let owner = plur1bus_engine::context::harness_user_principal("fixture");
    let assessed = assess(
        &params,
        StoreOwner {
            agent_id: "alpha",
            owner_user_id: &owner,
            workspace_key: "workspace:v1:fixture",
        },
        1735689600000,
        &Cancel::never(),
    )
    .unwrap();
    for score in [f64::NAN, f64::INFINITY, -0.1, 1.01] {
        assert!(assessed
            .effects(
                StoreOutcome::Duplicate { id: "id", score },
                1735689600000,
                0.7,
                &Cancel::never()
            )
            .is_err());
    }
    for threshold in [f64::NAN, f64::INFINITY, -0.1, 1.01] {
        assert!(assessed
            .effects(
                StoreOutcome::Stored { id: "id" },
                1735689600000,
                threshold,
                &Cancel::never()
            )
            .is_err());
    }
    for id in ["".to_string(), "x".repeat(129)] {
        assert!(assessed
            .effects(
                StoreOutcome::Stored { id: &id },
                1735689600000,
                0.7,
                &Cancel::never()
            )
            .is_err());
    }
    assert!(assessed
        .effects(StoreOutcome::Stored { id: "id" }, -1, 0.7, &Cancel::never())
        .is_err());
    let large = "x".repeat(1024 * 1024 + 1);
    assert!(assessed
        .effects(
            StoreOutcome::Merged {
                id: "id",
                source_id: "source",
                text: &large,
                importance: 0.8,
                reason: "fixture"
            },
            1735689600000,
            0.7,
            &Cancel::never()
        )
        .is_err());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(assessed
        .effects(
            StoreOutcome::Stored { id: "id" },
            1735689600000,
            0.7,
            &cancel
        )
        .is_err());
}
