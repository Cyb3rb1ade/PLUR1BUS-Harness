//! The audit chain across languages (P4-K K2, plan P4-21): the Rust core's sink (`plur1bus_core::audit::ChainSink`, over
//! `plur1bus-audit`) writes, the TypeScript verifier reads (`tests/core-parity/audit-chain-driver.ts`), the TypeScript core
//! appends to the same file, and the Rust sink appends after it. The chain stays one verified chain and no secret-keyed
//! value reaches it. Needs Node (`PLUR1BUS_NODE` or `node` on PATH) with the workspace's TypeScript sources.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_core::audit::ChainSink;
use plur1bus_core::rbac::audit::{detail_redactor, AuditEvent, AuditSink};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn driver(command: &str, dir: &Path) -> Value {
    let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(&node)
        .current_dir(root())
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
            "tests/core-parity/audit-chain-driver.ts",
            command,
        ])
        .arg(dir)
        .output()
        .unwrap_or_else(|e| {
            panic!("could not run Node {node:?}: {e}. Install Node and run `pnpm test:prep`.")
        });
    assert!(
        output.status.success(),
        "audit-chain-driver {command}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn event(at: i64, action: &str, detail: Vec<(&str, Value)>) -> AuditEvent {
    AuditEvent {
        at,
        user: "christian".into(),
        host: "h1".into(),
        action: action.into(),
        target: "tool:fs.read".into(),
        detail: detail.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
    }
}

#[test]
fn the_typescript_verifier_accepts_a_chain_the_rust_sink_writes_and_both_writers_share_it() {
    let redactor = detail_redactor().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut sink = ChainSink::new(
        dir.path().to_path_buf(),
        "core",
        "h1",
        "plur1bus-core",
        &redactor,
    );
    sink.append(&event(
        1,
        "policy.decision",
        vec![("rule", json!("approval-class")), ("über", json!("✓ 😀"))],
    ))
    .unwrap();
    sink.append(&event(
        2,
        "policy.decision",
        vec![("apiKey", json!("not-a-real-key-value")), ("n", json!(1.5))],
    ))
    .unwrap();

    let first = driver("verify", dir.path());
    assert_eq!(first["result"]["ok"], true, "{first}");
    assert_eq!(first["result"]["records"], 2);
    assert_eq!(first["result"]["anchor"]["status"], "match");
    assert_eq!(first["records"][0]["detail"]["über"], "✓ 😀");
    assert!(
        !first.to_string().contains("not-a-real-key-value"),
        "the secret-keyed value is redacted"
    );

    driver("append", dir.path());
    sink.append(&event(4, "grant.used", vec![("grantId", json!("g9"))]))
        .unwrap();
    let last = driver("verify", dir.path());
    assert_eq!(last["result"]["ok"], true, "{last}");
    assert_eq!(last["result"]["records"], 4);
    assert_eq!(last["result"]["lastSeq"], 4);
    let actions: Vec<&str> = last["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["action"].as_str().unwrap())
        .collect();
    assert_eq!(
        actions,
        [
            "policy.decision",
            "policy.decision",
            "grant.created",
            "grant.used"
        ]
    );
}
