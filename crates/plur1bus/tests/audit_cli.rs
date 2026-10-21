//! `plur1bus audit verify` and `audit reanchor` CLI tests (B5). The verifier itself is covered by `packages/core/test/audit/`
//! and the writers' recovery by `src/audit_chain.rs`; here only what the CLI does on its own.
use assert_cmd::prelude::*;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn bin() -> Command {
    Command::cargo_bin("plur1bus").unwrap()
}

#[test]
fn audit_help_shows_experimental_on_each_leaf() {
    let out = bin().args(["audit", "--help"]).assert().success();
    assert!(String::from_utf8(out.get_output().stdout.clone())
        .unwrap()
        .contains("[experimental]"));
    let out = bin().args(["audit", "verify", "--help"]).assert().success();
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    assert!(text.contains("[experimental]"));
    let out = bin()
        .args(["audit", "reanchor", "--help"])
        .assert()
        .success();
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    assert!(text.contains("[experimental]"));
    assert!(text.contains("--reason <TEXT>") && text.contains("--dry-run"));
}

#[test]
fn audit_verify_without_a_core_is_a_clean_error_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let out = bin()
        .arg("--home")
        .arg(&home)
        .args(["--json", "audit", "verify"])
        .assert()
        .failure();
    let doc: Value = serde_json::from_slice(&out.get_output().stdout).unwrap();
    assert_eq!(doc["schema"], "error/1");
    assert!(
        !home.join("logs").exists(),
        "the CLI never writes audit files"
    );
}

// --- `audit reanchor` ---------------------------------------------------------------------------------------------

/// The three chain lines of `tests/fixtures/audit-chain-v1.json`, with their hashes.
fn fixture_lines() -> Vec<(String, String)> {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/audit-chain-v1.json")).unwrap();
    fixture["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["line"].as_str().unwrap().to_string(),
                l["hash"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

/// A home whose `logs/` holds the fixture chain (three lines) and, when given, this anchor text.
fn home_with_chain(anchor: Option<String>) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let logs = home.join("logs");
    fs::create_dir_all(&logs).unwrap();
    let text: String = fixture_lines()
        .iter()
        .map(|(line, _)| format!("{line}\n"))
        .collect();
    fs::write(logs.join("audit-chain.jsonl"), text).unwrap();
    if let Some(anchor) = anchor {
        fs::write(logs.join("audit-chain.anchor"), anchor).unwrap();
    }
    (dir, home)
}

fn anchor_at(seq: usize) -> String {
    let hash = fixture_lines()[seq - 1].1.clone();
    serde_json::json!({"v": 1, "seq": seq, "hash": hash}).to_string()
}

fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_file() && !p.to_string_lossy().ends_with(".lock"))
        .map(|p| {
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                fs::read(&p).unwrap(),
            )
        })
        .collect()
}

fn stdout_json(out: &assert_cmd::assert::Assert) -> Value {
    serde_json::from_slice(&out.get_output().stdout).unwrap()
}

#[test]
fn reanchor_needs_a_reason_unless_it_is_a_dry_run() {
    let (_dir, home) = home_with_chain(None);
    let before = snapshot(&home.join("logs"));
    bin()
        .arg("--home")
        .arg(&home)
        .args(["audit", "reanchor"])
        .assert()
        .failure()
        .code(2);
    assert_eq!(snapshot(&home.join("logs")), before);
}

#[test]
fn reanchor_on_a_chain_writers_accept_is_nothing_to_repair() {
    let (_dir, home) = home_with_chain(Some(anchor_at(3)));
    let before = snapshot(&home.join("logs"));
    let out = bin()
        .arg("--home")
        .arg(&home)
        .args(["--json", "audit", "reanchor", "--reason", "just checking"])
        .assert()
        .failure()
        .code(2);
    let doc = stdout_json(&out);
    assert_eq!(doc["schema"], "error/1");
    assert_eq!(doc["error"], "E_NOT_AVAILABLE");
    assert_eq!(doc["reason"], "nothing-to-repair");
    assert_eq!(snapshot(&home.join("logs")), before);
}

