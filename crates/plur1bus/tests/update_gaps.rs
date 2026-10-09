//! `plur1bus update`: offline bundles, key rotation, downgrade and replay protection, add-on compatibility and the
//! human-readable plan. Hermetic like `update_apply.rs`: the "binary" the update swaps is a shell script, every feed
//! and bundle is built here and signed with throwaway minisign keys, the service manager is the recording fake, and no
//! test touches the network. Unix only (the stand-in binary is `/bin/sh`).
#![cfg(unix)]
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const OLD: &str = "#!/bin/sh\ncase \" $* \" in *\" --version \"*) echo 'plur1bus 0.1.0';; esac\n";

fn sha(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
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

struct Env {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    target: PathBuf,
}

fn env_with(installed: &str, profile: Option<&str>) -> Env {
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
    let mut manifest = json!({
        "schemaVersion": 1, "installedAt": 1, "updatedAt": 1, "channel": "stable", "target": HOST,
        "binary": { "version": installed, "sha256": sha(OLD.as_bytes()) },
        "node": { "version": "24.21.0", "archiveSha256": h, "binarySha256": h, "path": "/n" },
        "core": { "version": "0.1.0", "contract": "1.9.0", "rpc": "1.3.0", "sha256": null, "source": "local" },
        "modules": [], "skills": [],
    });
    if let Some(p) = profile {
        manifest["profile"] = json!(p);
    }
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

fn env() -> Env {
    env_with("0.1.0", None)
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

struct Key {
    kp: minisign::KeyPair,
}

impl Key {
    fn new() -> Key {
        Key {
            kp: minisign::KeyPair::generate_unencrypted_keypair().unwrap(),
        }
    }
    fn pk(&self) -> String {
        self.kp.pk.to_base64()
    }
    fn sign(&self, bytes: &[u8]) -> String {
        minisign::sign(
            Some(&self.kp.pk),
            &self.kp.sk,
            bytes,
            Some("t"),
            Some("TEST ONLY"),
        )
        .unwrap()
        .into_string()
    }
}

/// A release under construction.
struct Release {
    version: String,
    script: String,
    core: Option<Vec<u8>>,
    extra: Value,
    native_extra: Value,
    declared_size: Option<u64>,
}

impl Release {
    fn new(e: &Env, version: &str) -> Release {
        Release {
            version: version.into(),
            script: new_script(&e.root, version),
            core: None,
            extra: json!({}),
            native_extra: json!({}),
            declared_size: None,
        }
    }
    fn with_core(mut self) -> Release {
        let mut b = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        let mut h = tar::Header::new_gnu();
        h.set_size(8);
        h.set_mode(0o644);
        h.set_cksum();
        b.append_data(&mut h, "core.js", &b"new core"[..]).unwrap();
        self.core = Some(b.into_inner().unwrap().finish().unwrap());
        self
    }

    /// The manifest, with asset URLs naming `base/<file>`.
    fn manifest(&self, base: &str) -> Vec<u8> {
        let mut native = json!({
            "binary": { HOST: { "url": format!("{base}/plur1bus-new"), "sha256": sha(self.script.as_bytes()) } },
            "core": { "version": "0.1.0", "contract": "1.9.0", "rpc": "1.3.0",
                      "payload": { HOST: { "url": "https://example.invalid/core.tar.gz", "sha256": "a".repeat(64) } } },
            "node": { "version": "24.21.0" },
            "modules": [],
            "configSchemaVersion": 1,
        });
        if let Some(core) = &self.core {
            native["core"] = json!({ "version": "0.2.0", "contract": "1.10.0", "rpc": "1.3.0",
                "payload": { HOST: { "url": format!("{base}/core.tar.gz"), "sha256": sha(core) } } });
        }
        if let Some(s) = self.declared_size {
            native["binary"][HOST]["size"] = json!(s);
        }
        for (k, v) in self.native_extra.as_object().unwrap() {
            native[k] = v.clone();
        }
        let mut doc = json!({
            "version": self.version, "channel": "stable", "kind": "minor", "security": false,
            "minFromVersion": "0.1.0", "notes": { "en": "test release" }, "native": native,
        });
        for (k, v) in self.extra.as_object().unwrap() {
            doc[k] = v.clone();
        }
        serde_json::to_vec(&doc).unwrap()
    }

    /// `<root>/<dir>/{stable.json, .minisig, plur1bus-new, core.tar.gz}` signed by `key`.
    fn feed(&self, e: &Env, dir: &str, key: &Key) -> Feed {
        let d = e.root.join(dir);
        fs::create_dir_all(&d).unwrap();
        let bin = d.join("plur1bus-new");
        fs::write(&bin, &self.script).unwrap();
        if let Some(c) = &self.core {
            fs::write(d.join("core.tar.gz"), c).unwrap();
        }
        let m = self.manifest(&d.to_string_lossy());
        let path = d.join("stable.json");
        fs::write(&path, &m).unwrap();
        fs::write(d.join("stable.json.minisig"), key.sign(&m)).unwrap();
        Feed {
            path,
            dir: d,
            pubkey: key.pk(),
        }
    }

    /// The `(name, bytes)` files of an offline bundle for this release, signed by `key`.
    fn bundle_files(&self, key: &Key) -> Vec<(String, Vec<u8>)> {
        let m = self.manifest("https://example.invalid/dl");
        let mut files = vec![
            ("manifest.json".to_string(), m.clone()),
            (
                "manifest.json.minisig".to_string(),
                key.sign(&m).into_bytes(),
            ),
            (
                "artefacts/plur1bus-new".to_string(),
                self.script.clone().into_bytes(),
            ),
        ];
        if let Some(c) = &self.core {
            files.push(("artefacts/core.tar.gz".to_string(), c.clone()));
        }
        files
    }
}

struct Feed {
    path: PathBuf,
    dir: PathBuf,
    pubkey: String,
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

fn write_zip(path: &Path, files: &[(String, Vec<u8>)]) {
    let mut w = zip::ZipWriter::new(fs::File::create(path).unwrap());
    for (name, data) in files {
        w.start_file(name.as_str(), zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap();
}

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
            "not JSON ({er}): {text:?} {:?}",
            String::from_utf8_lossy(&o.stderr)
        )
    });
    (o.status.code().unwrap_or(-1), doc)
}

fn text_run(c: &mut Command) -> (i32, String) {
    let o: Output = c.output().unwrap();
    (
        o.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&o.stdout).to_string(),
    )
}

/// `update --yes --manifest <feed>` under the feed's key.
fn online(e: &Env, f: &Feed, extra: &[&str]) -> Command {
    let mut args = vec!["update", "--yes", "--manifest", f.path.to_str().unwrap()];
    args.extend_from_slice(extra);
    cmd(e, Some(&f.pubkey), &args)
}

fn state_of(e: &Env) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    (
        fs::read(&e.target).unwrap(),
        fs::read(e.home.join("config.json")).unwrap(),
        fs::read(e.home.join("manifest.json")).unwrap(),
    )
}

