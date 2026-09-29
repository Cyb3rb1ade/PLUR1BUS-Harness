//! `plur1bus update --check` (2a-H3b-b Task 5, spec §6.5, D78, HB10). No network: signed release manifests are
//! generated in the test with a throwaway minisign key (`minisign` dev-dependency; the crate has no signer of its
//! own, only `minisign-verify`, HB6/HB10). Every `--manifest` source is a local file (`install::fetch` already
//! proves its `https://`/loopback path in `tests/install_archive.rs`); Review Focus 4's "offline" case uses a
//! closed TCP port instead of a real network.
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

fn bin() -> PathBuf {
    assert_cmd::cargo::cargo_bin("plur1bus")
}

struct Home {
    _dir: tempfile::TempDir,
    home: PathBuf,
}

impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("h");
        fs::create_dir_all(&home).unwrap();
        Self { _dir: dir, home }
    }

    /// Writes `<home>/manifest.json`, the install manifest `update --check` reads (HB9). `patch` overrides fields
    /// of the base fixture (target [`HOST`], this test host, Task 3's `Target::current`).
    fn write_manifest(&self, patch: impl FnOnce(&mut Value)) {
        let mut doc = base_manifest();
        patch(&mut doc);
        fs::write(
            self.home.join("manifest.json"),
            serde_json::to_string_pretty(&doc).unwrap(),
        )
        .unwrap();
    }

    /// Writes `<home>/modules/<name>/module.json` (D14): the on-disk truth `update --check` reads for the
    /// installed module list, never the install manifest (which carries no `apiVersion`).
    fn write_module(&self, name: &str, version: &str, api_version: &str) {
        let dir = self.home.join("modules").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("module.json"),
            serde_json::to_string(&json!({
                "name": name,
                "version": version,
                "apiVersion": api_version,
                "entry": "index.js",
                "scope": "installation",
                "priority": 500,
            }))
            .unwrap(),
        )
        .unwrap();
    }
}

/// The target id of this test host, as `install::targets::Target::current` names it. The fixtures are written for
/// it: a release entry keyed by another target is (rightly) not this host's binary.
const HOST: &str = if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
    "linux-x64"
} else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
    "linux-arm64"
} else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    "darwin-arm64"
} else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
    "win-x64"
} else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
    "win-arm64"
} else {
    "unsupported"
};

/// `doc` with every `linux-x64` (the fixtures' spelling) replaced by [`HOST`].
fn for_host(doc: Value) -> Value {
    serde_json::from_str(&doc.to_string().replace("linux-x64", HOST)).unwrap()
}

const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// The installed side: binary 0.1.0 (sha `SHA_A`), core 0.1.0 (contract 1.9.0, rpc 1.3.0), node 24.21.0, channel
/// stable, target [`HOST`] (this test host).
fn base_manifest() -> Value {
    for_host(json!({
        "schemaVersion": 1,
        "installedAt": 1_790_000_000_000u64,
        "updatedAt": 1_790_000_000_000u64,
        "channel": "stable",
        "target": "linux-x64",
        "binary": { "version": "0.1.0", "sha256": SHA_A },
        "node": { "version": "24.21.0", "archiveSha256": SHA_B, "binarySha256": SHA_B, "path": "/tmp/node" },
        "core": { "version": "0.1.0", "contract": "1.9.0", "rpc": "1.3.0", "sha256": SHA_A, "source": "local" },
        "modules": [],
        "skills": [],
    }))
}

