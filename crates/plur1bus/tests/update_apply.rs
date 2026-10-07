//! `plur1bus update` (apply), `update --rollback`, `update status` and the `daemon start` recovery hook (M8, D78).
//! Hermetic: the "binary" the update swaps is a shell script (`PLUR1BUS_UPDATE_TARGET_BIN`, test internals), the feed
//! is a local file signed with a throwaway minisign key, the service manager is the recording fake
//! (`PLUR1BUS_SERVICE_FAKE`), `HOME` is a temp dir. Unix only (the stand-in binary is `/bin/sh`).
#![cfg(unix)]
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const OLD: &str = "#!/bin/sh\ncase \" $* \" in *\" --version \"*) echo 'plur1bus 0.1.0';; esac\n";

fn sha(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}

struct Env {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    /// The binary the update swaps (a script).
    target: PathBuf,
}

const HOST: &str = if cfg!(target_arch = "aarch64") && cfg!(target_os = "macos") {
    "darwin-arm64"
} else if cfg!(target_arch = "aarch64") {
    "linux-arm64"
} else if cfg!(target_os = "macos") {
    "darwin-arm64"
} else {
    "linux-x64"
};

fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let home = root.join("h");
    fs::create_dir_all(home.join("runtime/core")).unwrap();
    fs::create_dir_all(root.join("fake")).unwrap();
    fs::create_dir_all(root.join("user")).unwrap();
    fs::write(home.join("runtime/core/core.js"), "old core").unwrap();
    fs::write(home.join("config.json"), "{\"engine\":{}}\n").unwrap();
    let target = root.join("plur1bus-installed");
    fs::write(&target, OLD).unwrap();
    let h = "a".repeat(64);
    let manifest = json!({
        "schemaVersion": 1, "installedAt": 1, "updatedAt": 1, "channel": "stable", "target": HOST,
        "binary": { "version": "0.1.0", "sha256": sha(OLD.as_bytes()) },
        "node": { "version": "24.21.0", "archiveSha256": h, "binarySha256": h, "path": "/n" },
        "core": { "version": "0.1.0", "contract": "1.9.0", "rpc": "1.3.0", "sha256": null, "source": "local" },
        "modules": [], "skills": [],
    });
    fs::write(
        home.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    Env {
        _tmp: tmp,
        root,
        home,
        target,
    }
}

/// The new binary: reports 0.2.0, a ready core, and a `1staid check` that fails while `<root>/gate-fail` exists.
fn new_script(root: &Path) -> String {
    format!(
        "#!/bin/sh\ncase \" $* \" in\n\
 *\" --version \"*) echo 'plur1bus 0.2.0';;\n\
 *\" daemon start \"*) echo '{{\"started\":true}}';;\n\
 *\" daemon status \"*) echo '{{\"children\":[{{\"kind\":\"core\",\"process\":{{\"state\":\"ready\"}}}}]}}';;\n\
 *\" 1staid check \"*) if [ -f '{0}/gate-fail' ]; then echo '{{\"ok\":false,\"checks\":[{{\"id\":\"runtime.core\",\"status\":\"fail\"}}]}}'; exit 1; fi; echo '{{\"ok\":true,\"checks\":[]}}';;\n\
esac\n",
        root.display()
    )
}

struct Feed {
    path: PathBuf,
    pubkey: String,
    binary: PathBuf,
}