fn installed_version(e: &Env) -> String {
    let m: Value =
        serde_json::from_slice(&fs::read(e.home.join("manifest.json")).unwrap()).unwrap();
    m["binary"]["version"].as_str().unwrap().to_string()
}

fn guard(e: &Env) -> Value {
    serde_json::from_slice(&fs::read(e.home.join("update/guard.json")).unwrap()).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Offline bundles

#[test]
fn an_offline_bundle_updates_through_the_same_path_in_both_formats() {
    for fmt in ["tar.zst", "zip"] {
        let e = env();
        let key = Key::new();
        let rel = Release::new(&e, "0.2.0").with_core();
        let bundle = e.root.join(format!("update.{fmt}"));
        let files = rel.bundle_files(&key);
        if fmt == "zip" {
            write_zip(&bundle, &files);
        } else {
            write_tar_zst(&bundle, &files);
        }
        let b = bundle.to_str().unwrap();
        let (code, doc) = run(&mut cmd(
            &e,
            Some(&key.pk()),
            &["update", "--yes", "--from", b],
        ));
        assert_eq!(code, 0, "{fmt}: {doc}");
        assert_eq!(doc["outcome"], "committed", "{fmt}: {doc}");
        assert_eq!(doc["plan"]["source"], "bundle");
        assert_eq!(fs::read(&e.target).unwrap(), rel.script.as_bytes());
        assert_eq!(installed_version(&e), "0.2.0");
        assert_eq!(
            fs::read(e.home.join("runtime/core/core.js")).unwrap(),
            b"new core"
        );
        assert!(
            !e.home.join("update/bundle").exists(),
            "the extraction is removed"
        );
        assert!(!e.home.join("update/staging").exists());
        // The snapshot path is the online one: a manual rollback works.
        let (code, doc) = run(&mut cmd(&e, None, &["update", "--rollback"]));
        assert_eq!(code, 0, "{doc}");
        assert_eq!(fs::read(&e.target).unwrap(), OLD.as_bytes());
        assert_eq!(
            fs::read(e.home.join("runtime/core/core.js")).unwrap(),
            b"old core"
        );
    }
}

#[test]
fn a_bundle_with_a_bad_signature_or_a_tampered_artefact_changes_nothing() {
    let e = env();
    let (key, stranger) = (Key::new(), Key::new());
    let rel = Release::new(&e, "0.2.0");
    let before = state_of(&e);
    let b = e.root.join("bad-sig.zip");
    write_zip(&b, &rel.bundle_files(&stranger));
    let (code, doc) = run(&mut cmd(
        &e,
        Some(&key.pk()),
        &["update", "--yes", "--from", b.to_str().unwrap()],
    ));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("release-signature-invalid")),
        "{doc}"
    );
    assert_eq!(state_of(&e), before);
    assert!(!e.home.join("update/bundle").exists());
    assert!(!e.home.join("update/state.json").exists());

    // The artefact differs from what the signed manifest pins.
    let mut files = rel.bundle_files(&key);
    files[2].1 = b"#!/bin/sh\necho evil\n".to_vec();
    let b = e.root.join("tampered.tar.zst");
    write_tar_zst(&b, &files);
    let (code, doc) = run(&mut cmd(
        &e,
        Some(&key.pk()),
        &["update", "--yes", "--from", b.to_str().unwrap()],
    ));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("digest-mismatch")),
        "{doc}"
    );
    assert_eq!(state_of(&e), before);
    assert!(!e.home.join("update/bundle").exists());
    assert!(!e.home.join("update/staging").exists());

    // An artefact the manifest needs but the bundle lacks.
    let mut files = rel.bundle_files(&key);
    files.remove(2);
    let b = e.root.join("missing.zip");
    write_zip(&b, &files);
    let (code, doc) = run(&mut cmd(
        &e,
        Some(&key.pk()),
        &["update", "--yes", "--from", b.to_str().unwrap()],
    ));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("bundle-invalid")),
        "{doc}"
    );
    assert_eq!(state_of(&e), before);
}

