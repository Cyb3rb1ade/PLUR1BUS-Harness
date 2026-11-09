//! Actual C4 revisions, source-store preservation and durable audit/queue ordering.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "support/neo_curation_writer.rs"]
mod curation_writer;
#[path = "support/neo_revision_edges.rs"]
mod edges;
#[cfg(feature = "testkit")]
#[path = "support/neo_revision_startup.rs"]
mod startup;
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    context::{harness_user_principal, RequestContext},
    contract::{AgentContext, Cancel, EngineError, Principal},
    neo::{
        capture_journal::CaptureJournal,
        merged::Layout,
        revisions::{Action, RevisionRequest, RevisionStore},
    },
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

struct Policy(AtomicBool);
impl CapturePolicy for Policy {
    fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    workspace: PathBuf,
    directory: PathBuf,
    host: Arc<support::TestHost>,
    policy: Arc<Policy>,
    principal: Principal,
    agent: AgentContext,
    context: RequestContext,
    store: RevisionStore,
}
fn fixture() -> Fixture {
    let root = support::canonical_tempdir();
    let workspace = root.path().join("workspace");
    let neo = root.path().join("neo");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&neo).unwrap();
    let host = Arc::new(support::TestHost::new(root.path().join("state")));
    host.set_workspace("alpha", workspace.clone());
    host.time.store(1794139200000, Ordering::SeqCst);
    let principal = serde_json::from_value(json!({"agentId":"alpha","workspace":format!("workspace-dir:v1:{}",workspace.display()),"user":harness_user_principal("fixture"),"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap();
    let agent = serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let context = RequestContext::build(&principal, &agent, host.as_ref()).unwrap();
    let policy = Arc::new(Policy(AtomicBool::new(true)));
    let journal = Arc::new(CaptureJournal::open(&neo, host.clone(), policy.clone()).unwrap());
    let store = RevisionStore::new(journal, host.clone());
    let directory = neo
        .join("workspaces")
        .join(Layout::for_key(&context.workspace_key).canonical);
    fs::create_dir_all(&directory).unwrap();
    Fixture {
        _root: root,
        workspace,
        directory,
        host,
        policy,
        principal,
        agent,
        context,
        store,
    }
}
fn field<'a>(v: &'a Json, key: &str) -> &'a Json {
    let Json::Object(fields) = v else {
        panic!("not object")
    };
    &fields
        .iter()
        .find(|(k, _)| k == &JsString::from(key))
        .unwrap()
        .1
}
fn set(v: &mut Json, key: &str, value: Json) {
    let Json::Object(fields) = v else {
        panic!("not object")
    };
    if let Some((_, old)) = fields.iter_mut().find(|(k, _)| k == &JsString::from(key)) {
        *old = value;
    } else {
        fields.push((JsString::from(key), value));
    }
}
fn text(s: &str) -> Json {
    Json::String(JsString::from(s))
}
fn string(v: &Json) -> String {
    let Json::String(v) = v else {
        panic!("not string")
    };
    v.to_utf8_lossy()
}
fn rows(path: impl AsRef<std::path::Path>) -> Vec<Json> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|s| !s.trim().is_empty())
        .map(|s| parse_json(s).unwrap())
        .collect()
}
fn cases() -> Vec<Json> {
    let golden = parse_json(include_str!("fixtures/capture/golden/neo-revisions.json")).unwrap();
    let Json::Array(cases) = field(&golden, "cases") else {
        panic!("not cases")
    };
    cases.clone()
}
fn bound(f: &Fixture, row: &Json) -> Json {
    let mut row = row.clone();
    set(&mut row, "workspaceKey", text(&f.context.workspace_key));
    row
}
fn source(f: &Fixture, case: &Json) -> Json {
    let source = bound(f, field(case, "source"));
    let origin = string(field(case, "origin"));
    fs::write(
        f.directory.join(if origin == "behavior" {
            "behavior-cards.jsonl"
        } else {
            "memory-candidates.jsonl"
        }),
        format!("{}\n", write_json(&source)),
    )
    .unwrap();
    source
}
fn request(case: &Json, expected: Json) -> RevisionRequest {
    RevisionRequest {
        operation_id: uuid::Uuid::new_v4(),
        expected,
        action: Action::parse(&string(field(case, "action"))).unwrap(),
    }
}
#[test]
fn actual_node_revisions_keep_the_origin_store_and_audit_shape() {
    for case in cases() {
        let f = fixture();
        let expected = source(&f, &case);
        let request = request(&case, expected);
        let result = f
            .store
            .apply(&f.principal, &f.agent, &request, &Cancel::never())
            .unwrap();
        assert_eq!(
            result.record,
            bound(&f, field(&case, "revision")),
            "{}",
            string(field(&case, "name"))
        );
        let origin = string(field(&case, "origin"));
        assert_eq!(result.store, origin);
        let target = if origin == "behavior" {
            "behavior-cards.jsonl"
        } else {
            "memory-candidates.jsonl"
        };
        let opposite = if origin == "behavior" {
            "memory-candidates.jsonl"
        } else {
            "behavior-cards.jsonl"
        };
        assert_eq!(rows(f.directory.join(target)).last(), Some(&result.record));
        assert!(rows(f.directory.join(opposite)).is_empty());
        let audit = rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl"));
        let Json::Array(node_audit) = field(&case, "audit") else {
            panic!("audit")
        };
        assert_eq!(audit.len(), 1);
        let Json::Object(fields) = &node_audit[0] else {
            panic!("audit object")
        };
        for (key, value) in fields {
            assert_eq!(field(&audit[0], &key.to_utf8_lossy()), value);
        }
        let queue = rows(f.directory.join("embedding-queue.jsonl"));
        let Json::Array(node_queue) = field(&case, "queue") else {
            panic!("queue")
        };
        assert_eq!(queue.len(), node_queue.len());
        for (native, node) in queue.iter().zip(node_queue) {
            let node = bound(&f, node);
            let Json::Object(fields) = node else {
                panic!("queue object")
            };
            for (key, value) in fields {
                assert_eq!(field(native, &key.to_utf8_lossy()), &value);
            }
            assert_eq!(field(native, "scope"), &text("agent_private"));
            assert_eq!(
                field(native, "ownerUserId"),
                &text(&f.context.owner_user_id)
            );
        }
        let replay = f
            .store
            .apply(&f.principal, &f.agent, &request, &Cancel::never())
            .unwrap();
        assert_eq!(replay.record, result.record);
        assert_eq!(rows(f.directory.join(target)).len(), 2);
        assert_eq!(
            rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")),
            audit
        );
        assert_eq!(rows(f.directory.join("embedding-queue.jsonl")), queue);
    }
}
#[test]
fn stale_revision_and_revoked_policy_never_append() {
    let case = cases().remove(1);
    let f = fixture();
    let current = source(&f, &case);
    let stale = request(&case, bound(&f, field(&case, "hint")));
    assert!(f
        .store
        .apply(&f.principal, &f.agent, &stale, &Cancel::never())
        .is_err());
    f.policy.0.store(false, Ordering::SeqCst);
    assert!(f
        .store
        .apply(
            &f.principal,
            &f.agent,
            &request(&case, current),
            &Cancel::never()
        )
        .is_err());
    assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 1);
    assert!(!f.workspace.join(".adaptive-learning").exists());
}
