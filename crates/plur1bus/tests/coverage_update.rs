//! `plur1bus update`: the offline-bundle entry point and the guard/plan logic around it, for the cases
//! `update.rs`, `update_apply.rs` and `update_gaps.rs` do not pin: clap conflicts between the update modes, `update
//! status` on a fresh and on an unreadable state, `--rollback` with nothing to roll back, unreadable and foreign bundle
//! files, a CA bundle that does not exist, a corrupt guard file refusing both apply and plan, the confirmation refusal
//! off a terminal (with the bundle extraction cleaned up), plan output that writes nothing, the up-to-date plan, and
//! the locale rules of `--plan`.
//!
//! Hermetic: every feed and bundle is built here and signed with a throwaway minisign key that is passed as
//! `PLUR1BUS_TEST_RELEASE_PUBKEY`; the "binary" an update swaps is a shell script; the service manager is the recording
//! fake. Every invocation passes `--from` or `--manifest` with a local path, or fails at argument parsing, so no test
//! can reach a release server. Unix only (the stand-in binary is `/bin/sh`).
#![cfg(unix)]

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const OLD: &str = "#!/bin/sh\ncase \" $* \" in *\" --version \"*) echo 'plur1bus 0.1.0';; esac\n";

const HOST: &str = if cfg!(target_arch = "aarch64") && cfg!(target_os = "macos") {
    "darwin-arm64"
} else if cfg!(target_arch = "aarch64") {
    "linux-arm64"
} else if cfg!(target_os = "macos") {
    "darwin-arm64"
} else {
    "linux-x64"
};

fn sha(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}

struct Env {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    target: PathBuf,
}

/// An installation at 0.1.0 on the stable channel, with a config and a core payload to compare after each run.
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

fn new_script(root: &Path, version: &str) -> String {
    format!(
        "#!/bin/sh\ncase \" $* \" in\n\
 *\" --version \"*) echo 'plur1bus {version}';;\n\
 *\" daemon start \"*) echo '{{\"started\":true}}';;\n\
 *\" daemon status \"*) echo '{{\"children\":[{{\"kind\":\"core\",\"process\":{{\"state\":\"ready\"}}}}]}}';;\n\
 *\" 1staid check \"*) echo '{{\"ok\":true,\"checks\":[]}}';;\n\
esac\n# {}\n",
        root.display()
    )
}

/// A release of `version` on stable: the manifest, its minisign signature, and the one artefact it names.
struct Release {
    version: String,
    script: String,
}

impl Release {
    fn new(e: &Env, version: &str) -> Release {
        Release {
            version: version.into(),
            script: new_script(&e.root, version),
        }
    }

    fn manifest(&self) -> Vec<u8> {
        let native = json!({
            "binary": { HOST: { "url": "https://example.invalid/dl/plur1bus-new", "sha256": sha(self.script.as_bytes()) } },
            "core": { "version": "0.1.0", "contract": "1.9.0", "rpc": "1.3.0",
                      "payload": { HOST: { "url": "https://example.invalid/core.tar.gz", "sha256": "a".repeat(64) } } },
            "node": { "version": "24.21.0" },
            "modules": [],
            "configSchemaVersion": 1,
        });
        serde_json::to_vec(&json!({
            "version": self.version, "channel": "stable", "kind": "minor", "security": false,
            "minFromVersion": "0.1.0", "notes": { "en": "test release" }, "native": native,
        }))
        .unwrap()
    }

    /// The `(name, bytes)` entries of an offline bundle, signed by `key`.
    fn bundle_files(&self, key: &minisign::KeyPair) -> Vec<(String, Vec<u8>)> {
        let m = self.manifest();
        vec![
            ("manifest.json".into(), m.clone()),
            ("manifest.json.minisig".into(), sign(key, &m).into_bytes()),
            (
                "artefacts/plur1bus-new".into(),
                self.script.clone().into_bytes(),
            ),
        ]
    }
}

fn sign(key: &minisign::KeyPair, bytes: &[u8]) -> String {
    minisign::sign(Some(&key.pk), &key.sk, bytes, Some("t"), Some("TEST ONLY"))
        .unwrap()
        .into_string()
}

fn pk_of(k: &minisign::KeyPair) -> String {
    k.pk.to_base64()
}

fn keypair() -> minisign::KeyPair {
    minisign::KeyPair::generate_unencrypted_keypair().unwrap()
}