#[test]
fn a_traversal_archive_is_refused_and_writes_nothing_outside() {
    let e = env();
    let key = Key::new();
    let rel = Release::new(&e, "0.2.0");
    for (fmt, name) in [
        ("tar.zst", "../escaped"),
        ("zip", "../../escaped"),
        ("zip", "/tmp/p1b-escaped"),
    ] {
        let mut files = rel.bundle_files(&key);
        files.push((name.to_string(), b"pwned".to_vec()));
        let b = e.root.join(format!("trav.{fmt}"));
        if fmt == "zip" {
            write_zip(&b, &files);
        } else {
            write_tar_zst(&b, &files);
        }
        let before = state_of(&e);
        let (code, doc) = run(&mut cmd(
            &e,
            Some(&key.pk()),
            &["update", "--yes", "--from", b.to_str().unwrap()],
        ));
        assert_eq!(
            (code, doc["reason"].as_str()),
            (1, Some("archive-unsafe-entry")),
            "{fmt} {name}: {doc}"
        );
        assert_eq!(state_of(&e), before);
        assert!(!e.root.join("escaped").exists() && !e.home.join("escaped").exists());
        assert!(!Path::new("/tmp/p1b-escaped").exists());
        assert!(!e.home.join("update/bundle").exists());
    }
}