#[test]
fn reanchor_on_a_home_without_logs_is_nothing_to_repair_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let out = bin()
        .arg("--home")
        .arg(&home)
        .args(["--json", "audit", "reanchor", "--dry-run"])
        .assert()
        .failure()
        .code(2);
    assert_eq!(stdout_json(&out)["reason"], "nothing-to-repair");
    assert!(!home.join("logs").exists());
}

#[test]
fn reanchor_dry_run_shows_the_finding_and_changes_nothing() {
    let (_dir, home) = home_with_chain(None); // the anchor is missing
    let before = snapshot(&home.join("logs"));
    let out = bin()
        .arg("--home")
        .arg(&home)
        .args(["--json", "audit", "reanchor", "--dry-run"])
        .assert()
        .success();
    let doc = stdout_json(&out);
    assert_eq!(doc["schema"], "audit.reanchor/1");
    assert_eq!(doc["dryRun"], true);
    assert_eq!(doc["reanchored"], false);
    assert_eq!(doc["disagreement"], "anchor-missing");
    assert_eq!(doc["inspection"]["lines"], 3);
    assert_eq!(doc["inspection"]["validLines"], 3);
    assert_eq!(doc["inspection"]["anchor"]["status"], "missing");
    assert_eq!(doc["inspection"]["end"]["seq"], 3);
    assert_eq!(doc["aside"], serde_json::json!(["audit-chain.jsonl"]));
    assert_eq!(snapshot(&home.join("logs")), before);

    let human = bin()
        .arg("--home")
        .arg(&home)
        .args(["audit", "reanchor", "--dry-run"])
        .assert()
        .success();
    let text = String::from_utf8(human.get_output().stdout.clone()).unwrap();
    assert!(text.contains("dry run, nothing was changed"), "{text}");
    assert!(text.contains("anchor-missing"), "{text}");
    assert_eq!(snapshot(&home.join("logs")), before);
}

#[test]
fn reanchor_sets_the_old_chain_aside_untouched_and_starts_a_new_one_with_the_event() {
    let (_dir, home) = home_with_chain(Some("{}".to_string())); // the anchor is invalid
    let logs = home.join("logs");
    let before = snapshot(&logs);
    let out = bin()
        .arg("--home")
        .arg(&home)
        .args([
            "--json",
            "audit",
            "reanchor",
            "--reason",
            "anchor damaged by a disk failure; token=abc123def456ghi789",
        ])
        .assert()
        .success();
    let doc = stdout_json(&out);
    assert_eq!(doc["schema"], "audit.reanchor/1");
    assert_eq!(doc["reanchored"], true);
    assert_eq!(doc["disagreement"], "anchor-invalid");
    let suffix = doc["asideSuffix"].as_str().unwrap().to_string();
    assert!(suffix.starts_with("pre-reanchor-"));
    assert!(doc["warnings"].as_array().unwrap().is_empty());
    assert!(!String::from_utf8_lossy(&out.get_output().stdout).contains("abc123def456ghi789"));

    // Every old file is there, byte for byte, under its set-aside name.
    let after = snapshot(&logs);
    for (name, bytes) in &before {
        assert_eq!(
            after.get(&format!("{name}.{suffix}")),
            Some(bytes),
            "{name}"
        );
    }
    // The new chain is one line: the event, at the genesis hash, and the anchor names it.
    let chain = fs::read_to_string(logs.join("audit-chain.jsonl")).unwrap();
    assert_eq!(chain.lines().count(), 1);
    let first: Value = serde_json::from_str(chain.lines().next().unwrap()).unwrap();
    assert_eq!(first["seq"], 1);
    assert_eq!(first["prev"], "0".repeat(64));
    assert_eq!(first["rec"]["action"], "audit.chain.reanchored");
    let detail = &first["rec"]["detail"];
    assert_eq!(detail["disagreement"], "anchor-invalid");
    assert_eq!(detail["previousAnchor"]["status"], "invalid");
    assert_eq!(detail["previousEnd"]["seq"], 3);
    assert_eq!(detail["previousEnd"]["hash"], fixture_lines()[2].1);
    assert_eq!(detail["validLines"], 3);
    assert_eq!(detail["asideSuffix"], suffix.as_str());
    let reason = detail["reason"].as_str().unwrap();
    assert!(
        reason.starts_with("anchor damaged by a disk failure"),
        "{reason}"
    );
    assert!(!reason.contains("abc123def456ghi789"), "{reason}");
    let anchor: Value =
        serde_json::from_str(&fs::read_to_string(logs.join("audit-chain.anchor")).unwrap())
            .unwrap();
    assert_eq!(anchor["seq"], 1);
    // The same event is in audit.log.
    let log = fs::read_to_string(logs.join("audit.log")).unwrap();
    let logged: Value = serde_json::from_str(log.lines().last().unwrap()).unwrap();
    assert_eq!(logged["action"], "audit.chain.reanchored");
    assert_eq!(logged["detail"]["reason"], detail["reason"]);

    // Run again: writers accept the new chain, so there is nothing to repair.
    let again = bin()
        .arg("--home")
        .arg(&home)
        .args(["--json", "audit", "reanchor", "--reason", "again"])
        .assert()
        .failure()
        .code(2);
    assert_eq!(stdout_json(&again)["reason"], "nothing-to-repair");
}