/// Writes the new binary, a core payload and a signed `stable.json` (0.2.0) into `<root>/feed`.
fn feed(e: &Env, with_core: bool) -> Feed {
    let dir = e.root.join("feed");
    fs::create_dir_all(&dir).unwrap();
    let script = new_script(&e.root);
    let binary = dir.join("plur1bus-new");
    fs::write(&binary, &script).unwrap();
    let mut native = json!({
        "binary": { HOST: { "url": binary.to_string_lossy(), "sha256": sha(script.as_bytes()) } },
        "core": { "version": "0.1.0", "contract": "1.9.0", "rpc": "1.3.0",
                  "payload": { HOST: { "url": "https://example.invalid/core.tar.gz", "sha256": "a".repeat(64) } } },
        "node": { "version": "24.21.0" },
        "modules": [],
        "configSchemaVersion": 1,
    });
    if with_core {
        let src = dir.join("core-src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("core.js"), "new core").unwrap();
        let tar = dir.join("core.tar.gz");
        let mut b = tar::Builder::new(flate2::write::GzEncoder::new(
            fs::File::create(&tar).unwrap(),
            flate2::Compression::fast(),
        ));
        b.append_dir_all(".", &src).unwrap();
        b.into_inner().unwrap().finish().unwrap();
        native["core"] = json!({ "version": "0.2.0", "contract": "1.10.0", "rpc": "1.3.0",
            "payload": { HOST: { "url": tar.to_string_lossy(), "sha256": sha(&fs::read(&tar).unwrap()) } } });
    }
    let doc = json!({
        "version": "0.2.0", "channel": "stable", "kind": "minor", "security": false,
        "minFromVersion": "0.1.0", "notes": { "en": "test release" }, "native": native,
    });
    let bytes = serde_json::to_vec(&doc).unwrap();
    let path = dir.join("stable.json");
    fs::write(&path, &bytes).unwrap();
    let kp = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
    let sig = minisign::sign(
        Some(&kp.pk),
        &kp.sk,
        &bytes[..],
        Some("update test"),
        Some("TEST ONLY"),
    )
    .unwrap();
    fs::write(dir.join("stable.json.minisig"), sig.into_string()).unwrap();
    Feed {
        path,
        pubkey: kp.pk.to_base64(),
        binary,
    }
}

fn cmd(e: &Env, f: Option<&Feed>, args: &[&str]) -> Command {
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.arg("--json")
        .arg("--home")
        .arg(&e.home)
        .args(args)
        .env("HOME", e.root.join("user"))
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SERVICE_FAKE", e.root.join("fake"))
        .env("PLUR1BUS_UPDATE_TARGET_BIN", &e.target)
        .env("PLUR1BUS_UPDATE_GATE_TIMEOUT_MS", "1500")
        .env_remove("PLUR1BUS_CONTAINER")
        .env_remove("PLUR1BUS_TEST_UPDATE_KILL_AT")
        .env_remove("PLUR1BUS_TEST_RELEASE_PUBKEY")
        .stdin(Stdio::null());
    if let Some(f) = f {
        c.env("PLUR1BUS_TEST_RELEASE_PUBKEY", &f.pubkey)
            .args(["--manifest", f.path.to_str().unwrap()]);
    }
    c
}

fn run(c: &mut Command) -> (i32, Value) {
    let o: Output = c.output().unwrap();
    let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
    let doc = serde_json::from_str(&text).unwrap_or_else(|e| {
        panic!(
            "not JSON ({e}): {text:?} {:?}",
            String::from_utf8_lossy(&o.stderr)
        )
    });
    (o.status.code().unwrap_or(-1), doc)
}

fn update(e: &Env, f: &Feed, extra: &[&str]) -> Command {
    let mut args = vec!["update", "--yes"];
    args.extend_from_slice(extra);
    cmd(e, Some(f), &args)
}

fn snapshot_of(e: &Env) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    (
        fs::read(&e.target).unwrap(),
        fs::read(e.home.join("config.json")).unwrap(),
        fs::read(e.home.join("manifest.json")).unwrap(),
    )
}

fn manifest_binary_version(e: &Env) -> String {
    let m: Value =
        serde_json::from_slice(&fs::read(e.home.join("manifest.json")).unwrap()).unwrap();
    m["binary"]["version"].as_str().unwrap().to_string()
}

fn no_service_manager_was_used(e: &Env) {
    let calls = e.root.join("fake/calls.jsonl");
    let text = fs::read_to_string(calls).unwrap_or_default();
    assert!(
        !text.contains("\"start\"") && !text.contains("enable"),
        "the update touched the service manager: {text}"
    );
}