#[test]
fn a_declared_size_is_enforced_and_a_bundle_cannot_switch_channels() {
    let e = env();
    let key = Key::new();
    let mut rel = Release::new(&e, "0.2.0");
    rel.declared_size = Some(rel.script.len() as u64 - 1);
    let b = e.root.join("size.zip");
    write_zip(&b, &rel.bundle_files(&key));
    let (code, doc) = run(&mut cmd(
        &e,
        Some(&key.pk()),
        &["update", "--yes", "--from", b.to_str().unwrap()],
    ));
    assert_eq!(code, 1, "{doc}");
    assert!(
        matches!(
            doc["reason"].as_str(),
            Some("download-too-large" | "size-mismatch")
        ),
        "{doc}"
    );
    assert_eq!(installed_version(&e), "0.1.0");

    let mut beta = Release::new(&e, "0.2.0");
    beta.extra = json!({ "channel": "beta" });
    let b = e.root.join("beta.zip");
    write_zip(&b, &beta.bundle_files(&key));
    let (code, doc) = run(&mut cmd(
        &e,
        Some(&key.pk()),
        &["update", "--yes", "--from", b.to_str().unwrap()],
    ));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("channel-mismatch")),
        "{doc}"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// Downgrade and replay

#[test]
fn a_downgrade_is_refused_unless_it_is_allowed() {
    let e = env_with("0.3.0", None);
    let key = Key::new();
    let f = Release::new(&e, "0.2.0").feed(&e, "feed", &key);
    let before = state_of(&e);
    let (code, doc) = run(&mut online(&e, &f, &[]));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("downgrade-refused")),
        "{doc}"
    );
    assert_eq!(state_of(&e), before);
    assert!(
        !e.home.join("update/guard.json").exists(),
        "a refusal records nothing"
    );

    let (code, doc) = run(&mut online(&e, &f, &["--plan", "--allow-downgrade"]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(doc["downgrade"], true);
    assert_eq!(state_of(&e), before, "--plan changes nothing");

    let (code, doc) = run(&mut online(&e, &f, &["--allow-downgrade"]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(doc["outcome"], "committed", "{doc}");
    assert_eq!(installed_version(&e), "0.2.0");
    assert_eq!(guard(&e)["highestSeen"]["stable"], "0.2.0");
}

#[test]
fn an_older_signed_manifest_is_a_replay_once_a_newer_one_was_accepted() {
    let e = env();
    let key = Key::new();
    let new = Release::new(&e, "0.3.0").feed(&e, "new", &key);
    let (code, doc) = run(&mut online(&e, &new, &[]));
    assert_eq!(
        (code, doc["outcome"].as_str()),
        (0, Some("committed")),
        "{doc}"
    );
    assert_eq!(guard(&e)["highestSeen"]["stable"], "0.3.0");

    // Back to 0.1.0 by a manual rollback; an old but validly signed 0.2.0 manifest is now served.
    let (code, _) = run(&mut cmd(&e, None, &["update", "--rollback"]));
    assert_eq!(code, 0);
    assert_eq!(installed_version(&e), "0.1.0");
    let old = Release::new(&e, "0.2.0").feed(&e, "old", &key);
    let before = state_of(&e);
    let (code, doc) = run(&mut online(&e, &old, &[]));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("release-replay")),
        "{doc}"
    );
    assert_eq!(state_of(&e), before);
    // The newer release is still fine, and the flag overrides.
    let (code, doc) = run(&mut online(&e, &new, &["--plan"]));
    assert_eq!(code, 0, "{doc}");
    let (code, doc) = run(&mut online(&e, &old, &["--allow-downgrade"]));
    assert_eq!(
        (code, doc["outcome"].as_str()),
        (0, Some("committed")),
        "{doc}"
    );
    assert_eq!(
        guard(&e)["highestSeen"]["stable"],
        "0.3.0",
        "the highest version is never lowered"
    );
}

#[test]
fn a_replay_is_refused_for_an_offline_bundle_too() {
    let e = env();
    let key = Key::new();
    fs::create_dir_all(e.home.join("update")).unwrap();
    fs::write(
        e.home.join("update/guard.json"),
        r#"{"schemaVersion":1,"highestSeen":{"stable":"0.9.0"},"keys":[]}"#,
    )
    .unwrap();
    let b = e.root.join("old.zip");
    write_zip(&b, &Release::new(&e, "0.2.0").bundle_files(&key));
    let (code, doc) = run(&mut cmd(
        &e,
        Some(&key.pk()),
        &["update", "--yes", "--from", b.to_str().unwrap()],
    ));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("release-replay")),
        "{doc}"
    );
    assert!(!e.home.join("update/bundle").exists());
}

