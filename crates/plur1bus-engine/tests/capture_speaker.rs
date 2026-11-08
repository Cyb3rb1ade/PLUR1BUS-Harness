//! Frozen speaker normalization and actual SQLite proposal behavior; names stay unconfirmed.
#![allow(clippy::unwrap_used, reason = "golden assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::{speaker, speaker_store::CallerSpeakers},
    context::harness_user_principal,
    contract::{AgentContext, Cancel, Principal},
    ops::context::OperationContext,
    store::sqlite::{SpeakerMapping, SpeakerMappings},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
};
const NOW: i64 = 1_710_000_000_000;
fn fixture() -> Json {
    parse_json(include_str!("fixtures/capture/golden/speaker.json")).unwrap()
}
fn get<'a>(v: &'a Json, key: &str) -> &'a Json {
    static NULL: Json = Json::Null;
    if let Json::Object(fields) = v {
        fields
            .iter()
            .find(|(k, _)| k == &JsString::from(key))
            .map_or(&NULL, |(_, v)| v)
    } else {
        &NULL
    }
}
fn array(v: &Json) -> &[Json] {
    if let Json::Array(v) = v {
        v
    } else {
        &[]
    }
}
fn js(v: &Json) -> JsString {
    if let Json::String(v) = v {
        v.clone()
    } else {
        JsString::from("")
    }
}
fn text(v: &Json) -> String {
    js(v).to_utf8_lossy()
}
#[test]
fn canonical_segments_fields_formats_and_confirmed_mapping_match_node_bytes() {
    let mappings = HashMap::from([
        (
            JsString::from("speaker_0"),
            JsString::from("Confirmed Fixture"),
        ),
        (JsString::from("unknown"), JsString::from("Unknown Fixture")),
    ]);
    for case in array(get(&fixture(), "normalized")) {
        let input = get(case, "input");
        let segments = Json::Array(vec![input.clone()]);
        assert_eq!(
            write_json(&speaker::normalize_segment(input)),
            text(get(case, "line"))
        );
        assert_eq!(
            speaker::format_segments(&segments).to_json(),
            text(get(case, "formattedLine"))
        );
        assert_eq!(
            write_json(&speaker::apply_mappings(&segments, &mappings)),
            text(get(case, "mappedLine"))
        );
    }
    assert_eq!(
        speaker::normalize_segments(&Json::Null),
        Json::Array(vec![])
    );
}
#[test]
fn hidden_media_identifiers_preserve_pinned_prefix_and_global_matching() {
    for case in array(get(&fixture(), "media")) {
        let input = js(get(case, "input"));
        assert_eq!(
            speaker::strip_media_token(&input).unwrap().to_json(),
            text(get(case, "strippedLine"))
        );
        assert_eq!(
            serde_json::to_string(&speaker::media_ids(&input).unwrap()).unwrap(),
            write_json(get(case, "ids"))
        );
    }
}
fn agent() -> AgentContext {
    serde_json::from_value(json!({"origin":"user","background":false})).unwrap()
}
fn manual(agent: &str, label: &str, name: &str) -> SpeakerMapping {
    SpeakerMapping {
        agent_id: agent.into(),
        speaker_label: label.into(),
        speaker_display_name: name.into(),
        attribution_source: "manual".into(),
        confidence: Some(1.),
        confirmed: 1,
        proposed_at: NOW,
        confirmed_at: Some(NOW),
        context_hint: None,
    }
}
struct Setup {
    _root: tempfile::TempDir,
    store: Arc<SpeakerMappings>,
    context: Arc<OperationContext>,
    facade: CallerSpeakers,
    p: Principal,
}
fn setup() -> Setup {
    let root = support::canonical_tempdir();
    let host = Arc::new(support::TestHost::new(root.path().into()));
    host.set_workspace("alpha", root.path().into());
    host.time.store(NOW, Ordering::SeqCst);
    let context = Arc::new(OperationContext::new(host));
    let store = Arc::new(SpeakerMappings::open(&root.path().join("mappings.sqlite")).unwrap());
    let facade = CallerSpeakers::new(context.clone(), store.clone());
    let p=serde_json::from_value(json!({"agentId":"alpha","workspace":format!("workspace-dir:v1:{}",root.path().display()),"user":harness_user_principal("fixture-user"),"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap();
    Setup {
        _root: root,
        store,
        context,
        facade,
        p,
    }
}
#[test]
fn speaker_labels_map_through_real_sqlite_and_new_names_remain_pending_proposals() {
    for case in array(get(&fixture(), "proposals")) {
        let s = setup();
        if get(case, "confirmed") == &Json::Bool(true) {
            s.store
                .upsert(&manual("alpha", "speaker_0", "Confirmed Fixture"))
                .unwrap();
        }
        s.store
            .upsert(&manual("beta", "speaker_0", "Other Agent"))
            .unwrap();
        let input = get(case, "segments");
        let result = s
            .facade
            .propose_and_store(input, &s.p, &agent(), &Cancel::never())
            .unwrap();
        assert_eq!(
            write_json(&Json::Array(
                result
                    .proposals
                    .iter()
                    .map(speaker::SpeakerProposal::to_json)
                    .collect()
            )),
            text(get(case, "line")),
            "{}",
            text(get(case, "text"))
        );
        assert_eq!(
            serde_json::to_string(&result.counts).unwrap(),
            write_json(get(case, "first"))
        );
        let repeated = s
            .facade
            .propose_and_store(input, &s.p, &agent(), &Cancel::never())
            .unwrap();
        assert_eq!(
            serde_json::to_string(&repeated.counts).unwrap(),
            write_json(get(case, "second"))
        );
        // SQLite REAL columns are compared through the shared typed representation.
        let rows: Vec<SpeakerMapping> = serde_json::from_str(&text(get(case, "rowsLine"))).unwrap();
        assert_eq!(s.store.list("alpha").unwrap(), rows);
        assert_eq!(
            write_json(
                &s.facade
                    .mapped_segments(input, &s.p, &agent(), &Cancel::never())
                    .unwrap()
            ),
            text(get(case, "mappedLine"))
        );
        assert_eq!(
            s.store.list("beta").unwrap(),
            vec![manual("beta", "speaker_0", "Other Agent")]
        );
    }
}
#[test]
fn concurrent_proposals_do_not_replace_existing_pending_or_confirmed_names() {
    let s = setup();
    let input = parse_json(r#"[{"speakerLabel":"speaker_0","text":"Hallo Alex!"}]"#).unwrap();
    let counts = std::thread::scope(|scope| {
        let workers = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    s.facade
                        .propose_and_store(&input, &s.p, &agent(), &Cancel::never())
                        .unwrap()
                        .counts
                        .stored
                })
            })
            .collect::<Vec<_>>();
        workers
            .into_iter()
            .map(|t| t.join().unwrap())
            .sum::<usize>()
    });
    assert_eq!(counts, 1);
    let pending = s.store.list("alpha").unwrap();
    assert_eq!(pending[0].confirmed, 0);
    assert!(s.store.confirm("alpha", "speaker_0", NOW + 1).unwrap());
    let confirmed = s.store.list("alpha").unwrap();
    let other = parse_json(r#"[{"speakerLabel":"speaker_0","text":"Hallo Jordan!"}]"#).unwrap();
    assert!(s
        .facade
        .propose_and_store(&other, &s.p, &agent(), &Cancel::never())
        .unwrap()
        .proposals
        .is_empty());
    assert_eq!(s.store.list("alpha").unwrap(), confirmed);
}
#[test]
fn invalid_identity_surrogate_label_cancel_and_closed_context_cannot_write_proposals() {
    let s = setup();
    let input = parse_json(r#"[{"speakerLabel":"s\ud83d","text":"Hallo Alex!"}]"#).unwrap();
    assert!(s
        .facade
        .propose_and_store(&input, &s.p, &agent(), &Cancel::never())
        .is_err());
    let input = parse_json(r#"[{"speakerLabel":"speaker_0","text":"Hallo Alex!"}]"#).unwrap();
    let mut foreign = s.p.clone();
    foreign.workspace = serde_json::from_value(json!("workspace-dir:v1:/foreign")).unwrap();
    assert!(s
        .facade
        .propose_and_store(&input, &foreign, &agent(), &Cancel::never())
        .is_err());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(s
        .facade
        .propose_and_store(&input, &s.p, &agent(), &cancel)
        .is_err());
    s.context.close();
    assert!(s
        .facade
        .propose_and_store(&input, &s.p, &agent(), &Cancel::never())
        .is_err());
    assert!(s.store.list("alpha").unwrap().is_empty());
}

#[test]
fn node_sqlite_identity_aliases_are_refused_before_any_native_proposal_write() {
    for case in array(get(&fixture(), "identityAliases")) {
        let node_rows = parse_json(&text(get(case, "rowsLine"))).unwrap();
        assert_eq!(array(&node_rows).len(), 1);
        assert_eq!(
            get(&array(&node_rows)[0], "speakerLabel"),
            &Json::String(JsString::from("s�"))
        );
        assert_eq!(
            write_json(get(case, "counts")),
            r#"{"stored":1,"skipped":1}"#
        );
        let s = setup();
        assert!(s
            .facade
            .propose_and_store(get(case, "segments"), &s.p, &agent(), &Cancel::never())
            .is_err());
        assert!(s
            .facade
            .mapped_segments(get(case, "segments"), &s.p, &agent(), &Cancel::never())
            .is_err());
        assert!(s.store.list("alpha").unwrap().is_empty());
    }
}