#[cfg(unix)]
#[test]
fn reanchor_refuses_a_home_that_others_can_write() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, home) = home_with_chain(None);
    let logs = home.join("logs");
    fs::set_permissions(&logs, fs::Permissions::from_mode(0o777)).unwrap();
    let before = snapshot(&logs);
    let out = bin()
        .arg("--home")
        .arg(&home)
        .args(["--json", "audit", "reanchor", "--reason", "not the owner"])
        .assert()
        .failure()
        .code(1);
    let doc = stdout_json(&out);
    assert_eq!(doc["error"], "E_UNAUTHORIZED");
    assert_eq!(doc["reason"], "not-owner");
    assert_eq!(snapshot(&logs), before);
}

#[test]
fn audit_pin_is_parsed_before_any_connection_and_rejects_bad_external_values() {
    for pin in [
        "bad",
        "0:0123",
        "1:short",
        "9007199254740992:0000000000000000000000000000000000000000000000000000000000000000",
    ] {
        let out = bin()
            .args(["audit", "verify", "--pin", pin])
            .assert()
            .failure();
        let stderr = String::from_utf8_lossy(&out.get_output().stderr);
        assert!(
            stderr.contains("expected positive safe sequence and 64 lowercase hexadecimal hash"),
            "{stderr}"
        );
    }
}

#[cfg(unix)]
#[test]
fn audit_pin_reaches_the_core_and_json_retains_unknown_rpc_fields() {
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    let dir = tempfile::tempdir().unwrap();
    let run = dir.path().join("run");
    std::fs::create_dir_all(&run).unwrap();
    std::fs::write(run.join("core.token"), "offline-fixture").unwrap();
    let listener = UnixListener::bind(run.join("core.sock")).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut lines = BufReader::new(stream).lines();
        let auth: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
        writeln!(writer,"{}",json!({"jsonrpc":"2.0","id":auth["id"],"result":{"contract":"1.12.0","rpc":plur1bus_rpc::RPC_VERSION,"instanceId":"00000000-0000-4000-8000-000000000000","pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities("core",&[])}})).unwrap();
        let request: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
        writeln!(writer,"{}",json!({"jsonrpc":"2.0","id":request["id"],"result":{"ok":true,"future":{"retained":true},"records":1,"files":1,"lastSeq":1,"lastHash":"a".repeat(64),"anchor":{"status":"match","seq":1},"findings":[],"findingsTotal":0}})).unwrap();
        request
    });
    let pin = format!("1:{}", "a".repeat(64));
    let out = bin()
        .arg("--home")
        .arg(dir.path())
        .args(["--json", "audit", "verify", "--pin", &pin])
        .assert()
        .success();
    let result: Value = serde_json::from_slice(&out.get_output().stdout).unwrap();
    assert_eq!(result["future"]["retained"], true);
    let request = server.join().unwrap();
    assert_eq!(request["method"], "audit.verify");
    assert_eq!(
        request["params"],
        json!({"pin":{"seq":1,"hash":"a".repeat(64)}})
    );
}