// ---------------------------------------------------------------------------------------------------------------
// Key rotation

fn key_list(channel: &str, keys: &[(&Key, &str)]) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "schemaVersion": 1, "channel": channel,
        "keys": keys.iter().map(|(k, exp)| json!({ "publicKey": k.pk(), "expires": exp })).collect::<Vec<_>>(),
    }))
    .unwrap()
}

#[test]
fn a_rotated_key_announced_by_a_signed_list_is_accepted_and_remembered() {
    let e = env();
    let (old, new) = (Key::new(), Key::new());
    // The feed is signed by the NEW key; the build only knows the OLD one. The list next to the feed bridges that.
    let f = Release::new(&e, "0.2.0").feed(&e, "feed", &new);
    let list = key_list("stable", &[(&new, "2999-01-01")]);
    fs::write(f.dir.join("stable.keys.json"), &list).unwrap();
    fs::write(f.dir.join("stable.keys.json.minisig"), old.sign(&list)).unwrap();
    let f_old_trust = Feed {
        pubkey: old.pk(),
        path: f.path.clone(),
        dir: f.dir.clone(),
    };

    // --check accepts the signature but writes nothing.
    let (code, doc) = run(&mut cmd(
        &e,
        Some(&old.pk()),
        &["update", "--check", "--manifest", f.path.to_str().unwrap()],
    ));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(doc["verified"], true, "{doc}");
    assert!(!e.home.join("update/guard.json").exists());

    let (code, doc) = run(&mut online(&e, &f_old_trust, &[]));
    assert_eq!(
        (code, doc["outcome"].as_str()),
        (0, Some("committed")),
        "{doc}"
    );
    assert_eq!(guard(&e)["keys"][0]["publicKey"], new.pk());

    // Remembered: a 0.3.0 signed by the new key now verifies with no list at all.
    let (code, _) = run(&mut cmd(&e, None, &["update", "--rollback"]));
    assert_eq!(code, 0);
    let f3 = Release::new(&e, "0.3.0").feed(&e, "feed3", &new);
    let (code, doc) = run(&mut online(
        &e,
        &Feed {
            pubkey: old.pk(),
            path: f3.path.clone(),
            dir: f3.dir.clone(),
        },
        &[],
    ));
    assert_eq!(
        (code, doc["outcome"].as_str()),
        (0, Some("committed")),
        "{doc}"
    );
}