/// The release side, matching `base_manifest()` exactly (so by default nothing has changed): version 0.1.0
/// (not newer), `native` unchanged from the installed unit for unit, including the `fixture` module at 0.1.0/"1".
/// A test bumps `head.version` (and whatever unit it means to change) to make an update visible.
fn base_release() -> Value {
    for_host(json!({
        "version": "0.1.0",
        "channel": "stable",
        "kind": "patch",
        "security": false,
        "minFromVersion": "0.1.0",
        "notes": { "en": "test fixture" },
        "native": {
            "binary": { "linux-x64": { "url": "https://example.invalid/plur1bus-linux-x64", "sha256": SHA_A } },
            "core": {
                "version": "0.1.0",
                "contract": "1.9.0",
                "rpc": "1.3.0",
                "payload": { "linux-x64": { "url": "https://example.invalid/core.tar.gz", "sha256": SHA_A } },
            },
            "node": { "version": "24.21.0" },
            "modules": [{ "name": "fixture", "version": "0.1.0", "apiVersion": "1" }],
            "configSchemaVersion": 1,
        },
    }))
}

fn write_json(dir: &Path, name: &str, doc: &Value) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, serde_json::to_vec(doc).unwrap()).unwrap();
    path
}

/// A throwaway minisign key pair (TEST ONLY, generated fresh every run — HB10's real channel keys are baked at
/// release build, never committed here) and the `.minisig` text for `data`.
fn sign(data: &[u8]) -> (String, String) {
    let kp = minisign::KeyPair::generate_unencrypted_keypair().expect("keypair");
    let sig_box = minisign::sign(
        Some(&kp.pk),
        &kp.sk,
        data,
        Some("plur1bus update test fixture"),
        Some("TEST ONLY minisign key, generated per test run"),
    )
    .expect("sign");
    (kp.pk.to_base64(), sig_box.into_string())
}

fn update_cmd(h: &Home) -> Command {
    let mut c = Command::new(bin());
    c.arg("--json")
        .arg("--home")
        .arg(&h.home)
        .args(["update", "--check"])
        .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS")
        .env_remove("PLUR1BUS_TEST_RELEASE_PUBKEY")
        .env_remove("PLUR1BUS_CONTAINER");
    c
}

fn run(c: &mut Command) -> (i32, Value) {
    let out: Output = c.output().unwrap();
    let code = out.status.code().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let doc: Value = serde_json::from_str(&stdout).unwrap_or_else(|e| {
        panic!(
            "not JSON ({e}): stdout={stdout:?} stderr={:?}",
            String::from_utf8_lossy(&out.stderr)
        )
    });
    (code, doc)
}

