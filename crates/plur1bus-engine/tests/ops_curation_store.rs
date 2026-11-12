//! Actual A1 facade + C4 files; fixture contexts are resolved synthetically, not host grants.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Cancel, Principal},
    neo::merged::{Layout, MetadataReader},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use serde_json::{json, Value};
use std::{fs, path::Path};
fn field<'a>(value: &'a Json, name: &str) -> Option<&'a Json> {
    match value {
        Json::Object(fields) => fields
            .iter()
            .find(|(k, _)| k == &name.into())
            .map(|(_, v)| v),
        _ => None,
    }
}
fn context(owner: &Value, key: &str) -> RequestContext {
    let host = support::TestHost::new("/fixture/state".into());
    let principal:Principal=serde_json::from_value(json!({"agentId":"alpha","workspace":"workspace:v1:curation","user":owner,"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap();
    let agent: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let mut ctx = RequestContext::build(&principal, &agent, &host).unwrap();
    ctx.workspace_key = key.into();
    ctx
}
fn seed(root: &Path, key: &str, input: &Json) {
    let layout = Layout::for_key(key);
    let canonical = root.join("workspaces").join(layout.canonical);
    let legacy = root.join("workspaces").join(if key == "curation" {
        "curation"
    } else {
        "workspace_v1_curation"
    });
    for (dir, file, name) in [
        (&canonical, "memory-candidates.jsonl", "candidates"),
        (&canonical, "behavior-cards.jsonl", "behavior"),
        (&legacy, "memory-candidates.jsonl", "legacy"),
    ] {
        let Some(Json::Array(rows)) = field(input, name) else {
            continue;
        };
        if rows.is_empty() {
            continue;
        }
        fs::create_dir_all(dir).unwrap();
        let output = rows
            .iter()
            .map(|v| format!("{}\n", write_json(v)))
            .collect::<String>();
        fs::write(dir.join(file), output).unwrap();
    }
}
#[test]
fn twenty_eight_actual_node_file_lists_match_with_bound_d130_exception() {
    use sha2::{Digest, Sha256};
    let raw = include_bytes!("fixtures/ops/golden/curation-store.json");
    let golden: Value = serde_json::from_slice(raw).unwrap();
    let exceptions: Value = serde_json::from_str(include_str!(
        "fixtures/ops/curation-store-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(raw)),
        exceptions["nodeGoldenSha256"]
    );
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/ops/golden/curation-list.json"))
        ),
        golden["a1SourceManifestSha256"]
    );
    for (index, case) in golden["cases"].as_array().unwrap().iter().enumerate() {
        let root = support::canonical_tempdir();
        let input = parse_json(case["inputJson"].as_str().unwrap()).unwrap();
        let Some(Json::String(key)) = field(&input, "workspace") else {
            panic!("key")
        };
        let key = key.to_utf8_lossy();
        let ctx = context(&golden["requester"]["ownerUserId"], &key);
        seed(root.path(), &key, &input);
        let reader = MetadataReader::open(root.path(), &key).unwrap();
        let limit = match field(&input, "query").and_then(|v| field(v, "limit")) {
            Some(Json::Number(v)) => Some(v.parse().unwrap()),
            _ => None,
        };
        let result = reader.read_curation(limit, &ctx, &Cancel::never());
        if case.get("error").is_some() {
            assert!(result.is_err());
            continue;
        }
        let expected = exceptions["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["index"].as_u64() == Some(index as u64))
            .unwrap_or(case);
        assert_eq!(
            write_json(&result.unwrap()),
            expected["outputJson"].as_str().unwrap(),
            "case {index}"
        );
    }
}
#[test]
fn absent_read_creates_nothing_and_wrong_workspace_or_cancel_refuses() {
    let root = support::canonical_tempdir();
    let key = "workspace:v1:curation";
    let ctx = context(
        &json!(plur1bus_engine::context::harness_user_principal("fixture")),
        key,
    );
    let reader = MetadataReader::open(root.path(), key).unwrap();
    let result = reader.read_curation(None, &ctx, &Cancel::never()).unwrap();
    assert_eq!(field(&result, "items"), Some(&Json::Array(vec![])));
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    let mut other = ctx.clone();
    other.workspace_key = "other".into();
    assert!(reader
        .read_curation(None, &other, &Cancel::never())
        .is_err());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(reader.read_curation(None, &ctx, &cancel).is_err());
}
#[test]
fn malformed_rows_and_ambiguous_fields_are_not_silently_discarded() {
    let root = support::canonical_tempdir();
    let key = "workspace:v1:curation";
    let ctx = context(
        &json!(plur1bus_engine::context::harness_user_principal("fixture")),
        key,
    );
    let dir = root
        .path()
        .join("workspaces")
        .join(Layout::for_key(key).canonical);
    fs::create_dir_all(&dir).unwrap();
    let reader = MetadataReader::open(root.path(), key).unwrap();
    for bytes in [
        "broken\n",
        "{\"id\":\"x\",\"id\":\"y\"}\n",
        "{\"id\":\"x\",\"createdAt\":\"11/08/2026\"}\n",
    ] {
        fs::write(dir.join("memory-candidates.jsonl"), bytes).unwrap();
        assert!(reader.read_curation(None, &ctx, &Cancel::never()).is_err());
        assert_eq!(
            fs::read_to_string(dir.join("memory-candidates.jsonl")).unwrap(),
            bytes
        );
    }
}
#[test]
fn pending_revision_invalid_utf8_and_oversize_sources_refuse_without_writes() {
    let root = support::canonical_tempdir();
    let key = "workspace:v1:curation";
    let ctx = context(
        &json!(plur1bus_engine::context::harness_user_principal("fixture")),
        key,
    );
    let dir = root
        .path()
        .join("workspaces")
        .join(Layout::for_key(key).canonical);
    fs::create_dir_all(&dir).unwrap();
    let reader = MetadataReader::open(root.path(), key).unwrap();
    let pending = dir.join("native-revision-state.json");
    fs::write(&pending, "{\"complete\":false}").unwrap();
    assert!(reader.read_curation(None, &ctx, &Cancel::never()).is_err());
    assert_eq!(
        fs::read_to_string(&pending).unwrap(),
        "{\"complete\":false}"
    );
    fs::remove_file(pending).unwrap();
    let file = dir.join("memory-candidates.jsonl");
    fs::write(&file, [255, 10]).unwrap();
    assert!(reader.read_curation(None, &ctx, &Cancel::never()).is_err());
    assert_eq!(fs::read(&file).unwrap(), [255, 10]);
    fs::File::create(&file)
        .unwrap()
        .set_len(64 * 1024 * 1024 + 1)
        .unwrap();
    assert!(reader.read_curation(None, &ctx, &Cancel::never()).is_err());
    assert_eq!(fs::metadata(file).unwrap().len(), 64 * 1024 * 1024 + 1);
}
#[cfg(unix)]
#[test]
fn linked_sources_and_replaced_root_fail_closed() {
    use std::os::unix::fs::symlink;
    let root = support::canonical_tempdir();
    let key = "workspace:v1:curation";
    let ctx = context(
        &json!(plur1bus_engine::context::harness_user_principal("fixture")),
        key,
    );
    let base = root.path().join("neo");
    fs::create_dir(&base).unwrap();
    let dir = base.join("workspaces").join(Layout::for_key(key).canonical);
    fs::create_dir_all(&dir).unwrap();
    let reader = MetadataReader::open(&base, key).unwrap();
    let external = root.path().join("external");
    fs::write(&external, "{}\n").unwrap();
    let file = dir.join("memory-candidates.jsonl");
    symlink(&external, &file).unwrap();
    assert!(reader.read_curation(None, &ctx, &Cancel::never()).is_err());
    fs::remove_file(&file).unwrap();
    fs::hard_link(&external, &file).unwrap();
    assert!(reader.read_curation(None, &ctx, &Cancel::never()).is_err());
    fs::rename(&base, root.path().join("old-neo")).unwrap();
    fs::create_dir(&base).unwrap();
    assert!(reader.read_curation(None, &ctx, &Cancel::never()).is_err());
    assert_eq!(fs::read_to_string(external).unwrap(), "{}\n");
}