fn write_tar_zst(path: &Path, files: &[(String, Vec<u8>)]) {
    let mut b = tar::Builder::new(Vec::new());
    for (name, data) in files {
        let mut h = tar::Header::new_gnu();
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        h.set_entry_type(tar::EntryType::Regular);
        let old = h.as_old_mut();
        old.name = [0u8; 100];
        old.name[..name.len()].copy_from_slice(name.as_bytes());
        h.set_cksum();
        b.append(&h, &data[..]).unwrap();
    }
    let tar = b.into_inner().unwrap();
    fs::write(
        path,
        ruzstd::encoding::compress_to_vec(&tar[..], ruzstd::encoding::CompressionLevel::Fastest),
    )
    .unwrap();
}

/// `update --yes --from <bundle>` (or any update argv) with the release key baked in as the test key.
fn cmd(e: &Env, pubkey: Option<&str>, args: &[&str]) -> Command {
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
        .env_remove("PLUR1BUS_CA_BUNDLE")
        .env("LC_ALL", "C")
        .env_remove("LANG")
        .stdin(Stdio::null());
    if let Some(k) = pubkey {
        c.env("PLUR1BUS_TEST_RELEASE_PUBKEY", k);
    }
    c
}

fn run(c: &mut Command) -> (i32, Value) {
    let o: Output = c.output().unwrap();
    let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
    let doc = serde_json::from_str(&text).unwrap_or_else(|er| {
        panic!(
            "not JSON ({er}): {text:?} stderr: {:?}",
            String::from_utf8_lossy(&o.stderr)
        )
    });
    (o.status.code().unwrap_or(-1), doc)
}

/// Every file the update may touch: the binary, the config, the install manifest, the core payload.
fn state_of(e: &Env) -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
    (
        fs::read(&e.target).unwrap(),
        fs::read(e.home.join("config.json")).unwrap(),
        fs::read(e.home.join("manifest.json")).unwrap(),
        fs::read(e.home.join("runtime/core/core.js")).unwrap(),
    )
}

/// Nothing was applied and no update bookkeeping was left behind.
fn untouched(e: &Env, before: &(Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>)) {
    assert_eq!(&state_of(e), before, "installation changed");
    assert!(
        !e.home.join("update/bundle").exists(),
        "bundle extraction left behind"
    );
    assert!(
        !e.home.join("update/state.json").exists(),
        "an update state was written"
    );
}

/// A bundle of `rel` in `e.root/<name>` signed by `key`, returned as its path.
fn bundle_of(e: &Env, name: &str, rel: &Release, key: &minisign::KeyPair) -> PathBuf {
    let p = e.root.join(name);
    write_tar_zst(&p, &rel.bundle_files(key));
    p
}

// ---------------------------------------------------------------------------------------------------------------

#[test]
fn the_update_modes_refuse_each_others_flags_before_anything_runs() {
    let e = env();
    let key = keypair();
    let bundle = bundle_of(&e, "u.tar.zst", &Release::new(&e, "0.2.0"), &key);
    let manifest = e.root.join("missing.json");
    let b = bundle.to_str().unwrap();
    let m = manifest.to_str().unwrap();
    let before = state_of(&e);
    let cases: Vec<Vec<&str>> = vec![
        vec!["update", "--from", b, "--manifest", m],
        vec!["update", "--check", "--plan", "--manifest", m],
        vec!["update", "--plan", "--rollback"],
        vec!["update", "--from", b, "--check"],
        vec!["update", "--rollback", "--check"],
        vec!["update", "--from", b, "--rollback"],
        vec!["update", "--channel", "gamma", "--check", "--manifest", m],
        vec!["update", "--lang", "fr", "--plan", "--manifest", m],
        vec!["update", "--check", "--manifest", m, "--require-addon"],
    ];
    for args in cases {
        let o = cmd(&e, Some(&pk_of(&key)), &args).output().unwrap();
        assert_eq!(
            o.status.code(),
            Some(2),
            "{args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
    }
    assert_eq!(state_of(&e), before);
}

#[test]
fn update_status_on_a_fresh_install_reports_idle_and_nothing_to_roll_back() {
    let e = env();
    let (code, v) = run(&mut cmd(&e, None, &["update", "status"]));
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["schema"], "update.status/1");
    assert_eq!(v["phase"], "idle");
    assert_eq!(v["recoveryPending"], false);
    assert_eq!(v["canRollback"], false);

    let out = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--home")
        .arg(&e.home)
        .args(["update", "status"])
        .env("HOME", e.root.join("user"))
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env_remove("PLUR1BUS_CONTAINER")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("no update has run"));
}

