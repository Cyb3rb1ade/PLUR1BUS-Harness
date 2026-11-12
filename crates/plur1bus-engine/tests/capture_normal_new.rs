//! Actual ordinary normal-store rows, with separate ownership/UUID/C7/F3 exceptions.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "offline golden assertions"
)]
use plur1bus_engine::{
    capture::normal_store::{assess, StoreEncoding, StoreOwner},
    contract::Cancel,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
fn get<'a>(v: &'a Json, k: &str) -> &'a Json {
    if let Json::Object(v) = v {
        v.iter()
            .find(|(key, _)| key == &JsString::from(k))
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
#[test]
fn actual_new_row_fields_match_with_named_native_exceptions() {
    let bytes = include_bytes!("fixtures/capture/golden/normal-store-new.json");
    let golden = parse_json(std::str::from_utf8(bytes).unwrap()).unwrap();
    let exceptions = parse_json(include_str!(
        "fixtures/capture/normal-store-new-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        text(get(&exceptions, "nodeGoldenSha256")),
        format!("{:x}", Sha256::digest(bytes))
    );
    let id = uuid::Uuid::parse_str(&text(get(&exceptions, "nativeOperationId"))).unwrap();
    for case in array(get(&golden, "cases")) {
        let scenario = get(case, "scenario");
        let name = text(get(scenario, "name"));
        let expected = array(get(&exceptions, "cases"))
            .iter()
            .find(|v| text(get(v, "name")) == name)
            .unwrap();
        let source = get(case, "original");
        let owner = text(get(source, "ownerUserId"));
        let workspace = text(get(source, "workspaceKey"));
        let result = assess(
            get(case, "params"),
            StoreOwner {
                agent_id: "alpha",
                owner_user_id: &owner,
                workspace_key: &workspace,
            },
            1735689600000,
            &Cancel::never(),
        );
        if get(expected, "refuse") == &Json::Bool(true) {
            assert!(result.is_err(), "{name}");
            continue;
        }
        let assessed = result.unwrap();
        assert_eq!(
            assessed.write_key(),
            &JsString::from(text(get(expected, "writeKey")))
        );
        let cfg = get(scenario, "config");
        let mut encoding = StoreEncoding::default();
        if let Json::Number(v) = get(cfg, "summaryMaxWords") {
            encoding.summary_max_words = v.parse().unwrap();
        }
        if let Json::Object(_) = get(get(cfg, "recall"), "halfLifeDaysMap") {
            encoding.half_life_overrides = get(get(cfg, "recall"), "halfLifeDaysMap").clone();
        }
        encoding.flashbulb =
            get(get(cfg, "memoryDynamics"), "flashbulbEncoding") == &Json::Bool(true);
        let stored = &array(get(case, "stored"))[0];
        let prepared = assessed
            .ordinary(
                &id,
                get(stored, "vector"),
                1735689600000,
                &encoding,
                &Cancel::never(),
            )
            .unwrap();
        let mut wanted = stored.clone();
        let Json::Object(fields) = &mut wanted else {
            panic!("row")
        };
        let Json::Object(patch) = get(expected, "patch") else {
            panic!("patch")
        };
        for (k, v) in patch {
            fields.iter_mut().find(|(key, _)| key == k).unwrap().1 = v.clone();
        }
        assert_eq!(write_json(&prepared.entry), write_json(&wanted), "{name}");
        let row = prepared.into_row().unwrap();
        assert_eq!(row.owner_user_id, owner);
        assert_eq!(row.workspace_key, workspace);
        assert_eq!(row.epistemic_status, "untrusted");
        assert!(row.vector.iter().all(|v| v.is_finite()));
        if let Json::Object(patch) = get(expected, "outwardPatch") {
            let row = serde_json::to_value(&row).unwrap();
            for (k, v) in patch {
                assert_eq!(
                    row[k.to_utf8_lossy()],
                    serde_json::Value::String(text(v)),
                    "{name}"
                );
            }
        }
    }
}

#[test]
fn operation_identity_and_initial_ttl_survive_later_row_preparation() {
    let owner = format!("user:v1:{}", "a".repeat(64));
    let params = parse_json(r#"{"text":"A synthetic fact","ttl":"session"}"#).unwrap();
    let assessed = assess(
        &params,
        StoreOwner {
            agent_id: "alpha",
            owner_user_id: &owner,
            workspace_key: "workspace:v1:fixture",
        },
        1000,
        &Cancel::never(),
    )
    .unwrap();
    let id = uuid::Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
    let vector = parse_json("[1]").unwrap();
    let encoding = StoreEncoding::default();
    let row = assessed
        .ordinary(&id, &vector, 2000, &encoding, &Cancel::never())
        .unwrap()
        .into_row()
        .unwrap();
    assert_eq!(row.id, id.to_string());
    assert_eq!(row.created_at.as_f64(), Some(2000.));
    assert_eq!(row.expires_at.as_f64(), Some(86401000.));
    assert_eq!(row.source_timestamp.as_f64(), Some(2000.));
    assert_eq!(row.epistemic_status, "untrusted");
    assert!(row.source_message_role.is_empty());
    assert!(row.source_turn_id.is_empty());
    assert!(assessed
        .ordinary(
            &uuid::Uuid::nil(),
            &vector,
            2000,
            &encoding,
            &Cancel::never()
        )
        .is_err());
    assert!(assessed
        .ordinary(&id, &Json::Array(vec![]), 2000, &encoding, &Cancel::never())
        .is_err());
    assert!(assessed
        .ordinary(&id, &vector, 9007199254740992, &encoding, &Cancel::never())
        .is_err());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(assessed
        .ordinary(&id, &vector, 2000, &encoding, &cancel)
        .is_err());
}