#[test]
fn happy_path_applies_then_status_and_manual_rollback_work() {
    let e = env();
    let f = feed(&e, true);
    let before = snapshot_of(&e);
    let (code, doc) = run(&mut update(&e, &f, &[]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(
        (doc["schema"].as_str(), doc["outcome"].as_str()),
        (Some("update.apply/1"), Some("committed"))
    );
    assert_eq!(fs::read(&e.target).unwrap(), fs::read(&f.binary).unwrap());
    assert_eq!(manifest_binary_version(&e), "0.2.0");
    assert_eq!(
        fs::read(e.home.join("runtime/core/core.js")).unwrap(),
        b"new core"
    );

    let (code, st) = run(&mut cmd(&e, None, &["update", "status"]));
    assert_eq!(code, 0, "{st}");
    assert_eq!(
        (
            st["schema"].as_str(),
            st["phase"].as_str(),
            st["canRollback"].as_bool()
        ),
        (Some("update.status/1"), Some("committed"), Some(true))
    );

    let (code, doc) = run(&mut cmd(&e, None, &["update", "--rollback"]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(doc["schema"], "update.rollback/1");
    assert_eq!(snapshot_of(&e), before);
    assert_eq!(
        fs::read(e.home.join("runtime/core/core.js")).unwrap(),
        b"old core"
    );
    let (_, st) = run(&mut cmd(&e, None, &["update", "status"]));
    assert_eq!(
        (st["phase"].as_str(), st["canRollback"].as_bool()),
        (Some("rolled-back"), Some(false))
    );
    no_service_manager_was_used(&e);
}

#[test]
fn a_failing_health_gate_rolls_back_byte_identically_and_says_why() {
    let e = env();
    let f = feed(&e, true);
    fs::write(e.root.join("gate-fail"), "").unwrap();
    let before = snapshot_of(&e);
    let (code, doc) = run(&mut update(&e, &f, &[]));
    assert_eq!(code, 1, "{doc}");
    assert_eq!(doc["outcome"], "rolled-back");
    assert_eq!(doc["reason"], "health-gate-failed");
    assert!(
        doc["message"].as_str().unwrap().contains("runtime.core"),
        "{doc}"
    );
    assert_eq!(snapshot_of(&e), before);
    assert_eq!(
        fs::read(e.home.join("runtime/core/core.js")).unwrap(),
        b"old core"
    );
    no_service_manager_was_used(&e);
}

#[test]
fn a_tampered_feed_or_checksum_is_refused_and_nothing_changes() {
    let e = env();
    let f = feed(&e, false);
    let before = snapshot_of(&e);

    // 1. the feed bytes changed after signing
    let mut bytes = fs::read(&f.path).unwrap();
    let at = bytes.windows(4).position(|w| w == b"test").unwrap();
    bytes[at] = b'T';
    fs::write(&f.path, &bytes).unwrap();
    let (code, doc) = run(&mut update(&e, &f, &[]));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("release-signature-invalid")),
        "{doc}"
    );
    assert_eq!(snapshot_of(&e), before);

    // 2. a correctly signed feed whose binary does not match its checksum
    let e2 = env();
    let f2 = feed(&e2, false);
    fs::write(&f2.binary, "#!/bin/sh\necho tampered\n").unwrap();
    let (code, doc) = run(&mut update(&e2, &f2, &[]));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("digest-mismatch")),
        "{doc}"
    );
    assert_eq!(snapshot_of(&e2).0, OLD.as_bytes());
    assert!(!e2.home.join("update/staging").exists());
    let (_, st) = run(&mut cmd(&e2, None, &["update", "status"]));
    assert_eq!(
        st["phase"], "idle",
        "a refused download leaves no state behind"
    );

    // 3. an unsigned-key build refuses to apply at all
    let e3 = env();
    let f3 = feed(&e3, false);
    let mut c = update(&e3, &f3, &[]);
    c.env_remove("PLUR1BUS_TEST_RELEASE_PUBKEY")
        .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS");
    let (code, doc) = run(&mut c);
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("release-unverified")),
        "{doc}"
    );
    assert_eq!(snapshot_of(&e3).0, OLD.as_bytes());
}

