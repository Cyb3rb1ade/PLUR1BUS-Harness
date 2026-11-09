//! Actual pinned normal-store preparation with separately bound ownership/C7 exceptions.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "offline golden assertions"
)]
use plur1bus_engine::{
    capture::{
        normal_store::{assess, MergeMaterial, StoreEncoding, StoreOwner},
        row_defaults,
    },
    contract::Cancel,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
fn field<'a>(v: &'a Json, key: &str) -> &'a Json {
    let Json::Object(v) = v else {
        return &Json::Null;
    };
    v.iter()
        .find(|(k, _)| k == &JsString::from(key))
        .map(|(_, v)| v)
        .unwrap_or(&Json::Null)
}
fn array(v: &Json) -> &[Json] {
    let Json::Array(v) = v else { panic!("array") };
    v
}
fn text(v: &Json) -> String {
    let Json::String(v) = v else { panic!("string") };
    String::from_utf16(v.as_utf16_units()).unwrap()
}
#[test]
fn actual_normal_store_assessment_and_merged_fields_match_with_named_exceptions() {
    let bytes = include_bytes!("fixtures/capture/golden/normal-store-merge.json");
    let golden = parse_json(std::str::from_utf8(bytes).unwrap()).unwrap();
    let exceptions = parse_json(include_str!(
        "fixtures/capture/normal-store-merge-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        text(field(&exceptions, "nodeGoldenSha256")),
        format!("{:x}", Sha256::digest(bytes))
    );
    for case in array(field(&golden, "cases")) {
        let name = text(field(field(case, "scenario"), "name"));
        let source = field(case, "original");
        let owner = text(field(source, "ownerUserId"));
        let workspace = text(field(source, "workspaceKey"));
        let ownership = StoreOwner {
            agent_id: "alpha",
            owner_user_id: &owner,
            workspace_key: &workspace,
        };
        let expected = array(field(&exceptions, "cases"))
            .iter()
            .find(|r| text(field(r, "name")) == name)
            .unwrap();
        let result = assess(
            field(case, "params"),
            ownership,
            1735689600000,
            &Cancel::never(),
        );
        if field(expected, "refuse") == &Json::Bool(true) {
            assert!(result.is_err(), "{name}");
            continue;
        }
        let assessed = result.unwrap();
        assert_eq!(
            assessed.category(),
            text(field(
                field(field(case, "assessment"), "category"),
                "category"
            ))
        );
        assert_eq!(
            assessed.importance(),
            field(field(field(case, "assessment"), "importance"), "importance").clone()
        );
        assert_eq!(
            assessed.write_key(),
            &JsString::from(text(field(expected, "writeKey")))
        );
        let mut row = serde_json::to_value(row_defaults::schema_defaults(vec![])).unwrap();
        let src: serde_json::Value = serde_json::from_str(&write_json(source)).unwrap();
        row.as_object_mut()
            .unwrap()
            .extend(src.as_object().unwrap().clone());
        let source = serde_json::from_value(row).unwrap();
        if name == "auto-apply-off" {
            continue;
        }
        let decision = field(field(case, "scenario"), "answer").clone();
        let decision = if decision == Json::Null {
            parse_json("{\"merge\":true,\"reason\":\"fixture\",\"mergedText\":\"I enjoy drinking coffee every morning and find this routine pleasant.\"}").unwrap()
        } else {
            decision
        };
        if name == "provider-failure" {
            continue;
        }
        let cfg = field(field(case, "scenario"), "config");
        let mut encoding = StoreEncoding::default();
        if let Json::Number(v) = field(cfg, "summaryMaxWords") {
            encoding.summary_max_words = v.parse().unwrap();
        }
        if let Json::Object(_) = field(field(cfg, "recall"), "halfLifeDaysMap") {
            encoding.half_life_overrides = field(field(cfg, "recall"), "halfLifeDaysMap").clone();
        }
        encoding.flashbulb =
            field(field(cfg, "memoryDynamics"), "flashbulbEncoding") == &Json::Bool(true);
        let stored = &array(field(case, "stored"))[0];
        let merged = assessed
            .merge(
                MergeMaterial {
                    source: &source,
                    decision: &decision,
                    vector: field(stored, "vector"),
                    now_ms: 1735689600000,
                },
                &encoding,
                &Cancel::never(),
            )
            .unwrap();
        if text(field(case, "action")) == "stored" {
            assert!(merged.is_none(), "{name}");
            continue;
        }
        let merged = merged.unwrap();
        let mut wanted = stored.clone();
        let Json::Object(fields) = &mut wanted else {
            panic!("row")
        };
        let Json::Object(patch) = field(expected, "patch") else {
            panic!("patch")
        };
        for (k, v) in patch {
            fields.iter_mut().find(|(key, _)| key == k).unwrap().1 = v.clone();
        }
        assert_eq!(write_json(&merged.entry), write_json(&wanted), "{name}");
        let materialized = merged.into_row().unwrap();
        assert_eq!(materialized.owner_user_id, owner);
        assert_eq!(materialized.workspace_key, workspace);
        assert!(materialized.vector.iter().all(|v| v.is_finite()));
        if let Json::Object(patch) = field(expected, "outwardPatch") {
            let row = serde_json::to_value(&materialized).unwrap();
            for (key, value) in patch {
                assert_eq!(
                    row[key.to_utf8_lossy()],
                    serde_json::Value::String(text(value)),
                    "{name}"
                );
            }
        }
    }
}

#[test]
fn canonical_private_boundary_refuses_unsafe_inputs_and_material() {
    let owner_id = format!("user:v1:{}", "a".repeat(64));
    let owner = StoreOwner {
        agent_id: "alpha",
        owner_user_id: &owner_id,
        workspace_key: "workspace:v1:fixture",
    };
    for input in [
        r#"{"text":"A fact","scope":"global_user"}"#,
        r#"{"text":"A fact","validFrom":"2025-01-01"}"#,
        r#"{"text":"A fact","validFrom":-1}"#,
        r#"{"text":"A fact","validFrom":1.5}"#,
        r#"{"text":"A fact","validFrom":9007199254740992}"#,
        r#"{"text":"A fact","validFrom":12,"validUntil":12}"#,
        r#"{"text":"A fact","importance":0.97,"ttl":"session"}"#,
        r#"{"text":"\ud800"}"#,
    ] {
        assert!(
            assess(
                &parse_json(input).unwrap(),
                owner,
                1735689600000,
                &Cancel::never()
            )
            .is_err(),
            "{input}"
        );
    }
    let params = parse_json(r#"{"text":"I enjoy coffee every morning."}"#).unwrap();
    let assessed = assess(&params, owner, 1735689600000, &Cancel::never()).unwrap();
    let mut source = row_defaults::schema_defaults(vec![1.0]);
    source.id = "11111111-1111-4111-8111-111111111111".into();
    source.text = "I enjoy drinking coffee every morning.".into();
    source.agent_id = "alpha".into();
    source.stored_by = "alpha".into();
    source.owner_user_id = owner_id.clone();
    source.workspace_key = "workspace:v1:fixture".into();
    source.scope = "agent-private".into();
    source.status = "active".into();
    let decision = parse_json(r#"{"merge":true,"reason":"fixture","mergedText":"I enjoy drinking coffee every morning and find this routine pleasant."}"#).unwrap();
    let valid = parse_json("[1]").unwrap();
    let run = |source: &_, vector: &_, encoding: &_| {
        assessed.merge(
            MergeMaterial {
                source,
                decision: &decision,
                vector,
                now_ms: 1735689600000,
            },
            encoding,
            &Cancel::never(),
        )
    };
    let encoding = StoreEncoding::default();
    assert!(run(&source, &valid, &encoding).unwrap().is_some());
    for vector in [
        parse_json("[]").unwrap(),
        parse_json("[1e999]").unwrap(),
        Json::Array(vec![Json::Number("1".into()); 32769]),
    ] {
        assert!(run(&source, &vector, &encoding).is_err());
    }
    let huge_f32 = parse_json("[1e100]").unwrap();
    assert!(run(&source, &huge_f32, &encoding)
        .unwrap()
        .unwrap()
        .into_row()
        .is_err());
    let mut foreign = source.clone();
    foreign.owner_user_id = format!("user:v1:{}", "b".repeat(64));
    assert!(run(&foreign, &valid, &encoding).is_err());
    foreign = source.clone();
    foreign.workspace_key = "workspace:v1:other".into();
    assert!(run(&foreign, &valid, &encoding).is_err());
    foreign = source.clone();
    foreign.status = "superseded".into();
    assert!(run(&foreign, &valid, &encoding).is_err());
    source.text = "x".repeat(1_048_577);
    assert!(assessed.compatible(&source).is_err());
}