#[test]
fn an_unreadable_update_state_is_reported_by_status_and_refuses_a_rollback() {
    let e = env();
    fs::create_dir_all(e.home.join("update")).unwrap();
    fs::write(e.home.join("update/state.json"), "{ not json").unwrap();
    let before = state_of(&e);
    let (code, v) = run(&mut cmd(&e, None, &["update", "status"]));
    assert_eq!(code, 1, "{v}");
    assert_eq!(v["error"], "E_NOT_AVAILABLE");
    assert_eq!(v["reason"], "state-unreadable");
    let (code, v) = run(&mut cmd(&e, None, &["update", "--rollback"]));
    assert_eq!(code, 1, "{v}");
    assert_eq!(v["reason"], "state-unreadable");
    assert_eq!(state_of(&e), before);
}

#[test]
fn a_rollback_with_no_snapshot_has_nothing_to_roll_back_and_changes_nothing() {
    let e = env();
    let before = state_of(&e);
    let (code, v) = run(&mut cmd(&e, None, &["update", "--rollback"]));
    assert_eq!(code, 1, "{v}");
    assert_eq!(v["error"], "E_NOT_AVAILABLE");
    assert_eq!(v["reason"], "nothing-to-roll-back");
    assert_eq!(state_of(&e), before);
}

#[test]
fn a_bundle_path_that_does_not_exist_is_unreadable_and_writes_nothing() {
    let e = env();
    let key = keypair();
    let before = state_of(&e);
    let missing = e.root.join("no-such-bundle.tar.zst");
    let (code, v) = run(&mut cmd(
        &e,
        Some(&pk_of(&key)),
        &["update", "--plan", "--from", missing.to_str().unwrap()],
    ));
    assert_eq!(code, 1, "{v}");
    assert_eq!(v["error"], "E_NOT_AVAILABLE");
    assert_eq!(v["reason"], "bundle-unreadable");
    untouched(&e, &before);
}

#[test]
fn a_file_that_is_neither_zstd_nor_zip_is_not_an_archive() {
    let e = env();
    let key = keypair();
    let before = state_of(&e);
    let text = e.root.join("notes.txt");
    fs::write(&text, "this is not an update bundle at all\n").unwrap();
    let (code, v) = run(&mut cmd(
        &e,
        Some(&pk_of(&key)),
        &["update", "--yes", "--from", text.to_str().unwrap()],
    ));
    assert_eq!(code, 1, "{v}");
    assert_eq!(v["reason"], "archive-unsupported");
    untouched(&e, &before);
}

#[test]
fn a_bundle_without_its_signature_is_refused_and_nothing_changes() {
    let e = env();
    let key = keypair();
    let rel = Release::new(&e, "0.2.0");
    let mut files = rel.bundle_files(&key);
    files.retain(|(name, _)| name != "manifest.json.minisig");
    let bundle = e.root.join("unsigned.tar.zst");
    write_tar_zst(&bundle, &files);
    let before = state_of(&e);
    let (code, v) = run(&mut cmd(
        &e,
        Some(&pk_of(&key)),
        &["update", "--yes", "--from", bundle.to_str().unwrap()],
    ));
    assert_eq!(code, 1, "{v}");
    assert_eq!(v["error"], "E_NOT_AVAILABLE");
    assert_eq!(v["reason"], "bundle-invalid", "{v}");
    untouched(&e, &before);
}

#[test]
fn a_ca_bundle_that_does_not_exist_is_refused_as_invalid_input() {
    let e = env();
    let key = keypair();
    let bundle = bundle_of(&e, "ca.tar.zst", &Release::new(&e, "0.2.0"), &key);
    let before = state_of(&e);
    let missing_pem = e.root.join("corp-ca.pem");
    let (code, v) = run(&mut cmd(
        &e,
        Some(&pk_of(&key)),
        &[
            "update",
            "--plan",
            "--from",
            bundle.to_str().unwrap(),
            "--ca-bundle",
            missing_pem.to_str().unwrap(),
        ],
    ));
    assert_eq!(code, 2, "{v}");
    assert_eq!(v["error"], "E_INVALID_PARAMS");
    assert_eq!(v["reason"], "ca-bundle-invalid");
    untouched(&e, &before);
}

#[test]
fn a_corrupt_guard_file_refuses_the_plan_and_the_apply_alike() {
    let e = env();
    let key = keypair();
    let bundle = bundle_of(&e, "g.tar.zst", &Release::new(&e, "0.2.0"), &key);
    fs::create_dir_all(e.home.join("update")).unwrap();
    fs::write(e.home.join("update/guard.json"), "][ not a guard").unwrap();
    let before = state_of(&e);
    let b = bundle.to_str().unwrap();
    for args in [
        vec!["update", "--plan", "--from", b],
        vec!["update", "--yes", "--from", b],
    ] {
        let (code, v) = run(&mut cmd(&e, Some(&pk_of(&key)), &args));
        assert_eq!(code, 1, "{args:?}: {v}");
        assert_eq!(v["reason"], "guard-unreadable", "{args:?}");
    }
    untouched(&e, &before);
}