#[test]
fn without_a_yes_and_without_a_terminal_nothing_happens() {
    let e = env();
    let f = feed(&e, false);
    let before = snapshot_of(&e);
    let (code, doc) = run(&mut cmd(&e, Some(&f), &["update"]));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (2, Some("confirmation-required")),
        "{doc}"
    );
    assert_eq!(snapshot_of(&e), before);
}

#[test]
fn a_release_that_changes_the_node_runtime_is_refused() {
    let e = env();
    let f = feed(&e, false);
    let mut doc: Value = serde_json::from_slice(&fs::read(&f.path).unwrap()).unwrap();
    doc["native"]["node"]["version"] = json!("24.22.0");
    let bytes = serde_json::to_vec(&doc).unwrap();
    fs::write(&f.path, &bytes).unwrap();
    let kp = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
    let sig = minisign::sign(Some(&kp.pk), &kp.sk, &bytes[..], None, None).unwrap();
    fs::write(f.path.with_extension("json.minisig"), sig.into_string()).unwrap();
    let f = Feed {
        pubkey: kp.pk.to_base64(),
        ..f
    };
    let (code, out) = run(&mut update(&e, &f, &[]));
    assert_eq!(
        (code, out["reason"].as_str()),
        (1, Some("unit-unsupported")),
        "{out}"
    );
    assert_eq!(out["units"], json!(["node"]));
}

#[test]
fn a_crash_after_the_swap_is_rolled_back_by_the_next_daemon_start() {
    let e = env();
    let f = feed(&e, true);
    let before = snapshot_of(&e);
    let (code, _) = {
        let o = update(&e, &f, &[])
            .env("PLUR1BUS_TEST_UPDATE_KILL_AT", "swapped")
            .output()
            .unwrap();
        (o.status.code().unwrap(), ())
    };
    assert_eq!(code, 137);
    assert_ne!(
        snapshot_of(&e),
        before,
        "the crash left the new binary in place"
    );
    let (_, st) = run(&mut cmd(&e, None, &["update", "status"]));
    assert_eq!(
        (st["phase"].as_str(), st["recoveryPending"].as_bool()),
        (Some("swapped"), Some(true))
    );

    // `daemon start` settles it first, then starts the (fake-core) daemon of the restored install.
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-core.mjs");
    let o = cmd(&e, None, &["daemon", "start"])
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", "0.02")
        .env("PLUR1BUS_CORE_JS", &fixture)
        .env("PLUR1BUS_NODE", "node")
        .env("FAKE_CORE_MODE", "ok")
        .output()
        .unwrap();
    let stop = cmd(&e, None, &["daemon", "stop"])
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", "0.02")
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "{} {}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
    let _ = stop;
    assert_eq!(snapshot_of(&e), before);
    assert_eq!(
        fs::read(e.home.join("runtime/core/core.js")).unwrap(),
        b"old core"
    );
    let (_, st) = run(&mut cmd(&e, None, &["update", "status"]));
    assert_eq!(
        (st["phase"].as_str(), st["recoveryPending"].as_bool()),
        (Some("rolled-back"), Some(false))
    );
}

#[test]
fn a_crash_after_the_gate_is_rolled_forward_by_the_next_update() {
    let e = env();
    let f = feed(&e, false);
    let o = update(&e, &f, &[])
        .env("PLUR1BUS_TEST_UPDATE_KILL_AT", "gated")
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(137));
    assert_eq!(
        manifest_binary_version(&e),
        "0.1.0",
        "the manifest is written only after the gate"
    );
    let (code, doc) = run(&mut update(&e, &f, &[]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(doc["outcome"], "up-to-date");
    assert_eq!(manifest_binary_version(&e), "0.2.0");
    let (_, st) = run(&mut cmd(&e, None, &["update", "status"]));
    assert_eq!(st["phase"], "committed");
}
