use super::*;
use serde_json::Value;

fn scope(e: &Execution) -> Scope {
    Scope {
        owner: e.owner.clone(),
        agent_id: e.agent_id.clone(),
        scope: "scope-a".into(),
    }
}

fn row(call: &str) -> Execution {
    Execution {
        owner: "owner-a".into(),
        agent_id: "alpha".into(),
        session_id: "s1".into(),
        turn_id: "t1".into(),
        call_id: call.into(),
        tool: "file.read".into(),
        version: "a".repeat(64),
        success: true,
    }
}

#[test]
fn workflow_execution_proof_is_exact() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/skills/evidence.json"
    ))
    .unwrap();
    let store = Store::open(Path::new(":memory:")).unwrap();
    let known: Execution = serde_json::from_value(fixture["known"].clone()).unwrap();
    let unsuccessful: Execution = serde_json::from_value(fixture["failed"].clone()).unwrap();
    store.record(&known).unwrap();
    store.record(&known).unwrap();
    store.record(&unsuccessful).unwrap();
    for entry in fixture["verified"].as_array().unwrap() {
        let e: Execution = serde_json::from_value(entry["value"].clone()).unwrap();
        assert_eq!(
            store.verified(&scope(&e), &e).unwrap(),
            entry["verified"].as_bool().unwrap(),
            "{}",
            entry["name"]
        );
    }
    let forged = Execution {
        owner: "owner-b".into(),
        ..known.clone()
    };
    assert!(store.record(&forged).is_err());
    let finalized = &fixture["finalized"];
    assert_eq!(finalized["divergence"], "finalized-evidence-is-immutable");
    let changed: Execution = serde_json::from_value(finalized["changed"].clone()).unwrap();
    assert_eq!(finalized["after"], false);
    assert!(store.record(&changed).is_err());
    assert!(store.verified(&scope(&known), &known).unwrap());
}

#[test]
fn both_actors_round_trip_the_sqlite_execution_ledger() {
    let dir = tempfile::tempdir().unwrap();
    let file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/core-parity/k7c-evidence-driver.ts");
    let drive = |step| {
        let output = std::process::Command::new("node")
            .args(["--experimental-strip-types", "--conditions=source"])
            .arg(&file)
            .arg(step)
            .arg(dir.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    };
    drive("seed");
    let permission = |p: &Path| cfg!(windows) || crate::private_store::default_secure(p);
    let a = dir.path().join("from-ts.sqlite");
    let b = dir.path().join("from-rust.sqlite");
    let e = row("from-ts");
    {
        let ts = Store::open_with_permissions(&a, &permission).unwrap();
        let rust = Store::open_with_permissions(&b, &permission).unwrap();
        assert!(ts.verified(&scope(&e), &e).unwrap());
        ts.record(&row("rust-update")).unwrap();
        rust.record(&row("from-rust")).unwrap();
    }
    assert_eq!(drive("verify"), b"SKILL_EVIDENCE_MODE_B_OK\n");
    let rust = Store::open_with_permissions(&b, &permission).unwrap();
    let update = row("ts-update");
    assert!(!rust.verified(&scope(&update), &update).unwrap());
    assert!(rust.record(&update).is_err());
}
