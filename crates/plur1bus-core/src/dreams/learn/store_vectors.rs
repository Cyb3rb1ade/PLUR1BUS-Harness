use super::*;
use crate::toolcall::json::parse;
use serde_json::{json, Value};

#[test]
fn a_newer_learning_store_is_refused_before_wal_or_permission_changes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("newer.sqlite");
    {
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
    }
    let bytes = std::fs::read(&path).unwrap();
    let permission_calls = std::cell::Cell::new(0);
    let result = LearnStore::open_private(&path, &|_, _| true, &|_, _| {
        permission_calls.set(permission_calls.get() + 1);
        true
    });
    assert_eq!(
        result.err().unwrap().reason.as_deref(),
        Some("schema-too-new")
    );
    let after = std::fs::read(&path).unwrap();
    assert!(
        after == bytes,
        "opening a newer learning store changed its bytes"
    );
    assert_eq!(permission_calls.get(), 0);
}

fn target(owner: &str, agent: &str) -> Target {
    Target {
        scope: "agent".into(),
        owner: owner.into(),
        agent_id: agent.into(),
        project_id: None,
    }
}

#[test]
fn reading_learning_runs_requires_the_targets_owner() {
    let store = LearnStore::open(Path::new(":memory:")).unwrap();
    let owned = target("ada", "alpha");
    store.begin(&owned, Window { from: 1, to: 10 }, 11).unwrap();
    assert_eq!(store.runs("ada", Some(&owned)).unwrap().len(), 1);
    let refused = store.runs("another", Some(&owned));
    assert!(matches!(refused, Err(error) if error.code == C::Unauthorized));
}

struct MissingSession;
impl Reconcile for MissingSession {
    fn target(&self, _: &Target) -> bool {
        true
    }
    fn session(&self, _: &Target, _: &str) -> bool {
        false
    }
    fn evidence(&self, _: &Target, _: &V) -> bool {
        false
    }
}

fn projected(value: Option<V>) -> Value {
    value.map_or(Value::Null, |v| {
        serde_json::from_str(&v.stringify()).unwrap()
    })
}

#[test]
fn learn_store_matches_typescript() {
    let expected: Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/learn/store.json"
    ))
    .unwrap();
    let store = LearnStore::open(Path::new(":memory:")).unwrap();
    let ada = target("ada", "alpha");
    let ben = target("ben", "alpha");
    let win = Window { from: 100, to: 200 };
    let mut run = store.begin(&ada, win, 201).unwrap();
    let initial = run.clone();
    let same_window = store.begin(&ada, win, 210).unwrap();
    run.session_ids = vec!["fixture-session".into()];
    run.digest = "fixture-digest".into();
    run.tokens = 5;
    store.save(&run).unwrap();
    let key = "extract:fixture-session";
    let model =
        parse(r#"{"text":"[]","inputTokens":2,"outputTokens":1,"model":"fixture"}"#).unwrap();
    store.checkpoint(&run.id, key, &model).unwrap();
    let checkpoint = projected(store.payload(&run.id, key).unwrap());
    let runs_before = store.runs(&ada.owner, Some(&ada)).unwrap();
    store
        .finish(&run, Outcome::Failed, Some("provider-failed"), 300)
        .unwrap();
    let retained = projected(store.payload(&run.id, key).unwrap());
    for from in [200, 300] {
        let attempt = store
            .begin(
                &ada,
                Window {
                    from,
                    to: from + 100,
                },
                from + 100,
            )
            .unwrap();
        store
            .finish(
                &attempt,
                Outcome::Failed,
                Some("provider-failed"),
                from + 200,
            )
            .unwrap();
    }
    store.begin(&ben, win, 201).unwrap();
    let breaker = store.breaker_open(&ada, 500).unwrap();
    let other_breaker = store.breaker_open(&ben, 500).unwrap();
    let next_day_breaker = store.breaker_open(&ada, 86_400_000).unwrap();
    let health = store.health(500).unwrap();
    store.reconcile(600, 30, &MissingSession).unwrap();
    assert_eq!(
        json!({"initial":initial,"sameWindow":same_window,"checkpoint":checkpoint,"runsBefore":runs_before,
        "retained":retained,"breaker":breaker,"otherBreaker":other_breaker,"nextDayBreaker":next_day_breaker,"health":health,
        "invalidated":store.invalidated(&run.id).unwrap(),"afterReconcile":store.get(&run.id).unwrap(),"afterPayload":projected(store.payload(&run.id,key).unwrap())}),
        expected
    );
    assert!(store.checkpoint(&run.id, key, &model).is_err());
}

#[test]
fn both_actors_open_read_and_extend_the_learn_store() {
    let dir = tempfile::tempdir().unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/core-parity/k7b-learn-store-driver.ts");
    let drive = |op| {
        let output = std::process::Command::new("node")
            .args(["--experimental-strip-types", "--conditions=source"])
            .arg(&script)
            .arg(op)
            .arg(dir.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    };
    let id = drive("prepare");
    let id = id.trim();
    let protected = |_: &Path, _: u32| true;
    {
        let store =
            LearnStore::open_with_permissions(&dir.path().join("learn-from-ts.db"), &protected)
                .unwrap();
        let run = store.get(id).unwrap().unwrap();
        assert_eq!(run.session_ids, ["fixture"]);
        assert_eq!(run.digest, "evidence-digest");
        assert!(store.payload(id, "extract:fixture").unwrap().is_some());
        store.finish(&run, Outcome::Completed, None, 29).unwrap();
    }
    {
        let store =
            LearnStore::open_with_permissions(&dir.path().join("learn-from-rust.db"), &protected)
                .unwrap();
        let mut run = store
            .begin(
                &target("fixture-owner", "fixture-agent"),
                Window { from: 10, to: 20 },
                26,
            )
            .unwrap();
        assert_eq!(run.id, id);
        run.tokens = 8;
        store.save(&run).unwrap();
        store
            .checkpoint(&run.id, "extract:fixture", &V::s("placeholder"))
            .unwrap();
        store
            .finish(&run, Outcome::Failed, Some("invalid-output"), 30)
            .unwrap();
    }
    {
        let legacy =
            LearnStore::open_with_permissions(&dir.path().join("learn-v2-to-rust.db"), &protected)
                .unwrap();
        assert_eq!(legacy.health(25).unwrap().schema, 7);
        let old = legacy.findings("legacy-run").unwrap();
        assert_eq!(old.len(), 1);
        let id = old[0].get("id").unwrap().as_js().unwrap().lossy();
        assert!(legacy
            .prediction(&id)
            .unwrap()
            .unwrap()
            .get("status")
            .unwrap()
            .is_str("insufficient-data"));
    }
    assert_eq!(drive("verify"), "LEARN_MODE_B_OK\n");
}