#[test]
fn a_bundle_applied_without_yes_off_a_terminal_is_refused_and_its_extraction_is_removed() {
    let e = env();
    let key = keypair();
    let bundle = bundle_of(&e, "c.tar.zst", &Release::new(&e, "0.2.0"), &key);
    let before = state_of(&e);
    let (code, v) = run(&mut cmd(
        &e,
        Some(&pk_of(&key)),
        &["update", "--from", bundle.to_str().unwrap()],
    ));
    assert_eq!(code, 2, "{v}");
    assert_eq!(v["error"], "E_INVALID_PARAMS");
    assert_eq!(v["reason"], "confirmation-required");
    assert!(v["message"].as_str().unwrap().contains("0.2.0"), "{v}");
    untouched(&e, &before);
}

#[test]
fn the_plan_of_a_bundle_names_it_as_the_source_and_leaves_no_trace() {
    let e = env();
    let key = keypair();
    let bundle = bundle_of(&e, "p.tar.zst", &Release::new(&e, "0.2.0"), &key);
    let before = state_of(&e);
    let (code, p) = run(&mut cmd(
        &e,
        Some(&pk_of(&key)),
        &["update", "--plan", "--from", bundle.to_str().unwrap()],
    ));
    assert_eq!(code, 0, "{p}");
    assert_eq!(p["schema"], "update.plan/1");
    assert_eq!(p["source"], "bundle");
    assert_eq!(
        (p["from"].as_str(), p["to"].as_str()),
        (Some("0.1.0"), Some("0.2.0"))
    );
    assert_eq!(p["lang"], "en");
    untouched(&e, &before);
    assert!(
        !e.home.join("update/guard.json").exists(),
        "a plan records no guard"
    );
    let again = run(&mut cmd(
        &e,
        Some(&pk_of(&key)),
        &["update", "--plan", "--from", bundle.to_str().unwrap()],
    ))
    .1;
    assert_eq!(p, again, "the same bundle gives the same plan");
}

#[test]
fn a_bundle_of_the_installed_version_plans_up_to_date_and_applies_nothing() {
    let e = env();
    let key = keypair();
    let bundle = bundle_of(&e, "same.tar.zst", &Release::new(&e, "0.1.0"), &key);
    let before = state_of(&e);
    let b = bundle.to_str().unwrap();
    let (code, p) = run(&mut cmd(
        &e,
        Some(&pk_of(&key)),
        &["update", "--plan", "--from", b],
    ));
    assert_eq!(code, 0, "{p}");
    assert_eq!(p["schema"], "update.plan/1");
    assert_eq!(p["outcome"], "up-to-date");
    let (code, a) = run(&mut cmd(
        &e,
        Some(&pk_of(&key)),
        &["update", "--yes", "--from", b],
    ));
    assert_eq!(code, 0, "{a}");
    assert_eq!(a["outcome"], "up-to-date");
    untouched(&e, &before);
}

#[test]
fn the_plan_language_follows_the_locale_unless_lang_says_otherwise() {
    let e = env();
    let key = keypair();
    let bundle = bundle_of(&e, "loc.tar.zst", &Release::new(&e, "0.2.0"), &key);
    let b = bundle.to_str().unwrap();
    let lang_under = |envs: &[(&str, &str)], extra: &[&str]| -> String {
        let mut c = cmd(
            &e,
            Some(&pk_of(&key)),
            &[&["update", "--plan", "--from", b], extra].concat(),
        );
        c.env_remove("LC_ALL");
        for (k, v) in envs {
            c.env(k, v);
        }
        let (code, p) = run(&mut c);
        assert_eq!(code, 0, "{p}");
        p["lang"].as_str().unwrap().to_string()
    };
    assert_eq!(lang_under(&[("LC_ALL", "de_DE.UTF-8")], &[]), "de");
    assert_eq!(lang_under(&[("LC_ALL", "C")], &[]), "en");
    assert_eq!(lang_under(&[("LC_MESSAGES", "de_AT.UTF-8")], &[]), "de");
    assert_eq!(lang_under(&[("LANG", "de_DE.UTF-8")], &[]), "de");
    assert_eq!(lang_under(&[("LANG", "fr_FR.UTF-8")], &[]), "en");
    assert_eq!(
        lang_under(&[("LC_ALL", "de_DE.UTF-8")], &["--lang", "en"]),
        "en"
    );
    assert_eq!(lang_under(&[("LC_ALL", "C")], &["--lang", "de"]), "de");
}