#[test]
fn no_update_when_the_release_is_not_newer() {
    let h = Home::new();
    h.write_manifest(|_| {});
    let release = base_release(); // version 0.1.0 == installed
    let path = write_json(h._dir.path(), "stable.json", &release);
    let (code, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(doc["schema"], "update.check/1");
    assert!(doc["available"].is_null(), "{doc}");
    assert_eq!(doc["changes"], json!([]));
    assert_eq!(doc["blocked"], Value::Null);
    assert_eq!(doc["installed"]["version"], "0.1.0");
    assert_eq!(doc["installed"]["core"], "0.1.0");
    assert_eq!(doc["installed"]["node"], "24.21.0");
}

#[test]
fn a_core_change_plans_a_core_restart_only() {
    let h = Home::new();
    h.write_manifest(|_| {});
    h.write_module("fixture", "0.1.0", "1");
    let mut release = base_release();
    release["version"] = json!("0.2.0");
    release["native"]["core"]["version"] = json!("0.2.0");
    let path = write_json(h._dir.path(), "stable.json", &release);
    let (code, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(doc["available"]["version"], "0.2.0");
    assert_eq!(
        doc["changes"],
        json!([{ "unit": "core", "from": "0.1.0", "to": "0.2.0" }])
    );
    assert_eq!(doc["restart"]["core"], true);
    assert_eq!(doc["restart"]["modules"], json!([]));
    assert_eq!(doc["supervisorRestart"], false);
}

#[test]
fn a_node_change_restarts_the_core_and_every_module() {
    let h = Home::new();
    h.write_manifest(|_| {});
    h.write_module("fixture", "0.1.0", "1");
    let mut release = base_release();
    release["version"] = json!("0.2.0");
    release["native"]["node"]["version"] = json!("24.22.0");
    let path = write_json(h._dir.path(), "stable.json", &release);
    let (code, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(
        doc["changes"],
        json!([{ "unit": "node", "from": "24.21.0", "to": "24.22.0" }])
    );
    assert_eq!(doc["restart"]["core"], true);
    assert_eq!(doc["restart"]["modules"], json!(["fixture"]));
    assert_eq!(doc["supervisorRestart"], false);
}

#[test]
fn a_module_version_change_restarts_only_that_module() {
    let h = Home::new();
    h.write_manifest(|_| {});
    h.write_module("fixture", "0.1.0", "1");
    let mut release = base_release();
    release["version"] = json!("0.2.0");
    release["native"]["modules"][0]["version"] = json!("0.2.0");
    let path = write_json(h._dir.path(), "stable.json", &release);
    let (code, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(
        doc["changes"],
        json!([{ "unit": "module:fixture", "from": "0.1.0", "to": "0.2.0" }])
    );
    assert_eq!(doc["restart"]["core"], false);
    assert_eq!(doc["restart"]["modules"], json!(["fixture"]));
    assert_eq!(doc["supervisorRestart"], false);
}

/// HM2-R9, F35: the host profile installs no bundled modules, so the release's modules are neither added nor removed
/// for it; its other units are compared as usual.
#[test]
fn a_host_profile_does_not_plan_the_release_modules() {
    let h = Home::new();
    h.write_manifest(|m| m["profile"] = json!("host"));
    let mut release = base_release();
    release["version"] = json!("0.2.0");
    release["native"]["modules"][0]["version"] = json!("0.2.0");
    let path = write_json(h._dir.path(), "stable.json", &release);
    let (code, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(doc["available"]["version"], "0.2.0");
    assert_eq!(doc["changes"], json!([]), "{doc}");
    assert_eq!(doc["restart"]["modules"], json!([]));

    release["native"]["core"]["version"] = json!("0.2.0");
    let path = write_json(h._dir.path(), "stable.json", &release);
    let (_, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(
        doc["changes"],
        json!([{ "unit": "core", "from": "0.1.0", "to": "0.2.0" }])
    );
    assert_eq!(doc["restart"]["core"], true);

    // A module the host user installed (here even one the release ships) is theirs: listed as installed, never
    // planned as an update or a removal.
    h.write_module("mine", "1.0.0", "1");
    h.write_module("fixture", "0.0.9", "1");
    let (_, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(
        doc["changes"],
        json!([{ "unit": "core", "from": "0.1.0", "to": "0.2.0" }])
    );
    assert_eq!(doc["restart"]["modules"], json!([]));
    let installed: Vec<&str> = doc["installed"]["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap())
        .collect();
    assert_eq!(installed, ["fixture", "mine"]);
}

/// The same installed module on a full profile is still planned for removal when the release drops it (unchanged).
#[test]
fn a_full_profile_still_plans_removing_a_module_the_release_drops() {
    let h = Home::new();
    h.write_manifest(|_| {});
    h.write_module("mine", "1.0.0", "1");
    let mut release = base_release();
    release["version"] = json!("0.2.0");
    release["native"]["modules"] = json!([]);
    let path = write_json(h._dir.path(), "stable.json", &release);
    let (_, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(
        doc["changes"],
        json!([{ "unit": "module:mine", "from": "1.0.0", "to": null }])
    );
}

#[test]
fn a_new_module_reports_from_null_and_no_restart() {
    let h = Home::new();
    h.write_manifest(|_| {});
    // No module installed at all.
    let mut release = base_release();
    release["version"] = json!("0.2.0");
    let path = write_json(h._dir.path(), "stable.json", &release);
    let (code, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(
        doc["changes"],
        json!([{ "unit": "module:fixture", "from": Value::Null, "to": "0.1.0" }])
    );
    assert_eq!(doc["restart"]["modules"], json!([]));
}

#[test]
fn a_removed_module_reports_to_null() {
    let h = Home::new();
    h.write_manifest(|_| {});
    h.write_module("fixture", "0.1.0", "1");
    let mut release = base_release();
    release["version"] = json!("0.2.0");
    release["native"]["modules"] = json!([]);
    let path = write_json(h._dir.path(), "stable.json", &release);
    let (code, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(
        doc["changes"],
        json!([{ "unit": "module:fixture", "from": "0.1.0", "to": Value::Null }])
    );
}

#[test]
fn a_binary_change_sets_supervisor_restart() {
    let h = Home::new();
    h.write_manifest(|_| {});
    h.write_module("fixture", "0.1.0", "1");
    let mut release = base_release();
    release["version"] = json!("0.2.0");
    release["native"]["binary"][HOST]["sha256"] = json!(SHA_B);
    let path = write_json(h._dir.path(), "stable.json", &release);
    let (code, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(
        doc["changes"],
        json!([{ "unit": "binary", "from": "0.1.0", "to": "0.2.0" }])
    );
    assert_eq!(doc["supervisorRestart"], true);
    assert_eq!(doc["restart"]["core"], false);
}

#[test]
fn min_from_version_blocks() {
    let h = Home::new();
    h.write_manifest(|_| {}); // installed binary 0.1.0
    let mut release = base_release();
    release["version"] = json!("0.5.0");
    release["minFromVersion"] = json!("0.3.0"); // installed 0.1.0 < 0.3.0: cannot jump directly
    release["native"]["core"]["version"] = json!("0.5.0");
    let path = write_json(h._dir.path(), "stable.json", &release);
    let (code, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 0, "a blocked plan is still a successful check: {doc}");
    assert_eq!(doc["available"]["version"], "0.5.0");
    assert_eq!(
        doc["blocked"],
        json!({ "reason": "min-from-version", "minFromVersion": "0.3.0" })
    );
    assert_eq!(doc["changes"], json!([]));
    assert_eq!(doc["restart"]["core"], false);
    assert_eq!(doc["supervisorRestart"], false);
}

#[test]
fn not_installed_is_not_available_with_the_setup_hint() {
    let h = Home::new(); // no manifest.json written
    let (code, doc) = run(&mut update_cmd(&h));
    assert_eq!(code, 1, "{doc}");
    assert_eq!(doc["error"], "E_NOT_AVAILABLE");
    assert_eq!(doc["reason"], "not-installed");
    assert!(
        doc["message"].as_str().unwrap().contains("plur1bus setup"),
        "{doc}"
    );
}

#[test]
fn a_bad_signature_is_refused_when_a_key_is_present() {
    let h = Home::new();
    h.write_manifest(|_| {});
    let release = base_release();
    let raw = serde_json::to_vec(&release).unwrap();
    let (pubkey, sig_text) = sign(&raw);

    // One byte of the *served* JSON is flipped after signing, but it must stay valid JSON and schema-valid, so the
    // failure is caught at the signature check, not at parsing.
    let mut tampered: Value = serde_json::from_slice(&raw).unwrap();
    tampered["notes"]["en"] = json!("tampered fixture");
    let tampered_raw = serde_json::to_vec(&tampered).unwrap();

    let path = h._dir.path().join("stable.json");
    fs::write(&path, &tampered_raw).unwrap();
    fs::write(format!("{}.minisig", path.display()), &sig_text).unwrap();

    let (code, doc) = run(update_cmd(&h)
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_TEST_RELEASE_PUBKEY", &pubkey)
        .args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 1, "{doc}");
    assert_eq!(doc["error"], "E_NOT_AVAILABLE");
    assert_eq!(doc["reason"], "release-signature-invalid");
}

#[test]
fn a_correct_signature_is_verified() {
    let h = Home::new();
    h.write_manifest(|_| {});
    let release = base_release();
    let raw = serde_json::to_vec(&release).unwrap();
    let (pubkey, sig_text) = sign(&raw);
    let path = h._dir.path().join("stable.json");
    fs::write(&path, &raw).unwrap();
    fs::write(format!("{}.minisig", path.display()), &sig_text).unwrap();

    let (code, doc) = run(update_cmd(&h)
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_TEST_RELEASE_PUBKEY", &pubkey)
        .args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(doc["verified"], true);
}

#[test]
fn without_a_key_the_result_says_verified_false() {
    let h = Home::new();
    h.write_manifest(|_| {});
    let release = base_release();
    let path = write_json(h._dir.path(), "stable.json", &release);
    // No PLUR1BUS_TEST_RELEASE_PUBKEY, no PLUR1BUS_ALLOW_TEST_INTERNALS: a dev build with no baked channel key.
    let (code, doc) = run(update_cmd(&h).args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 0, "{doc}");
    assert_eq!(doc["verified"], false);
}

#[test]
fn update_check_in_container_mode_is_container_managed() {
    let h = Home::new();
    h.write_manifest(|_| {});
    let release = base_release();
    let path = write_json(h._dir.path(), "stable.json", &release);
    let (code, doc) = run(update_cmd(&h)
        .env("PLUR1BUS_CONTAINER", "1")
        .args(["--manifest", path.to_str().unwrap()]));
    assert_eq!(code, 1, "{doc}");
    assert_eq!(doc["error"], "E_NOT_AVAILABLE");
    assert_eq!(doc["reason"], "container-managed");
}

#[test]
fn update_without_check_is_the_m8_stub_even_with_no_manifest() {
    let h = Home::new(); // no install manifest: proves the M8 stub is checked first, before reading it
    let mut c = Command::new(bin());
    c.arg("--json").arg("--home").arg(&h.home).arg("update");
    let (code, doc) = run(&mut c);
    assert_eq!(code, 2, "{doc}");
    assert_eq!(doc["milestone"], "M8");
}

/// Review Focus 4: an unreachable source, a malformed manifest and an oversized one all fail cleanly, within the
/// 30 s deadline, and change nothing under `home`.
#[test]
fn offline_malformed_or_oversized_manifests_fail_cleanly_and_write_nothing() {
    let h = Home::new();
    h.write_manifest(|_| {});
    let manifest_before = fs::read(h.home.join("manifest.json")).unwrap();
    let names_before = dir_names(&h.home);

    // A refused TCP port (bound, then dropped, so the port is definitely closed): connection is refused near
    // instantly, well inside the 30 s deadline.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let started = Instant::now();
    let (code, doc) = run(update_cmd(&h).args([
        "--manifest",
        &format!("http://127.0.0.1:{port}/stable.json"),
    ]));
    let took = started.elapsed();
    assert_eq!(code, 1, "{doc}");
    assert_eq!(doc["reason"], "release-unreachable", "{doc}");
    assert!(took < Duration::from_secs(31), "took {took:?}");

    // Malformed JSON.
    let bad = h._dir.path().join("bad.json");
    fs::write(&bad, b"{").unwrap();
    let (code, doc) = run(update_cmd(&h).args(["--manifest", bad.to_str().unwrap()]));
    assert_eq!(code, 1, "{doc}");
    assert_eq!(doc["reason"], "release-malformed", "{doc}");

    // Oversized (over the 1 MiB cap).
    let huge = h._dir.path().join("huge.json");
    let mut f = fs::File::create(&huge).unwrap();
    f.write_all(&vec![b' '; 50 * 1024 * 1024]).unwrap();
    drop(f);
    let (code, doc) = run(update_cmd(&h).args(["--manifest", huge.to_str().unwrap()]));
    assert_eq!(code, 1, "{doc}");
    assert_eq!(doc["reason"], "download-too-large", "{doc}");

    assert_eq!(
        fs::read(h.home.join("manifest.json")).unwrap(),
        manifest_before,
        "the install manifest is never touched by `update --check`"
    );
    assert_eq!(
        dir_names(&h.home),
        names_before,
        "nothing new is written under home"
    );
}

fn dir_names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}