#[test]
fn an_unannounced_key_a_foreign_list_and_an_expired_key_are_refused() {
    let e = env();
    let (old, new, evil) = (Key::new(), Key::new(), Key::new());
    let before = state_of(&e);

    // Signed by a key nobody announced.
    let f = Release::new(&e, "0.2.0").feed(&e, "feed", &new);
    let f = Feed {
        pubkey: old.pk(),
        ..f
    };
    let (code, doc) = run(&mut online(&e, &f, &[]));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("release-signature-invalid")),
        "{doc}"
    );

    // A list signed by a stranger.
    let list = key_list("stable", &[(&new, "2999-01-01")]);
    fs::write(f.dir.join("stable.keys.json"), &list).unwrap();
    fs::write(f.dir.join("stable.keys.json.minisig"), evil.sign(&list)).unwrap();
    let (code, doc) = run(&mut online(&e, &f, &[]));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("key-list-invalid")),
        "{doc}"
    );

    // A correctly signed list whose key has expired.
    let list = key_list("stable", &[(&new, "2020-01-01")]);
    fs::write(f.dir.join("stable.keys.json"), &list).unwrap();
    fs::write(f.dir.join("stable.keys.json.minisig"), old.sign(&list)).unwrap();
    let (code, doc) = run(&mut online(&e, &f, &[]));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("release-key-expired")),
        "{doc}"
    );
    assert_eq!(state_of(&e), before);
    assert!(!e.home.join("update/guard.json").exists());

    // Offline too: the list rides in the bundle.
    let mut files = Release::new(&e, "0.2.0").bundle_files(&new);
    files.push((
        "keys.json".into(),
        key_list("stable", &[(&new, "2999-01-01")]),
    ));
    let sig = old.sign(&files.last().unwrap().1);
    files.push(("keys.json.minisig".into(), sig.into_bytes()));
    let b = e.root.join("rot.zip");
    write_zip(&b, &files);
    let (code, doc) = run(&mut cmd(
        &e,
        Some(&old.pk()),
        &["update", "--yes", "--from", b.to_str().unwrap()],
    ));
    assert_eq!(
        (code, doc["outcome"].as_str()),
        (0, Some("committed")),
        "{doc}"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// The plan

fn rich_release(e: &Env) -> Release {
    let mut rel = Release::new(e, "0.2.0").with_core();
    rel.extra = json!({
        "security": true,
        "notes": { "en": "Summer release.", "de": "Sommer-Release." },
        "changes": {
            "new": [ { "en": "Dark mode", "de": "Dunkelmodus" } ],
            "changed": [ "Faster start" ],
            "fixed": [ { "en": "Crash on exit", "de": "Absturz beim Beenden" } ],
            "attention": [ { "en": "Config key renamed", "de": "Konfigurationsschlüssel umbenannt" } ]
        },
        "breaking": [ { "summary": { "en": "Clients must use RPC 1.3", "de": "Clients brauchen RPC 1.3" },
                        "action": { "en": "Update your clients", "de": "Clients aktualisieren" } } ],
        "migrations": [ { "id": "store-v3", "description": { "en": "Re-index memory", "de": "Memory neu indizieren" }, "reversible": false },
                        { "id": "cfg-v2", "reversible": true } ]
    });
    rel.declared_size = Some(rel.script.len() as u64);
    rel
}

#[test]
fn plan_prints_the_whole_plan_changes_nothing_and_speaks_german_on_request() {
    let e = env();
    let key = Key::new();
    let f = rich_release(&e).feed(&e, "feed", &key);
    let before = state_of(&e);
    let args = ["update", "--plan", "--manifest", f.path.to_str().unwrap()];

    let (code, p) = run(&mut cmd(&e, Some(&key.pk()), &args));
    assert_eq!(code, 0, "{p}");
    assert_eq!(p["schema"], "update.plan/1");
    assert_eq!(
        (p["from"].as_str(), p["to"].as_str()),
        (Some("0.1.0"), Some("0.2.0"))
    );
    assert_eq!(p["lang"], "en");
    assert_eq!(p["security"], true);
    assert_eq!(p["notes"]["new"], json!(["Dark mode"]));
    assert_eq!(p["notes"]["fixed"], json!(["Crash on exit"]));
    assert!(p["notes"]["attention"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a == "Config key renamed"));
    assert_eq!(p["breaking"][0]["action"], "Update your clients");
    assert_eq!(p["migrations"][0]["reversible"], false);
    assert_eq!(p["migrations"][1]["reversible"], true);
    assert_eq!(p["restart"]["core"], true);
    assert_eq!(p["restart"]["supervisor"], true);
    assert_eq!(p["download"]["files"][0]["name"], "plur1bus");
    assert!(p["download"]["files"][0]["bytes"].is_u64());
    assert_eq!(p["rollback"]["keeps"], json!(["memory-store"]));
    assert_eq!(p["addons"]["items"], json!([]));

    let (code, p) = run(&mut cmd(
        &e,
        Some(&key.pk()),
        &[args.as_slice(), &["--lang", "de"]].concat(),
    ));
    assert_eq!(code, 0);
    assert_eq!(p["lang"], "de");
    assert_eq!(p["notes"]["new"], json!(["Dunkelmodus"]));
    assert_eq!(p["breaking"][0]["action"], "Clients aktualisieren");

    // Text mode: no `--json`.
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.arg("--home")
        .arg(&e.home)
        .args(args)
        .args(["--lang", "de"])
        .env("HOME", e.root.join("user"))
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_TEST_RELEASE_PUBKEY", key.pk())
        .env_remove("PLUR1BUS_CONTAINER");
    let (code, text) = text_run(&mut c);
    assert_eq!(code, 0, "{text}");
    for needle in [
        "Update 0.1.0 -> 0.2.0 (stable)",
        "Sicherheits-Release",
        "Sommer-Release.",
        "Neu:\n  - Dunkelmodus",
        "Inkompatible Änderungen:",
        "Was zu tun ist: Clients aktualisieren",
        "store-v3: Memory neu indizieren (NICHT umkehrbar)",
        "Rollback:",
    ] {
        assert!(text.contains(needle), "{needle:?} missing in:\n{text}");
    }
    assert_eq!(state_of(&e), before);
    assert!(
        !e.home.join("update/state.json").exists() && !e.home.join("update/guard.json").exists()
    );
}

#[test]
fn the_locale_picks_the_language_and_apply_shows_the_plan_before_it_acts() {
    let e = env();
    let key = Key::new();
    let f = rich_release(&e).feed(&e, "feed", &key);
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.arg("--home")
        .arg(&e.home)
        .args(["update", "--yes", "--manifest", f.path.to_str().unwrap()])
        .env("HOME", e.root.join("user"))
        .env("LC_ALL", "de_DE.UTF-8")
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_TEST_RELEASE_PUBKEY", key.pk())
        .env("PLUR1BUS_SERVICE_FAKE", e.root.join("fake"))
        .env("PLUR1BUS_UPDATE_TARGET_BIN", &e.target)
        .env("PLUR1BUS_UPDATE_GATE_TIMEOUT_MS", "1500")
        .env_remove("PLUR1BUS_CONTAINER")
        .stdin(Stdio::null());
    let (code, text) = text_run(&mut c);
    assert_eq!(code, 0, "{text}");
    let plan_at = text.find("Neu:").expect("the German plan is printed");
    let done_at = text
        .find("updated 0.1.0 -> 0.2.0")
        .expect("then the result");
    assert!(plan_at < done_at, "{text}");
    assert_eq!(installed_version(&e), "0.2.0");
}

// ---------------------------------------------------------------------------------------------------------------
// Add-on compatibility (a module installed by hand: judged by its apiVersion against `native.provides.moduleApi`)

fn write_module(e: &Env, name: &str, api: &str) {
    // The ext layer reads and validates the whole configuration when it flips a module's flag.
    fs::write(e.home.join("config.json"), "{\"schemaVersion\":1}\n").unwrap();
    let dir = e.home.join("modules").join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("index.js"), "// module\n").unwrap();
    fs::write(
        dir.join("module.json"),
        serde_json::to_string(&json!({
            "name": name, "version": "1.0.0", "apiVersion": api,
            "entry": "index.js", "scope": "installation", "priority": 500,
        }))
        .unwrap(),
    )
    .unwrap();
}

