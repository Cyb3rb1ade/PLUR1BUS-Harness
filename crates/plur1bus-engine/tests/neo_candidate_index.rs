//! Actual Node index projections, plus D130 authority-retention exceptions.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Principal},
    neo::{acl, candidate_index::project},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
fn field<'a>(v: &'a Json, name: &str) -> &'a Json {
    let Json::Object(fields) = v else {
        panic!("object")
    };
    &fields
        .iter()
        .find(|(k, _)| k == &JsString::from(name))
        .unwrap()
        .1
}
fn array(v: &Json) -> &[Json] {
    let Json::Array(v) = v else { panic!("array") };
    v
}
fn string(v: &Json) -> String {
    let Json::String(v) = v else { panic!("string") };
    v.to_utf8_lossy()
}
fn ctx(owner: &str, host: &support::TestHost) -> RequestContext {
    let p:Principal=serde_json::from_value(json!({"agentId":"alpha","workspace":"workspace:v1:one","user":owner,"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap();
    let a: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    RequestContext::build(&p, &a, host).unwrap()
}
#[test]
fn actual_index_fields_match_node_without_widening_source_visibility() {
    let fixture = include_str!("fixtures/capture/golden/neo-candidate-index.json");
    let f = parse_json(fixture).unwrap();
    let exceptions: Value = serde_json::from_str(include_str!(
        "fixtures/capture/neo-candidate-index-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(fixture.as_bytes())),
        exceptions["nodeGoldenSha256"]
    );
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let context = ctx(&string(field(&f, "ownerA")), &host);
    for c in array(field(&f, "cases")) {
        let name = string(field(c, "name"));
        let input = field(c, "input");
        let result = project(input);
        if exceptions["rejectedOrigins"]
            .as_array()
            .unwrap()
            .contains(&json!(name))
        {
            assert!(result.is_err(), "{name}");
            assert!(!acl::visible(input, Some(&context)));
            continue;
        }
        let result = result.unwrap();
        let expected = field(c, "output");
        if matches!(expected, Json::Null) {
            assert!(result.is_none(), "{name}");
            continue;
        }
        let result = result.unwrap();
        if exceptions["retainedBindings"]
            .as_array()
            .unwrap()
            .contains(&json!(name))
        {
            assert_eq!(
                acl::visible(input, Some(&context)),
                acl::visible(&result, Some(&context)),
                "{name}"
            );
            assert!(
                acl::visible(expected, Some(&context)),
                "Node actually widens the bad input for {name}"
            );
            if name != "consistent-extra-authority" {
                assert!(!acl::visible(&result, Some(&context)), "{name}");
            }
            // Payload and provenance used in recall retain their exact observed values.
            for key in ["id", "statement", "category", "status", "visibility"] {
                assert_eq!(
                    write_json(field(&result, key)),
                    write_json(field(expected, key)),
                    "{name}/{key}"
                );
            }
        } else {
            assert_eq!(write_json(&result), write_json(expected), "{name}");
        }
    }
}
#[test]
fn duplicate_authority_fields_cannot_be_collapsed_into_an_index_grant() {
    for raw in [
        r#"{"id":"x","agentId":"alpha","agentId":"beta"}"#,
        r#"{"id":"x","origin":{"ownerUserId":"one","ownerUserId":"two"}}"#,
        r#"{"id":"x","visibility":{"scope":"agent_private","scope":"global_user"}}"#,
        r#"{"id":"x","aclBindings":{"agentId":"alpha","agentId":"beta"}}"#,
    ] {
        assert!(project(&parse_json(raw).unwrap()).is_err());
    }
}

#[test]
fn real_global_index_search_preserves_denial_before_vector_loading() {
    use plur1bus_engine::{
        contract::Cancel,
        neo::{
            global::Options,
            merged::{Layout, MetadataReader},
        },
        store::neo_files::{Generation, NeoFiles},
    };
    let f = parse_json(include_str!(
        "fixtures/capture/golden/neo-candidate-index.json"
    ))
    .unwrap();
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let context = ctx(&string(field(&f, "ownerA")), &host);
    let directory = root
        .path()
        .join("workspaces")
        .join(Layout::for_key(&context.workspace_key).canonical);
    std::fs::create_dir_all(&directory).unwrap();
    NeoFiles::open(&directory)
        .unwrap()
        .write_generation(&Generation::new(0), &[("candidate".into(), vec![1.])])
        .unwrap();
    let reader = MetadataReader::open(root.path(), &context.workspace_key).unwrap();
    let query = Options {
        query_vector: &[1.],
        top_k: 10,
        min_similarity: 0.,
        half_life_days: 30.,
        max_candidates: 100,
        exclude_ids: &[],
        now_ms: 1_794_139_200_000.,
    };
    let mut checked = 0;
    for case in array(field(&f, "cases")) {
        let name = string(field(case, "name"));
        let input = field(case, "input");
        if !name.ends_with("conflict") && name != "ordinary" && name != "acl-binding-malformed" {
            continue;
        }
        let projected = project(input).unwrap().unwrap();
        std::fs::write(
            directory.join("candidate-index.jsonl"),
            format!("{}\n", write_json(&projected)),
        )
        .unwrap();
        let actual = reader
            .search_global(&query, &context, &Cancel::never())
            .unwrap();
        let expected = usize::from(name == "ordinary");
        assert!(actual.from_index);
        assert_eq!(
            (actual.scanned, actual.with_vector, actual.hits.len()),
            (expected, expected, expected),
            "{name}"
        );
        if name != "ordinary" {
            // The actual frozen projection has lost the contradictory authority. Its stored
            // shape reproduces the observed grant, proving why merely checking the index is insufficient.
            std::fs::write(
                directory.join("candidate-index.jsonl"),
                format!("{}\n", write_json(field(case, "output"))),
            )
            .unwrap();
            let lost = reader
                .search_global(&query, &context, &Cancel::never())
                .unwrap();
            assert_eq!(lost.hits.len(), 1, "{name}");
        }
        checked += 1;
    }
    assert_eq!(checked, 11);
}
