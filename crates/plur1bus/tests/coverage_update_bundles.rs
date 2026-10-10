//! `plur1bus update --from <bundle>` with a bundle whose signature is valid but whose archive is cut short: the manifest is
//! signed, the `.tar.zst` stops in the middle. Both the plan and the apply must refuse, and the installation must be
//! byte-identical afterwards. The helpers mirror `coverage_update.rs`; minisign signs a throwaway key that is passed as
//! `PLUR1BUS_TEST_RELEASE_PUBKEY`. Hermetic: no feed, no network. Unix only (the stand-in binary is `/bin/sh`).
#![cfg(unix)]

use serde_json::{json, Value};
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

struct Env {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    target: PathBuf,
}

fn sha(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}

/// An installation at 0.1.0 with a config, a core payload and an install manifest to compare after each run.
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

/// A signed bundle of version 0.2.0: the manifest, its minisign signature, and the one artefact it names.
fn bundle_files(e: &Env, key: &minisign::KeyPair) -> Vec<(String, Vec<u8>)> {
    let script = new_script(&e.root, "0.2.0");
    let native = json!({
        "binary": { HOST: { "url": "https://example.invalid/dl/plur1bus-new", "sha256": sha(script.as_bytes()) } },
        "core": { "version": "0.1.0", "contract": "1.9.0", "rpc": "1.3.0",
                  "payload": { HOST: { "url": "https://example.invalid/core.tar.gz", "sha256": "a".repeat(64) } } },
        "node": { "version": "24.21.0" },
        "modules": [],
        "configSchemaVersion": 1,
    });
    let m = serde_json::to_vec(&json!({
        "version": "0.2.0", "channel": "stable", "kind": "minor", "security": false,
        "minFromVersion": "0.1.0", "notes": { "en": "test release" }, "native": native,
    }))
    .unwrap();
    let sig = minisign::sign(Some(&key.pk), &key.sk, &m[..], Some("t"), Some("TEST ONLY"))
        .unwrap()
        .into_string();
    vec![
        ("manifest.json".into(), m),
        ("manifest.json.minisig".into(), sig.into_bytes()),
        ("artefacts/plur1bus-new".into(), script.into_bytes()),
    ]
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

fn cmd(e: &Env, pubkey: &str, args: &[&str]) -> Command {
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
        .env("PLUR1BUS_TEST_RELEASE_PUBKEY", pubkey)
        .env_remove("PLUR1BUS_CONTAINER")
        .env_remove("PLUR1BUS_TEST_UPDATE_KILL_AT")
        .env_remove("PLUR1BUS_CA_BUNDLE")
        .env("LC_ALL", "C")
        .env_remove("LANG")
        .stdin(Stdio::null());
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

/// Every file an update may touch: the binary, the config, the install manifest and the core payload.
fn state_of(e: &Env) -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
    (
        fs::read(&e.target).unwrap(),
        fs::read(e.home.join("config.json")).unwrap(),
        fs::read(e.home.join("manifest.json")).unwrap(),
        fs::read(e.home.join("runtime/core/core.js")).unwrap(),
    )
}

#[test]
fn a_signed_bundle_cut_short_is_refused_by_plan_and_apply_and_changes_nothing() {
    let e = env();
    let key = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
    let pk = key.pk.to_base64();
    let full = e.root.join("full.tar.zst");
    write_tar_zst(&full, &bundle_files(&e, &key));
    let bytes = fs::read(&full).unwrap();
    let cut = e.root.join("cut.tar.zst");
    fs::write(&cut, &bytes[..bytes.len() / 2]).unwrap();
    let before = state_of(&e);

    let (code, v) = run(&mut cmd(
        &e,
        &pk,
        &["update", "--plan", "--from", cut.to_str().unwrap()],
    ));
    assert_ne!(code, 0, "{v}");
    assert_eq!(v["schema"], "error/1", "{v}");
    assert!(v["reason"].is_string(), "a refusal names its reason: {v}");

    let (code, v) = run(&mut cmd(
        &e,
        &pk,
        &["update", "--yes", "--from", cut.to_str().unwrap()],
    ));
    assert_ne!(code, 0, "{v}");
    assert_eq!(v["schema"], "error/1", "{v}");
    assert_eq!(state_of(&e), before, "installation changed");
    assert!(
        !e.home.join("update/bundle").exists(),
        "bundle extraction left behind"
    );
    assert!(
        !e.home.join("update/state.json").exists(),
        "an update state was written"
    );
}