fn module_enabled(e: &Env, name: &str) -> bool {
    let cfg: Value =
        serde_json::from_slice(&fs::read(e.home.join("config.json")).unwrap()).unwrap();
    cfg["modules"][name]["enabled"] != false
}

fn provides(api: &[&str]) -> Value {
    json!({ "provides": { "moduleApi": api } })
}

#[test]
fn an_incompatible_addon_is_reported_and_disabled_and_a_later_compatible_update_re_enables_it() {
    let e = env_with("0.1.0", Some("host"));
    write_module(&e, "fancy", "1");
    let key = Key::new();

    // Release 0.2.0 speaks module API 2 only: "fancy" (API 1) is incompatible. Not required, so the update proceeds.
    let mut rel = Release::new(&e, "0.2.0");
    rel.native_extra = provides(&["2"]);
    let f = rel.feed(&e, "feed2", &key);
    let (code, p) = run(&mut online(&e, &f, &["--plan"]));
    assert_eq!(code, 0, "{p}");
    assert_eq!(p["addons"]["incompatible"], 1, "{p}");
    assert_eq!(p["addons"]["willDisable"], json!(["fancy"]));
    assert_eq!(p["addons"]["items"][0]["status"], "incompatible");
    assert!(module_enabled(&e, "fancy"), "--plan changes nothing");

    let (code, doc) = run(&mut online(&e, &f, &[]));
    assert_eq!(
        (code, doc["outcome"].as_str()),
        (0, Some("committed")),
        "{doc}"
    );
    assert!(!module_enabled(&e, "fancy"), "disabled for the new version");
    let rec: Value =
        serde_json::from_slice(&fs::read(e.home.join("update/addons.json")).unwrap()).unwrap();
    assert_eq!(rec["disabled"][0]["name"], "fancy");
    assert_eq!(
        (
            rec["disabled"][0]["from"].as_str(),
            rec["disabled"][0]["to"].as_str()
        ),
        (Some("0.1.0"), Some("0.2.0"))
    );

    // 0.3.0 speaks API 1 and 2 again: fancy is compatible, was held by the earlier update, and comes back.
    let mut rel = Release::new(&e, "0.3.0");
    rel.native_extra = provides(&["1", "2"]);
    let f = rel.feed(&e, "feed3", &key);
    let (code, p) = run(&mut online(&e, &f, &["--plan"]));
    assert_eq!(code, 0, "{p}");
    assert_eq!(p["addons"]["willReenable"], json!(["fancy"]), "{p}");
    let (code, doc) = run(&mut online(&e, &f, &[]));
    assert_eq!(
        (code, doc["outcome"].as_str()),
        (0, Some("committed")),
        "{doc}"
    );
    assert!(module_enabled(&e, "fancy"));
    let rec: Value =
        serde_json::from_slice(&fs::read(e.home.join("update/addons.json")).unwrap()).unwrap();
    assert_eq!(rec["disabled"], json!([]));
}

#[test]
fn a_required_incompatible_addon_aborts_unless_forced() {
    let e = env_with("0.1.0", Some("host"));
    write_module(&e, "fancy", "1");
    let key = Key::new();
    let mut rel = Release::new(&e, "0.2.0");
    rel.native_extra = provides(&["2"]);
    let f = rel.feed(&e, "feed", &key);
    let before = state_of(&e);

    let (code, doc) = run(&mut online(&e, &f, &["--require-addon", "fancy"]));
    assert_eq!(
        (code, doc["reason"].as_str()),
        (1, Some("addon-incompatible")),
        "{doc}"
    );
    assert!(doc["message"].as_str().unwrap().contains("fancy"));
    assert_eq!(state_of(&e), before);
    assert!(module_enabled(&e, "fancy"));
    assert!(!e.home.join("update/state.json").exists());
    assert!(
        !e.home.join("update/addons.json").exists(),
        "a refusal remembers nothing"
    );

    let (code, doc) = run(&mut online(
        &e,
        &f,
        &["--require-addon", "fancy", "--force"],
    ));
    assert_eq!(
        (code, doc["outcome"].as_str()),
        (0, Some("committed")),
        "{doc}"
    );
    assert!(!module_enabled(&e, "fancy"));
    let rec: Value =
        serde_json::from_slice(&fs::read(e.home.join("update/addons.json")).unwrap()).unwrap();
    assert_eq!(
        rec["required"],
        json!(["fancy"]),
        "the marker is remembered"
    );
    assert_eq!(rec["disabled"][0]["name"], "fancy");
}

#[test]
fn unknown_compatibility_never_blocks_and_a_rolled_back_update_leaves_addons_enabled() {
    let e = env_with("0.1.0", Some("host"));
    write_module(&e, "fancy", "1");
    let key = Key::new();

    // The release does not say what it speaks: unknown, not disabled, even when the module is required.
    let f = Release::new(&e, "0.2.0").feed(&e, "feed", &key);
    let (code, p) = run(&mut online(&e, &f, &["--plan", "--require-addon", "fancy"]));
    assert_eq!(code, 0, "{p}");
    assert_eq!(p["addons"]["unknown"], 1);
    assert_eq!(p["addons"]["willDisable"], json!([]));

    // An incompatible add-on is disabled, then the health gate fails: the snapshot (config.json) brings it back.
    let mut rel = Release::new(&e, "0.2.0");
    rel.native_extra = provides(&["2"]);
    rel.script = rel.script.replace(
        "echo '{\"ok\":true,\"checks\":[]}'",
        "echo '{\"ok\":false,\"checks\":[{\"id\":\"x\",\"status\":\"fail\"}]}'; exit 1",
    );
    let f = rel.feed(&e, "feed-bad", &key);
    let (code, doc) = run(&mut online(&e, &f, &[]));
    assert_eq!(code, 1, "{doc}");
    assert_eq!(doc["outcome"], "rolled-back", "{doc}");
    assert!(module_enabled(&e, "fancy"), "rollback restored the flag");
    let rec: Value = serde_json::from_slice(
        &fs::read(e.home.join("update/addons.json"))
            .unwrap_or_else(|_| b"{\"disabled\":[]}".to_vec()),
    )
    .unwrap();
    assert_eq!(rec["disabled"], json!([]), "nothing stays recorded");
}
