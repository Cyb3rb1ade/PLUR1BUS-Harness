//! `plur1bus backup verify|restore` against hand-built archives (no core): corruption is refused, a dry run changes
//! nothing, a restore swaps units atomically and keeps what it replaced, and an injected failure at any step leaves the old
//! state byte-identical. `create` runs against a real core in `tests/system/backup.test.ts`.
mod common;
use assert_cmd::Command;
use flate2::{write::GzEncoder, Compression};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

fn cli(home: &Path) -> Command {
    let mut c = Command::cargo_bin("plur1bus").unwrap();
    c.arg("--home")
        .arg(home)
        .arg("--json")
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .timeout(std::time::Duration::from_secs(60));
    c
}

fn sha(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

struct Fixture {
    /// (archive path, bytes)
    files: Vec<(String, Vec<u8>)>,
    manifest: Value,
}

/// A valid archive's manifest and files: a store, config.json, one agent, a journal; run-state.json is absent.
fn fixture() -> Fixture {
    let files: Vec<(String, Vec<u8>)> = vec![
        ("store/table.lance".into(), b"restored-store".to_vec()),
        ("config.json".into(), b"{\"restored\":true}".to_vec()),
        (
            "agents/bernd/persona.md".into(),
            b"restored persona".to_vec(),
        ),
        ("journal/bernd.jsonl".into(), b"{\"v\":1}\n".to_vec()),
    ];
    let manifest = json!({
        "schema": "plur1bus.backup/1", "createdAtMs": 1, "harness": { "version": "0.1.0" },
        "platform": { "os": "linux", "arch": "x86_64" }, "engine": { "contract": "1.12.0", "storeSchema": "1" },
        "storeTarget": "state/lancedb",
        "units": [
            { "archive": "store", "target": "state/lancedb", "kind": "dir" },
            { "archive": "config.json", "target": "config.json", "kind": "file" },
            { "archive": "agents", "target": "agents", "kind": "dir" },
            { "archive": "journal", "target": "state/journal", "kind": "dir" },
        ],
        "absent": ["state/memory/run-state.json"],
        "dirs": ["agents/bernd", "agents/bernd/workspace"],
        "files": files.iter().map(|(p, b)| json!({ "path": p, "bytes": b.len(), "sha256": sha(b) })).collect::<Vec<_>>(),
        "skipped": [], "secrets": { "included": false, "note": "none" },
    });
    Fixture { files, manifest }
}

fn write_tar(path: &Path, entries: &[(String, Vec<u8>)]) {
    let mut t = tar::Builder::new(GzEncoder::new(
        fs::File::create(path).unwrap(),
        Compression::default(),
    ));
    for (n, b) in entries {
        let mut h = tar::Header::new_gnu();
        h.as_gnu_mut().unwrap().name[..n.len()].copy_from_slice(n.as_bytes());
        h.set_size(b.len() as u64);
        h.set_mode(0o600);
        h.set_entry_type(tar::EntryType::Regular);
        h.set_cksum();
        t.append(&h, b.as_slice()).unwrap();
    }
    t.into_inner().unwrap().finish().unwrap();
}

fn build(path: &Path, f: &Fixture) {
    let mut entries = vec![(
        "manifest.json".to_string(),
        serde_json::to_vec(&f.manifest).unwrap(),
    )];
    entries.extend(
        f.files
            .iter()
            .map(|(p, b)| (format!("data/{p}"), b.clone())),
    );
    write_tar(path, &entries);
}

fn account_state(home: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    for name in [
        "accounts.db",
        "accounts.db-wal",
        "accounts.db-shm",
        "accounts.db-journal",
        "unrelated-api-state.json",
    ] {
        let relative = format!("state/api/{name}");
        let path = home.join(&relative);
        let bytes = format!("{name}:{}", Uuid::new_v4()).into_bytes();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, &bytes).unwrap();
        files.insert(relative, bytes);
    }
    files
}

fn assert_account_state(home: &Path, expected: &BTreeMap<String, Vec<u8>>) {
    for (relative, bytes) in expected {
        assert_eq!(fs::read(home.join(relative)).unwrap(), *bytes, "{relative}");
    }
}

fn assert_no_account_values(output: &std::process::Output, accounts: &BTreeMap<String, Vec<u8>>) {
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    for bytes in accounts.values() {
        assert!(
            !text.contains(std::str::from_utf8(bytes).unwrap()),
            "account bytes were disclosed"
        );
    }
}

/// Old archives have no inclusion-policy field; the account unit itself selects restoration.
fn add_account_unit(f: &mut Fixture, bytes: &[u8]) -> usize {
    let path = "sqlite/api/accounts.db";
    f.files.push((path.into(), bytes.to_vec()));
    f.manifest["files"].as_array_mut().unwrap().push(json!({
        "path": path, "bytes": bytes.len(), "sha256": sha(bytes),
    }));
    let units = f.manifest["units"].as_array_mut().unwrap();
    units.push(json!({ "archive": path, "target": "state/api/accounts.db", "kind": "file" }));
    units
        .iter()
        .position(|unit| unit["target"] == "state/api/accounts.db")
        .unwrap()
}

const TOMBSTONE_LINE: &str =
    "{\"schemaVersion\":1,\"status\":\"committed\",\"memoryId\":\"forgotten-after-backup\"}\n";

/// The live installation the restore replaces; `run/` and `logs/` must never be touched.
fn old_home(home: &Path) {
    let w = |p: &str, c: &str| {
        let f = home.join(p);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, c).unwrap();
    };
    w("config.json", "{\"old\":true}");
    w("state/lancedb/table.lance", "old-store");
    w("state/lancedb/extra-new-table", "post-backup data");
    w("state/memory/run-state.json", "old run-state");
    // The engine's registry of what was forgotten (`<dirname of the store>/_tombstones`): not part of any backup.
    w("state/_tombstones/bernd.jsonl", TOMBSTONE_LINE);
    w("agents/bernd/persona.md", "old persona");
    w("agents/anna/persona.md", "created after the backup");
    w("state/journal/bernd.jsonl", "old journal");
    w("run/core.token", "SECRET-TOKEN");
    w("logs/supervisor.log", "log line");
    w("models/m.bin", "model");
    // A previously used home has permanent writer lock files. Include their actual
    // bytes in the unchanged rollback/refusal assertions, including the Core holder row.
    w("run/supervisor.lock", "supervisor-lock-inode");
    w("run/engine.process.lock", "engine-lock-inode");
    let db = rusqlite::Connection::open(home.join("state/core.lock")).unwrap();
    db.execute_batch("CREATE TABLE IF NOT EXISTS holder(pid INTEGER, instance TEXT, at INTEGER); DELETE FROM holder; INSERT INTO holder VALUES (1, 'previous-core', 42);")
        .unwrap();
}

/// Every file (content) and directory below `root`, relative.
fn tree(root: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
    fn go(base: &Path, dir: &Path, out: &mut BTreeMap<String, Option<Vec<u8>>>) {
        for e in fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            let rel = e
                .path()
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if e.file_type().unwrap().is_dir() {
                out.insert(rel, None);
                go(base, &e.path(), out);
            } else if e.file_type().unwrap().is_file() {
                // A file a live supervisor holds locked (Windows) cannot be read and is not state either.
                if let Ok(b) = fs::read(e.path()) {
                    out.insert(rel, Some(b));
                }
            } // sockets (a supervisor's run/ files) are not state
        }
    }
    let mut m = BTreeMap::new();
    go(root, root, &mut m);
    m
}

fn doc(out: &std::process::Output) -> Value {
    serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("not json ({e}): {}", String::from_utf8_lossy(&out.stdout)))
}

fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let archive = d.path().join("b.tar.gz");
    (d, home, archive)
}

#[test]
fn verify_accepts_a_good_archive() {
    let (_d, home, a) = setup();
    build(&a, &fixture());
    let out = cli(&home)
        .args(["backup", "verify"])
        .arg(&a)
        .assert()
        .success()
        .get_output()
        .clone();
    let v = doc(&out);
    assert_eq!(v["schema"], "backup.verify/1");
    assert_eq!(v["files"], 4);
    assert_eq!(v["secrets"]["included"], false);
}

/// Archives a restore must refuse, each with its reason: verify and restore agree, and restore changes nothing.
/// (expected reason, what is wrong with it, how to build it)
type Refusal = (&'static str, &'static str, Box<dyn Fn(&Path)>);

fn refused() -> Vec<Refusal> {
    vec![
        (
            "checksum-mismatch",
            "a manifest digest that does not match the data",
            Box::new(|a: &Path| {
                let mut f = fixture();
                f.manifest["files"][0]["sha256"] = json!(sha(b"something else"));
                build(a, &f);
            }),
        ),
        (
            "checksum-mismatch",
            "data changed after the manifest was written",
            Box::new(|a: &Path| {
                let mut f = fixture();
                f.files[1].1 = b"{\"restored\":false}".to_vec();
                build(a, &f);
            }),
        ),
        (
            "unexpected-entry",
            "an entry the manifest does not list",
            Box::new(|a: &Path| {
                let f = fixture();
                let mut e = vec![(
                    "manifest.json".to_string(),
                    serde_json::to_vec(&f.manifest).unwrap(),
                )];
                e.extend(
                    f.files
                        .iter()
                        .map(|(p, b)| (format!("data/{p}"), b.clone())),
                );
                e.push(("data/run/core.token".into(), b"x".to_vec()));
                write_tar(a, &e);
            }),
        ),
        (
            "unexpected-entry",
            "a path that climbs out",
            Box::new(|a: &Path| {
                let f = fixture();
                let mut e = vec![(
                    "manifest.json".to_string(),
                    serde_json::to_vec(&f.manifest).unwrap(),
                )];
                e.extend(
                    f.files
                        .iter()
                        .map(|(p, b)| (format!("data/{p}"), b.clone())),
                );
                e.push(("data/../../escape".into(), b"x".to_vec()));
                write_tar(a, &e);
            }),
        ),
        (
            "missing-entry",
            "a listed file that is not there",
            Box::new(|a: &Path| {
                let f = fixture();
                let mut e = vec![(
                    "manifest.json".to_string(),
                    serde_json::to_vec(&f.manifest).unwrap(),
                )];
                e.extend(
                    f.files
                        .iter()
                        .skip(1)
                        .map(|(p, b)| (format!("data/{p}"), b.clone())),
                );
                write_tar(a, &e);
            }),
        ),
        (
            "manifest-invalid",
            "a unit that targets run/",
            Box::new(|a: &Path| {
                let mut f = fixture();
                f.manifest["units"][1] = json!({ "archive": "run/core.token", "target": "run/core.token", "kind": "file" });
                build(a, &f);
            }),
        ),
        (
            "manifest-invalid",
            "a manifest that claims secrets are included",
            Box::new(|a: &Path| {
                let mut f = fixture();
                f.manifest["secrets"]["included"] = json!(true);
                build(a, &f);
            }),
        ),
        (
            "manifest-invalid",
            "a store target outside the allow-list",
            Box::new(|a: &Path| {
                let mut f = fixture();
                f.manifest["storeTarget"] = json!("../outside");
                build(a, &f);
            }),
        ),
        (
            "manifest-invalid",
            "a store that is the tombstone registry (it would bring every forgotten memory back)",
            Box::new(|a: &Path| {
                let mut f = fixture();
                f.manifest["storeTarget"] = json!("state/_tombstones");
                f.manifest["units"][0]["target"] = json!("state/_tombstones");
                build(a, &f);
            }),
        ),
        (
            "unsupported-format",
            "a newer archive format",
            Box::new(|a: &Path| {
                let mut f = fixture();
                f.manifest["schema"] = json!("plur1bus.backup/2");
                build(a, &f);
            }),
        ),
        (
            "archive-corrupt",
            "something that is not an archive",
            Box::new(|a: &Path| fs::write(a, b"not an archive at all").unwrap()),
        ),
        (
            "truncated",
            "an archive cut in the middle",
            Box::new(|a: &Path| {
                build(a, &fixture());
                let b = fs::read(a).unwrap();
                fs::write(a, &b[..b.len() - 40]).unwrap();
            }),
        ),
    ]
}

#[test]
fn a_corrupt_archive_is_refused_by_verify_and_by_restore_and_nothing_changes() {
    for (reason, what, make) in refused() {
        let (_d, home, a) = setup();
        old_home(&home);
        make(&a);
        let before = tree(&home);
        let v = cli(&home)
            .args(["backup", "verify"])
            .arg(&a)
            .assert()
            .failure()
            .code(2)
            .get_output()
            .clone();
        let e = doc(&v);
        let got = e["reason"].as_str().unwrap();
        // A cut archive may be reported as `truncated` or as the gzip layer's `archive-corrupt`.
        assert!(
            got == reason || (reason == "truncated" && got == "archive-corrupt"),
            "{what}: {e}"
        );
        assert_eq!(e["schema"], "error/1");
        let r = cli(&home)
            .args(["backup", "restore", "--yes"])
            .arg(&a)
            .assert()
            .failure()
            .code(2)
            .get_output()
            .clone();
        assert_eq!(doc(&r)["reason"], e["reason"], "{what}");
        assert_eq!(
            tree(&home),
            before,
            "{what}: a refused restore must change nothing"
        );
    }
}

#[test]
fn a_dry_run_reports_the_plan_and_changes_nothing() {
    let (_d, home, a) = setup();
    old_home(&home);
    build(&a, &fixture());
    let before = tree(&home);
    let out = cli(&home)
        .args(["backup", "restore", "--dry-run"])
        .arg(&a)
        .assert()
        .success()
        .get_output()
        .clone();
    let v = doc(&out);
    assert_eq!(v["schema"], "backup.restore/1");
    assert_eq!(
        (v["dryRun"].clone(), v["applied"].clone()),
        (json!(true), json!(false))
    );
    let actions: Vec<(String, String)> = v["units"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| {
            (
                u["target"].as_str().unwrap().into(),
                u["action"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(actions[0], ("state/lancedb".into(), "replace".into()));
    assert_eq!(v["removed"], json!(["state/memory/run-state.json"]));
    assert_eq!(tree(&home), before);
}

#[test]
fn an_archive_omitting_accounts_leaves_the_database_sidecars_and_api_sibling_untouched() {
    let (_d, home, archive) = setup();
    old_home(&home);
    let accounts = account_state(&home);
    build(&archive, &fixture());
    let before = tree(&home);
    let dry = cli(&home)
        .args(["backup", "restore", "--dry-run"])
        .arg(&archive)
        .assert()
        .success()
        .get_output()
        .clone();
    let plan = doc(&dry);
    assert!(plan["units"]
        .as_array()
        .unwrap()
        .iter()
        .all(|unit| !unit["target"].as_str().unwrap().starts_with("state/api/")));
    assert!(plan["removed"]
        .as_array()
        .unwrap()
        .iter()
        .all(|target| !target.as_str().unwrap().starts_with("state/api/")));
    assert_eq!(tree(&home), before, "dry-run must change no byte");
    let applied = cli(&home)
        .args(["backup", "restore", "--yes"])
        .arg(&archive)
        .assert()
        .success()
        .get_output()
        .clone();
    assert_account_state(&home, &accounts);
    let pre = PathBuf::from(doc(&applied)["preRestore"].as_str().unwrap());
    assert!(
        !pre.join("state/api").exists(),
        "omitted accounts are not displaced"
    );
}

#[test]
fn an_account_unit_in_an_existing_archive_restores_without_a_new_restore_option() {
    let (_d, home, archive) = setup();
    old_home(&home);
    let old = account_state(&home);
    let incoming = Uuid::new_v4().to_string().into_bytes();
    let mut f = fixture();
    add_account_unit(&mut f, &incoming);
    build(&archive, &f);
    cli(&home)
        .args(["backup", "verify"])
        .arg(&archive)
        .assert()
        .success();
    let output = cli(&home)
        .args(["backup", "restore", "--yes"])
        .arg(&archive)
        .assert()
        .success()
        .get_output()
        .clone();
    assert_eq!(
        fs::read(home.join("state/api/accounts.db")).unwrap(),
        incoming
    );
    let pre = PathBuf::from(doc(&output)["preRestore"].as_str().unwrap());
    for (relative, bytes) in old {
        if relative.ends_with("unrelated-api-state.json") {
            assert_eq!(fs::read(home.join(&relative)).unwrap(), bytes);
            assert!(!pre.join(relative).exists());
        } else {
            assert_eq!(fs::read(pre.join(&relative)).unwrap(), bytes, "{relative}");
            if relative != "state/api/accounts.db" {
                assert!(
                    !home.join(relative).exists(),
                    "old sidecars cannot accompany a new DB"
                );
            }
        }
    }
}

#[test]
fn failed_account_unit_placement_restores_old_database_sidecars_and_api_sibling() {
    for phase in ["swap", "swap-after"] {
        let (_d, home, archive) = setup();
        old_home(&home);
        let old = account_state(&home);
        let mut f = fixture();
        let account_index = add_account_unit(&mut f, Uuid::new_v4().as_bytes());
        build(&archive, &f);
        let before = tree(&home);
        let at = format!("{phase}:{account_index}");
        let output = cli(&home)
            .env("PLUR1BUS_TEST_BACKUP_FAIL_AT", &at)
            .args(["backup", "restore", "--yes"])
            .arg(&archive)
            .assert()
            .failure()
            .code(1)
            .get_output()
            .clone();
        assert_eq!(doc(&output)["reason"], "restore-failed", "{at}");
        assert_account_state(&home, &old);
        let after = tree(&home);
        let without_backups = after
            .iter()
            .filter(|(path, _)| !path.starts_with("backups"))
            .map(|(path, bytes)| (path.clone(), bytes.clone()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            without_backups, before,
            "{at}: rollback must restore every old byte"
        );
        assert!(!after
            .keys()
            .any(|path| path.contains(".restore-") || path.contains("pre-restore")));
    }
}

#[test]
fn restore_reports_replaced_config_keys_on_stderr_without_changing_json_shape() {
    let (_d, home, archive) = setup();
    let mut f = fixture();
    f.manifest["secrets"]["note"] = json!(
        "no secret-store values\nplur1bus.backup.config-redactions/1: [\"engine.embedding.apiKey\",\"engine.reranker.baseUrl\",\"modules.fixture.ordinary\"]"
    );
    build(&archive, &f);
    for mode in ["--dry-run", "--yes"] {
        let out = cli(&home)
            .args(["backup", "restore", mode])
            .arg(&archive)
            .assert()
            .success()
            .get_output()
            .clone();
        let notice = String::from_utf8(out.stderr.clone()).unwrap();
        assert!(
            notice.contains("Re-enter secret"),
            "restore omitted the required action"
        );
        assert!(notice.contains("engine.embedding.apiKey"));
        assert!(notice.contains("engine.reranker.baseUrl"));
        assert!(notice.contains("modules.fixture.ordinary"));
        let value = doc(&out);
        let mut keys = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "applied",
                "archive",
                "archiveHarness",
                "createdAtMs",
                "currentHarness",
                "dryRun",
                "preRestore",
                "removed",
                "schema",
                "storeSchema",
                "units"
            ],
            "the JSON result shape must stay unchanged"
        );
    }
}

#[test]
fn restore_defaults_to_a_read_only_plan_and_force_never_confirms_it() {
    let (_d, home, a) = setup();
    old_home(&home);
    build(&a, &fixture());
    let before = tree(&home);
    for flags in [
        vec![],
        vec!["--force"],
        vec!["--confirm", "--dry-run"],
        vec!["--force", "--dry-run"],
    ] {
        let out = cli(&home)
            .args(["backup", "restore"])
            .args(&flags)
            .arg(&a)
            .assert()
            .success()
            .get_output()
            .clone();
        assert_eq!(doc(&out)["applied"], false);
        assert_eq!(doc(&out)["dryRun"], true);
        assert_eq!(tree(&home), before, "{flags:?}");
        if flags.contains(&"--force") {
            assert!(String::from_utf8_lossy(&out.stderr).contains("does not confirm"));
        }
    }
}

#[test]
fn a_restore_swaps_the_units_keeps_what_it_replaced_and_leaves_everything_else_alone() {
    let (_d, home, a) = setup();
    old_home(&home);
    build(&a, &fixture());
    let before = tree(&home);
    let out = cli(&home)
        .args(["backup", "restore", "--confirm"])
        .arg(&a)
        .assert()
        .success()
        .get_output()
        .clone();
    let v = doc(&out);
    assert_eq!(v["applied"], true);
    let read = |p: &str| fs::read_to_string(home.join(p)).unwrap();
    assert_eq!(read("config.json"), "{\"restored\":true}");
    assert_eq!(read("state/lancedb/table.lance"), "restored-store");
    assert!(
        !home.join("state/lancedb/extra-new-table").exists(),
        "the store is the backup's, not a merge"
    );
    assert_eq!(read("agents/bernd/persona.md"), "restored persona");
    assert!(
        !home.join("agents/anna").exists(),
        "an agent created after the backup is gone from the live tree"
    );
    assert!(
        home.join("agents/bernd/workspace").is_dir(),
        "empty directories survive"
    );
    assert_eq!(read("state/journal/bernd.jsonl"), "{\"v\":1}\n");
    assert!(
        !home.join("state/memory/run-state.json").exists(),
        "a unit absent at backup time is removed"
    );
    // Not units: untouched.
    for p in ["run/core.token", "logs/supervisor.log", "models/m.bin"] {
        assert_eq!(
            read(p),
            before[p]
                .clone()
                .map(|b| String::from_utf8(b).unwrap())
                .unwrap(),
            "{p}"
        );
    }
    // What was replaced is kept whole under backups/pre-restore-<id>/.
    let pre = PathBuf::from(v["preRestore"].as_str().unwrap());
    assert!(pre.starts_with(home.join("backups")), "{pre:?}");
    let kept = tree(&pre);
    for (p, c) in &before {
        let unit = [
            "config.json",
            "state/lancedb",
            "agents",
            "state/journal",
            "state/memory/run-state.json",
        ]
        .iter()
        .any(|u| p == u || p.starts_with(&format!("{u}/")));
        if unit && c.is_some() {
            assert_eq!(
                kept.get(p),
                Some(c),
                "{p} should be in the pre-restore tree"
            );
        }
    }
    assert!(
        !tree(&home).keys().any(|k| k.starts_with(".restore-")),
        "staging is cleaned up"
    );
    // Recorded in the audit log.
    let audit = fs::read_to_string(home.join("logs/audit.log")).unwrap();
    assert!(audit.contains("\"backup.restore\""), "{audit}");
}

#[test]
fn a_restore_keeps_the_tombstone_registry_and_leaves_a_marker_for_the_next_core_start() {
    let (_d, home, a) = setup();
    old_home(&home);
    build(&a, &fixture());
    let out = cli(&home)
        .args(["backup", "restore", "--yes"])
        .arg(&a)
        .assert()
        .success()
        .get_output()
        .clone();
    let v = doc(&out);
    // The registry is the record of what was forgotten: the restore neither replaces nor moves it.
    assert_eq!(
        fs::read_to_string(home.join("state/_tombstones/bernd.jsonl")).unwrap(),
        TOMBSTONE_LINE
    );
    let pre = PathBuf::from(v["preRestore"].as_str().unwrap());
    assert!(!pre.join("state/_tombstones").exists());
    // The restored rows are the backup's: the next core start re-applies the committed tombstones to them first.
    let marker: Value =
        serde_json::from_slice(&fs::read(home.join("state/.restore-reapply-tombstones")).unwrap())
            .unwrap();
    assert_eq!(marker["schema"], "plur1bus.restore-reapply-tombstones/1");
    assert!(marker["restoredAtMs"].as_u64().unwrap() > 0, "{marker}");
    assert!(
        !pre.join("state/.restore-reapply-tombstones").exists(),
        "the marker belongs to the restored state, not to the displaced one"
    );
}

#[cfg(unix)]
#[test]
fn restored_files_and_directories_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let (_d, home, a) = setup();
    build(&a, &fixture());
    cli(&home)
        .args(["backup", "restore", "--yes"])
        .arg(&a)
        .assert()
        .success();
    for p in [
        "config.json",
        "state/lancedb/table.lance",
        "agents/bernd/persona.md",
    ] {
        assert_eq!(
            fs::metadata(home.join(p)).unwrap().permissions().mode() & 0o077,
            0,
            "{p}"
        );
    }
    for p in ["agents", "agents/bernd", "state/lancedb"] {
        assert_eq!(
            fs::metadata(home.join(p)).unwrap().permissions().mode() & 0o077,
            0,
            "{p}"
        );
    }
}

#[test]
fn a_failed_restore_leaves_the_old_state_byte_identical_at_every_step() {
    for at in [
        "extract",
        "swap:0",
        "swap-after:0",
        "swap:2",
        "swap-after:2",
        "swap-after:3",
    ] {
        let (_d, home, a) = setup();
        old_home(&home);
        build(&a, &fixture());
        let before = tree(&home);
        let out = cli(&home)
            .env("PLUR1BUS_TEST_BACKUP_FAIL_AT", at)
            .args(["backup", "restore", "--yes"])
            .arg(&a)
            .assert()
            .failure()
            .code(1)
            .get_output()
            .clone();
        let e = doc(&out);
        assert_eq!(e["reason"], "restore-failed", "{at}: {e}");
        if at != "extract" {
            assert!(
                e["message"].as_str().unwrap().contains("put back"),
                "{at}: {e}"
            );
        }
        let after = tree(&home);
        // Only the (empty) backups/ directory this attempt created may differ.
        let strip: BTreeMap<_, _> = after
            .iter()
            .filter(|(k, _)| !k.starts_with("backups"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        assert_eq!(
            strip, before,
            "{at}: the old state must be exactly as it was"
        );
        assert!(
            !after
                .keys()
                .any(|k| k.contains(".restore-") || k.contains("pre-restore")),
            "{at}: no staging or pre-restore leftovers: {:?}",
            after.keys().collect::<Vec<_>>()
        );
    }
}

#[test]
fn restore_refuses_while_a_supervisor_answers_for_the_home() {
    let (_d, home, a) = setup();
    old_home(&home);
    // `supervise --no-core` writes its own run files; keep ours out of the comparison.
    let sup = common::start(&home);
    build(&a, &fixture());
    let before: BTreeMap<_, _> = tree(&home)
        .into_iter()
        .filter(|(k, _)| k.starts_with("agents") || k.starts_with("state") || k == "config.json")
        .collect();
    let out = cli(&home)
        .args(["backup", "restore", "--yes"])
        .arg(&a)
        .assert()
        .failure()
        .code(3)
        .get_output()
        .clone();
    let e = doc(&out);
    assert_eq!(e["error"], "E_LOCKED");
    assert_eq!(e["reason"], "core-running");
    let forced = cli(&home)
        .args(["backup", "restore", "--confirm", "--force"])
        .arg(&a)
        .assert()
        .failure()
        .code(3)
        .get_output()
        .clone();
    assert_eq!(doc(&forced)["reason"], "core-running");
    assert!(String::from_utf8_lossy(&forced.stderr).contains("WARNING: --force"));
    let after: BTreeMap<_, _> = tree(&home)
        .into_iter()
        .filter(|(k, _)| k.starts_with("agents") || k.starts_with("state") || k == "config.json")
        .collect();
    drop(sup);
    // The supervisor's own state/ files may have appeared; the units the restore would replace are what matter.
    for (k, v) in &before {
        assert_eq!(after.get(k), Some(v), "{k}");
    }
}

/// P4-10 security review M3: a front door that died abruptly leaves its legacy core stopping, answering on no address the
/// probes know (`run/core.sock` is the dead front door's) but holding `run/core-legacy.lock` while it still writes the
/// stores. A restore must not swap the units under it.
#[test]
fn restore_refuses_while_a_legacy_core_still_holds_its_lock() {
    let (_d, home, a) = setup();
    old_home(&home);
    fs::create_dir_all(home.join("run")).unwrap();
    build(&a, &fixture());
    // The legacy core's lock as module-api takes it (node:sqlite, BEGIN EXCLUSIVE).
    let script = r#"const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS holder(pid INTEGER); BEGIN EXCLUSIVE");
globalThis.held = db; process.stdout.write("locked\n"); setInterval(() => {}, 1000);"#;
    struct Holder(std::process::Child);
    impl Drop for Holder {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut holder = Holder(
        std::process::Command::new("node")
            .args(["-e", script])
            .arg(home.join("run/core-legacy.lock"))
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(holder.0.stdout.take().unwrap()),
        &mut line,
    )
    .unwrap();
    assert_eq!(line.trim(), "locked");
    let units = |home: &Path| -> BTreeMap<_, _> {
        tree(home)
            .into_iter()
            .filter(|(k, _)| {
                k.starts_with("agents") || k.starts_with("state") || k == "config.json"
            })
            .collect()
    };
    let before = units(&home);
    let out = cli(&home)
        .args(["backup", "restore", "--yes"])
        .arg(&a)
        .assert()
        .failure()
        .code(3)
        .get_output()
        .clone();
    let e = doc(&out);
    assert_eq!(e["error"], "E_LOCKED");
    assert_eq!(e["reason"], "core-running");
    assert_eq!(units(&home), before, "nothing was swapped");
    drop(holder);
    cli(&home)
        .args(["backup", "restore", "--yes"])
        .arg(&a)
        .assert()
        .success();
}

#[test]
fn create_without_a_core_fails_closed_and_dry_run_writes_nothing() {
    let (_d, home, _a) = setup();
    old_home(&home);
    let before = tree(&home);
    let out = cli(&home)
        .args(["backup", "create"])
        .assert()
        .failure()
        .code(1)
        .get_output()
        .clone();
    assert_eq!(doc(&out)["error"], "E_CORE_UNAVAILABLE");
    let dry = cli(&home)
        .args(["backup", "create", "--dry-run"])
        .assert()
        .success()
        .get_output()
        .clone();
    let v = doc(&dry);
    assert_eq!(v["dryRun"], true);
    assert!(v["plain"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p == "config.json"));
    assert_eq!(tree(&home), before, "no backups/ directory, no archive");
}

#[test]
fn api_account_inclusion_is_only_a_backup_create_option() {
    let (_d, home, archive) = setup();
    let create_help = cli(&home)
        .args(["backup", "create", "--help"])
        .assert()
        .success()
        .get_output()
        .clone();
    let help = String::from_utf8(create_help.stdout)
        .unwrap()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(help.contains("--include-api-accounts"));
    assert!(help.contains("password hashes"));
    let before = tree(&home);
    for command in ["verify", "restore"] {
        let help = cli(&home)
            .args(["backup", command, "--help"])
            .assert()
            .success()
            .get_output()
            .clone();
        assert!(!String::from_utf8(help.stdout)
            .unwrap()
            .contains("--include-api-accounts"));
        cli(&home)
            .args(["backup", command, "--include-api-accounts"])
            .arg(&archive)
            .assert()
            .failure()
            .code(2);
    }
    let uninstall = cli(&home)
        .args(["uninstall", "--help"])
        .assert()
        .success()
        .get_output()
        .clone();
    assert!(!String::from_utf8(uninstall.stdout)
        .unwrap()
        .contains("--include-api-accounts"));
    cli(&home)
        .args(["uninstall", "--include-api-accounts"])
        .assert()
        .failure()
        .code(2);
    assert_eq!(tree(&home), before);
}

#[test]
fn account_policy_is_disclosed_in_existing_dry_run_fields_without_core_or_writes() {
    let (_d, home, archive) = setup();
    old_home(&home);
    let accounts = account_state(&home);
    let before = tree(&home);
    let mut notes = Vec::new();
    for include in [false, true] {
        let mut command = cli(&home);
        command
            .args(["backup", "create", "--dry-run", "--out"])
            .arg(&archive);
        if include {
            command.arg("--include-api-accounts");
        }
        let output = command.assert().success().get_output().clone();
        let value = doc(&output);
        let mut keys = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["dryRun", "path", "plain", "schema", "secrets", "staged"]
        );
        assert_eq!(value["schema"], "backup.create/1");
        assert_eq!(value["dryRun"], true);
        assert_eq!(value["secrets"]["included"], false);
        let mut secret_keys = value["secrets"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        secret_keys.sort_unstable();
        assert_eq!(secret_keys, ["included", "note"]);
        let note = value["secrets"]["note"].as_str().unwrap();
        assert!(
            !note.contains("plur1bus.backup.config-redactions/"),
            "dry-run has collected no config-redaction snapshot metadata"
        );
        assert!(note.contains("state/api/accounts.db"));
        assert!(note.contains("password hashes") && note.contains("TOTP seeds"));
        assert!(note.contains("token hashes") && note.contains("neither signed nor encrypted"));
        if include {
            assert!(
                note.contains("explicitly included"),
                "the selected inclusion must be disclosed"
            );
        } else {
            assert!(
                note.contains("excluded by default"),
                "default exclusion must be disclosed"
            );
        }
        notes.push(note.to_owned());
        assert_no_account_values(&output, &accounts);
        let mut human = Command::cargo_bin("plur1bus").unwrap();
        human
            .arg("--home")
            .arg(&home)
            .args(["backup", "create", "--dry-run", "--out"])
            .arg(&archive)
            .timeout(std::time::Duration::from_secs(60));
        if include {
            human.arg("--include-api-accounts");
        }
        let human_output = human.assert().success().get_output().clone();
        assert!(String::from_utf8_lossy(&human_output.stdout).contains(note));
        assert!(
            !String::from_utf8_lossy(&human_output.stdout)
                .contains("plur1bus.backup.config-redactions/"),
            "human dry-run must not invent config-redaction snapshot metadata"
        );
        assert_no_account_values(&human_output, &accounts);
        assert_eq!(
            tree(&home),
            before,
            "dry-run must not make a snapshot or archive"
        );
        assert!(!archive.exists());
    }
    assert_ne!(
        notes[0], notes[1],
        "the selected account policy must change the note"
    );
}

#[test]
fn create_never_overwrites_an_existing_file() {
    let (_d, home, a) = setup();
    fs::write(&a, "precious").unwrap();
    let out = cli(&home)
        .args(["backup", "create", "--out"])
        .arg(&a)
        .assert()
        .failure()
        .code(1)
        .get_output()
        .clone();
    assert_eq!(doc(&out)["error"], "E_CONFLICT");
    assert_eq!(fs::read_to_string(&a).unwrap(), "precious");
}

// ---------------------------------------------------------------------------------------------------------------------
// RX4 / RE-D171: `backup restore --keep N` (bounded pre-restore retention)
// ---------------------------------------------------------------------------------------------------------------------

const OLD_PRE: [&str; 4] = [
    "pre-restore-20200101T000000Z-aaaaaaa1",
    "pre-restore-20200102T000000Z-aaaaaaa2",
    "pre-restore-20200103T000000Z-aaaaaaa3",
    "pre-restore-20200104T000000Z-aaaaaaa4",
];
const MARKER: &str = "state/.restore-reapply-tombstones";

fn plant_pre_in(backups: &Path, name: &str) {
    let d = backups.join(name);
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("old-state"), name).unwrap();
}

fn plant_pre(home: &Path, name: &str) {
    plant_pre_in(&home.join("backups"), name);
}

fn plant_old_copies(home: &Path) {
    for n in OLD_PRE {
        plant_pre(home, n);
    }
}

fn backups_entries(home: &Path) -> Vec<String> {
    let mut v: Vec<String> = match fs::read_dir(home.join("backups")) {
        Ok(rd) => rd
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    };
    v.sort();
    v
}

/// The `pre-restore-*` directory the restore under test created: not one of the planted names.
fn fresh_copy(home: &Path, planted: &[&str]) -> String {
    let fresh: Vec<String> = backups_entries(home)
        .into_iter()
        .filter(|n| n.starts_with("pre-restore-") && !planted.contains(&n.as_str()))
        .collect();
    assert_eq!(fresh.len(), 1, "exactly one fresh copy: {fresh:?}");
    fresh[0].clone()
}

fn restore_with(home: &Path, archive: &Path, extra: &[&str]) -> std::process::Output {
    cli(home)
        .args(["backup", "restore", "--yes"])
        .args(extra)
        .arg(archive)
        .assert()
        .success()
        .get_output()
        .clone()
}

#[test]
fn without_keep_every_pre_restore_copy_stays() {
    let (_d, home, a) = setup();
    old_home(&home);
    plant_old_copies(&home);
    build(&a, &fixture());
    restore_with(&home, &a, &[]);
    let fresh = fresh_copy(&home, &OLD_PRE);
    let mut want: Vec<String> = OLD_PRE.iter().map(|s| s.to_string()).collect();
    want.push(fresh);
    want.sort();
    assert_eq!(backups_entries(&home), want);
}

#[test]
fn keep_1_keeps_only_the_fresh_copy_and_keep_2_adds_the_newest_older_one() {
    for (keep, survivors) in [("1", 0usize), ("2", 1)] {
        let (_d, home, a) = setup();
        old_home(&home);
        plant_old_copies(&home);
        build(&a, &fixture());
        let out = restore_with(&home, &a, &["--keep", keep]);
        assert_eq!(doc(&out)["applied"], true);
        let fresh = fresh_copy(&home, &OLD_PRE);
        let mut want: Vec<String> = OLD_PRE[OLD_PRE.len() - survivors..]
            .iter()
            .map(|s| s.to_string())
            .collect();
        want.push(fresh.clone());
        want.sort();
        assert_eq!(backups_entries(&home), want, "--keep {keep}");
        // The fresh copy is whole: it holds what the restore replaced.
        assert_eq!(
            fs::read_to_string(home.join("backups").join(&fresh).join("config.json")).unwrap(),
            "{\"old\":true}"
        );
        assert!(
            !String::from_utf8_lossy(&out.stderr).contains("--keep"),
            "no warning when the retention ran: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

#[test]
fn the_fresh_copy_counts_and_is_never_deleted_even_when_its_stamp_is_not_the_newest() {
    // A copy stamped in the future (clock skew): the fresh copy still counts as one of the N and survives.
    let future = "pre-restore-29990101T000000Z-fffffff1";
    for (keep, future_stays) in [("1", false), ("2", true)] {
        let (_d, home, a) = setup();
        old_home(&home);
        plant_pre(&home, future);
        plant_pre(&home, OLD_PRE[0]);
        build(&a, &fixture());
        restore_with(&home, &a, &["--keep", keep]);
        let planted = [future, OLD_PRE[0]];
        let fresh = fresh_copy(&home, &planted);
        assert!(home.join("backups").join(&fresh).is_dir(), "--keep {keep}");
        assert_eq!(
            home.join("backups").join(future).exists(),
            future_stays,
            "--keep {keep}"
        );
        assert!(!home.join("backups").join(OLD_PRE[0]).exists());
    }
}

#[test]
fn a_marker_from_an_unfinished_restore_blocks_the_purge_and_warns() {
    let (_d, home, a) = setup();
    old_home(&home);
    plant_old_copies(&home);
    let marker = home.join(MARKER);
    fs::create_dir_all(marker.parent().unwrap()).unwrap();
    fs::write(
        &marker,
        b"{\"schema\":\"plur1bus.restore-reapply-tombstones/1\",\"restoredAtMs\":1}",
    )
    .unwrap();
    build(&a, &fixture());
    let out = restore_with(&home, &a, &["--keep", "1"]);
    assert_eq!(doc(&out)["applied"], true);
    let fresh = fresh_copy(&home, &OLD_PRE);
    for n in OLD_PRE {
        assert!(home.join("backups").join(n).is_dir(), "{n} must stay");
    }
    assert!(home.join("backups").join(fresh).is_dir());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("--keep") && err.contains("re-apply"),
        "warning on stderr: {err}"
    );
    assert!(marker.exists(), "the earlier marker stays");
}

#[cfg(unix)]
#[test]
fn keep_never_touches_symlinks_files_archives_or_foreign_names() {
    let (d, home, a) = setup();
    old_home(&home);
    build(&a, &fixture());
    let outside = d.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("precious"), "do not delete").unwrap();
    let backups = home.join("backups");
    fs::create_dir_all(&backups).unwrap();
    let link = "pre-restore-20200101T000000Z-aaaaaaa1";
    std::os::unix::fs::symlink(&outside, backups.join(link)).unwrap();
    let file = "pre-restore-20200102T000000Z-aaaaaaa2";
    fs::write(backups.join(file), "a file with a matching name").unwrap();
    let archive_name = "plur1bus-backup-20200101T000000Z.tar.gz";
    fs::write(backups.join(archive_name), "an archive").unwrap();
    let foreign_dirs = [
        "pre-restore-manual",
        "pre-restore-20200103T000000Z-zzzzzzzz",
        "pre-restore-20200103T000000Z-aaaaaaa3-extra",
        "Pre-Restore-20200103T000000Z-aaaaaaa4",
        "pre-restore-20200103T000000-aaaaaaa5",
        "pre-restore-20200103T000000Z-AAAAAAA6",
    ];
    for n in foreign_dirs {
        plant_pre(&home, n);
    }
    let real = [
        "pre-restore-20200104T000000Z-bbbbbbb1",
        "pre-restore-20200105T000000Z-bbbbbbb2",
    ];
    for n in real {
        plant_pre(&home, n);
    }
    restore_with(&home, &a, &["--keep", "1"]);
    for n in real {
        assert!(!backups.join(n).exists(), "{n} is a candidate and goes");
    }
    assert!(backups
        .join(link)
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read_to_string(outside.join("precious")).unwrap(),
        "do not delete"
    );
    assert!(backups.join(file).is_file());
    assert!(backups.join(archive_name).is_file());
    for n in foreign_dirs {
        assert!(backups.join(n).is_dir(), "{n} is not a candidate");
        assert_eq!(
            fs::read_to_string(backups.join(n).join("old-state")).unwrap(),
            n
        );
    }
}

#[test]
fn an_invalid_keep_fails_before_any_change() {
    for bad in [
        "0",
        "x",
        "-1",
        "1.5",
        "",
        "1000000000",
        "18446744073709551616",
    ] {
        let (_d, home, a) = setup();
        old_home(&home);
        plant_old_copies(&home);
        build(&a, &fixture());
        let before = tree(&home);
        let out = cli(&home)
            .args(["backup", "restore", "--yes", "--keep", bad])
            .arg(&a)
            .assert()
            .failure()
            .get_output()
            .clone();
        assert_eq!(out.status.code(), Some(2), "--keep {bad:?}");
        assert_eq!(tree(&home), before, "--keep {bad:?} must change nothing");
    }
}

#[test]
fn the_largest_accepted_keep_keeps_everything() {
    let (_d, home, a) = setup();
    old_home(&home);
    plant_old_copies(&home);
    build(&a, &fixture());
    restore_with(&home, &a, &["--keep", "999999999"]);
    let fresh = fresh_copy(&home, &OLD_PRE);
    let mut want: Vec<String> = OLD_PRE.iter().map(|s| s.to_string()).collect();
    want.push(fresh);
    want.sort();
    assert_eq!(backups_entries(&home), want);
}

#[test]
fn a_restore_that_replaces_nothing_makes_no_copy_and_keeps_the_n_newest_existing_ones() {
    let (_d, home, a) = setup(); // an empty home: every unit is `create`, nothing is moved aside
    plant_old_copies(&home);
    build(&a, &fixture());
    let out = restore_with(&home, &a, &["--keep", "2"]);
    let v = doc(&out);
    assert_eq!(v["applied"], true);
    assert!(v["preRestore"].is_null(), "{v}");
    assert_eq!(
        backups_entries(&home),
        vec![OLD_PRE[2].to_string(), OLD_PRE[3].to_string()]
    );
}

#[cfg(unix)]
#[test]
fn keep_deletes_nothing_through_a_backups_directory_that_is_a_symlink() {
    let (d, home, a) = setup();
    old_home(&home);
    build(&a, &fixture());
    // `backups/` moved to another disk, possibly shared with a second home.
    let shared = d.path().join("shared-backups");
    fs::create_dir_all(&shared).unwrap();
    for n in OLD_PRE {
        plant_pre_in(&shared, n);
    }
    std::os::unix::fs::symlink(&shared, home.join("backups")).unwrap();
    let out = restore_with(&home, &a, &["--keep", "1"]);
    assert_eq!(doc(&out)["applied"], true);
    let mut names: Vec<String> = fs::read_dir(&shared)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for n in OLD_PRE {
        assert!(names.iter().any(|x| x == n), "{n} must stay: {names:?}");
    }
    assert_eq!(
        names.len(),
        OLD_PRE.len() + 1,
        "plus the fresh copy: {names:?}"
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("--keep") && err.contains("symlink"), "{err}");
}

#[test]
fn dry_run_with_keep_deletes_nothing() {
    for extra in [&["--dry-run"][..], &["--dry-run", "--confirm"][..]] {
        let (_d, home, a) = setup();
        old_home(&home);
        plant_old_copies(&home);
        build(&a, &fixture());
        let before = tree(&home);
        cli(&home)
            .args(["backup", "restore", "--keep", "1"])
            .args(extra)
            .arg(&a)
            .assert()
            .success();
        assert_eq!(tree(&home), before, "{extra:?}");
    }
    // Without --confirm the default is a plan too.
    let (_d, home, a) = setup();
    old_home(&home);
    plant_old_copies(&home);
    build(&a, &fixture());
    let before = tree(&home);
    cli(&home)
        .args(["backup", "restore", "--keep", "1"])
        .arg(&a)
        .assert()
        .success();
    assert_eq!(tree(&home), before);
}

#[test]
fn a_failed_restore_with_keep_deletes_nothing() {
    for at in ["extract", "swap:0", "swap-after:0", "swap-after:3"] {
        let (_d, home, a) = setup();
        old_home(&home);
        plant_old_copies(&home);
        build(&a, &fixture());
        cli(&home)
            .env("PLUR1BUS_TEST_BACKUP_FAIL_AT", at)
            .args(["backup", "restore", "--yes", "--keep", "1"])
            .arg(&a)
            .assert()
            .failure()
            .code(1);
        let mut want: Vec<String> = OLD_PRE.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(backups_entries(&home), want, "{at}");
        assert!(
            !home.join(MARKER).exists(),
            "{at}: the roll-back removed the marker"
        );
    }
}

#[test]
fn keep_does_not_change_the_json_result() {
    let (_d, home_a, archive) = setup();
    old_home(&home_a);
    build(&archive, &fixture());
    let d2 = tempfile::tempdir().unwrap();
    let home_b = d2.path().join("home");
    fs::create_dir_all(&home_b).unwrap();
    old_home(&home_b);
    plant_old_copies(&home_b);
    let plain = restore_with(&home_a, &archive, &[]);
    let kept = restore_with(&home_b, &archive, &["--keep", "1"]);
    let (pa, pb) = (doc(&plain), doc(&kept));
    let (pre_a, pre_b) = (
        pa["preRestore"].as_str().unwrap().to_string(),
        pb["preRestore"].as_str().unwrap().to_string(),
    );
    let normalize = |stdout: Vec<u8>, pre: &str| {
        let stdout = String::from_utf8(stdout).unwrap();
        let pre = serde_json::to_string(pre).unwrap();
        assert_eq!(stdout.matches(&pre).count(), 1);
        stdout.replace(&pre, r#""<PRE>""#)
    };
    let ta = normalize(plain.stdout, &pre_a);
    let tb = normalize(kept.stdout, &pre_b);
    assert_eq!(
        ta, tb,
        "the JSON form is byte-identical with and without --keep"
    );
    let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(keys(&pa), keys(&pb));
}

// ---------------------------------------------------------------------------------------------------------------------
// gp5 cases 1 and 7: a refused admission changes nothing and leaves no staging or pre-restore tree
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn refused_admission_leaves_no_staging_no_pre_restore_and_the_current_cache() {
    let (_d, home, a) = setup();
    old_home(&home);
    let cache = home.join("state/lancedb/llm-result-cache-v1/current.db");
    fs::create_dir_all(cache.parent().unwrap()).unwrap();
    fs::write(&cache, b"current derived response").unwrap();
    build(&a, &fixture());
    let before = tree(&home);
    // A core holding `state/core.lock` (the kernel writer fence) in another process-visible way.
    let holder = rusqlite::Connection::open(home.join("state/core.lock")).unwrap();
    holder.busy_timeout(std::time::Duration::ZERO).unwrap();
    holder
        .execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;")
        .unwrap();
    let out = cli(&home)
        .args(["backup", "restore", "--yes", "--keep", "1"])
        .arg(&a)
        .assert()
        .failure()
        .code(3)
        .get_output()
        .clone();
    assert_eq!(doc(&out)["reason"], "core-running");
    let forced = cli(&home)
        .args(["backup", "restore", "--confirm", "--force"])
        .arg(&a)
        .assert()
        .failure()
        .code(3)
        .get_output()
        .clone();
    assert_eq!(doc(&forced)["reason"], "core-running");
    drop(holder);
    let after = tree(&home);
    assert_eq!(
        after, before,
        "a refused admission changes no byte of the home"
    );
    assert!(
        !after
            .keys()
            .any(|k| k.contains(".restore-") || k.contains("pre-restore")),
        "no staging and no pre-restore tree: {:?}",
        after.keys().collect::<Vec<_>>()
    );
    assert!(!after.contains_key("backups"));
    assert_eq!(fs::read(&cache).unwrap(), b"current derived response");
}

// ---------------------------------------------------------------------------------------------------------------------
// RX4 / RE-D171: SIGKILL cuts of a restore. There is no restore journal (ruling E8): a killed restore is not detected
// at the next start and not rolled back by itself. What holds, and is pinned here: no data is lost, the marker is
// there from the cut `marker` on, no lock outlives the process, and repeating the restore converges.
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_hold_seam_is_inert_without_the_test_internals_gate() {
    let root = tempfile::tempdir().unwrap();
    let archive = root.path().join("b.tar.gz");
    build(&archive, &fixture());
    let home = root.path().join("home");
    fs::create_dir_all(&home).unwrap();
    old_home(&home);
    let checkpoint = root.path().join("checkpoint");
    let out = cli(&home)
        .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS")
        .env("PLUR1BUS_TEST_BACKUP_FAIL_AT", "hold:marker")
        .env("PLUR1BUS_TEST_BACKUP_HOLD_FILE", &checkpoint)
        .args(["backup", "restore", "--yes"])
        .arg(&archive)
        .assert()
        .success()
        .get_output()
        .clone();
    assert_eq!(doc(&out)["applied"], true);
    assert!(!checkpoint.exists(), "no gate, no hold");
    // With the gate but without a checkpoint file there is nothing to wait for either.
    let home2 = root.path().join("home2");
    fs::create_dir_all(&home2).unwrap();
    old_home(&home2);
    let out = cli(&home2)
        .env("PLUR1BUS_TEST_BACKUP_FAIL_AT", "hold:marker")
        .args(["backup", "restore", "--yes"])
        .arg(&archive)
        .assert()
        .success()
        .get_output()
        .clone();
    assert_eq!(doc(&out)["applied"], true);
}

#[cfg(unix)]
mod crash {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Child, Stdio};
    use std::time::{Duration, Instant};

    /// Kills the child if a test ends (or panics) before it was killed on purpose.
    struct Held(Child);
    impl Drop for Held {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    type Snap = Option<BTreeMap<String, Option<Vec<u8>>>>;

    /// A file or directory tree (None: nothing there; a symlink is read as what it is, never followed).
    fn snap(p: &Path) -> Snap {
        let md = fs::symlink_metadata(p).ok()?;
        if md.is_dir() {
            let mut m = tree(p);
            m.insert(String::new(), None);
            Some(m)
        } else {
            let mut m = BTreeMap::new();
            m.insert(String::new(), Some(fs::read(p).unwrap()));
            Some(m)
        }
    }

    /// (archive path, target) of the fixture's units, in swap order.
    const UNITS: [(&str, &str); 4] = [
        ("store", "state/lancedb"),
        ("config.json", "config.json"),
        ("agents", "agents"),
        ("journal", "state/journal"),
    ];
    const ABSENT: &str = "state/memory/run-state.json";
    const OTHERS: [&str; 4] = [
        "run/core.token",
        "logs/supervisor.log",
        "models/m.bin",
        "state/_tombstones/bernd.jsonl",
    ];
    const DECOYS: [&str; 2] = [
        "pre-restore-20200101T000000Z-aaaaaaa1",
        "pre-restore-20200102T000000Z-aaaaaaa2",
    ];

    /// Spawns the real binary, restore parked at `at`, and returns it once it wrote its checkpoint.
    fn hold(home: &Path, archive: &Path, checkpoint: &Path, at: &str) -> Held {
        let child = std::process::Command::new(env!("CARGO_BIN_EXE_plur1bus"))
            .arg("--home")
            .arg(home)
            .args(["--json", "backup", "restore", "--yes"])
            .arg(archive)
            .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_TEST_BACKUP_FAIL_AT", format!("hold:{at}"))
            .env("PLUR1BUS_TEST_BACKUP_HOLD_FILE", checkpoint)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut held = Held(child);
        let start = Instant::now();
        loop {
            if checkpoint.exists() {
                return held;
            }
            if let Some(status) = held.0.try_wait().unwrap() {
                panic!("{at}: the restore exited ({status}) before it reached its hold point");
            }
            assert!(
                start.elapsed() < Duration::from_secs(30),
                "{at}: no checkpoint within 30 s"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn kill(mut held: Held, at: &str) {
        held.0.kill().unwrap();
        let status = held.0.wait().unwrap();
        assert_eq!(
            status.signal(),
            Some(9),
            "{at}: killed by SIGKILL, not exited"
        );
    }

    /// What the cut `at` looks like: (units placed, unit moved aside but not placed, absent unit moved, marker present).
    fn expectation(at: &str) -> (usize, Option<usize>, bool, bool) {
        match at {
            "extract" => (0, None, false, false),
            "marker" => (0, None, false, true),
            "absent:0" | "done" => (UNITS.len(), None, at == "absent:0" || at == "done", true),
            _ => {
                let (kind, i) = at.split_once(':').unwrap();
                let i: usize = i.parse().unwrap();
                match kind {
                    "swap" => (i, Some(i), false, true),
                    "swap-after" => (i + 1, None, false, true),
                    _ => panic!("unknown cut {at}"),
                }
            }
        }
    }

    fn staging_dir(home: &Path) -> Option<PathBuf> {
        let found: Vec<PathBuf> = fs::read_dir(home)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".restore-")
            })
            .collect();
        assert!(found.len() <= 1, "{found:?}");
        found.into_iter().next()
    }

    fn pre_dir(home: &Path) -> Option<PathBuf> {
        let found: Vec<PathBuf> = backups_entries(home)
            .into_iter()
            .filter(|n| n.starts_with("pre-restore-") && !DECOYS.contains(&n.as_str()))
            .map(|n| home.join("backups").join(n))
            .collect();
        assert!(found.len() <= 1, "{found:?}");
        found.into_iter().next()
    }

    const CUTS: [&str; 12] = [
        "extract",
        "marker",
        "swap:0",
        "swap-after:0",
        "swap:1",
        "swap-after:1",
        "swap:2",
        "swap-after:2",
        "swap:3",
        "swap-after:3",
        "absent:0",
        "done",
    ];

    #[test]
    fn a_sigkill_at_every_cut_loses_no_data_keeps_the_marker_and_a_repeat_converges() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("b.tar.gz");
        build(&archive, &fixture());

        // Reference: the same restore, undisturbed.
        let reference = root.path().join("reference");
        fs::create_dir_all(&reference).unwrap();
        old_home(&reference);
        let old: Vec<Snap> = UNITS
            .iter()
            .map(|(_, t)| snap(&reference.join(t)))
            .collect();
        let others: Vec<Snap> = OTHERS.iter().map(|t| snap(&reference.join(t))).collect();
        restore_with(&reference, &archive, &[]);
        let new: Vec<Snap> = UNITS
            .iter()
            .map(|(_, t)| snap(&reference.join(t)))
            .collect();
        assert!(new.iter().all(Option::is_some));
        assert!(!reference.join(ABSENT).exists());

        for at in CUTS {
            let home = root.path().join(format!("home-{}", at.replace(':', "-")));
            fs::create_dir_all(&home).unwrap();
            old_home(&home);
            for n in DECOYS {
                plant_pre(&home, n);
            }
            let old_absent = snap(&home.join(ABSENT));
            assert!(old_absent.is_some());
            let checkpoint = root
                .path()
                .join(format!("checkpoint-{}", at.replace(':', "-")));
            let held = hold(&home, &archive, &checkpoint, at);
            kill(held, at);

            let (placed, aside, absent_aside, marker) = expectation(at);
            // The marker: from the cut `marker` on, never at `extract`.
            assert_eq!(home.join(MARKER).exists(), marker, "{at}: marker");
            let staging = staging_dir(&home).expect("a killed restore leaves its staging tree");
            let pre = pre_dir(&home);
            if matches!(at, "absent:0" | "done") {
                assert_eq!(
                    fs::read_dir(&staging).unwrap().count(),
                    0,
                    "{at}: every unit left the staging tree"
                );
            }
            if placed == 0 && aside.is_none() {
                assert!(pre.is_none(), "{at}: nothing was moved aside yet");
            }
            // No data loss, unit by unit: every unit is at its live place (old or new, whole) or whole under pre-restore;
            // what is not placed yet is whole in the staging tree.
            for (k, (archive_path, target)) in UNITS.iter().enumerate() {
                let live = snap(&home.join(target));
                let kept = pre.as_ref().and_then(|p| snap(&p.join(target)));
                let staged = snap(&staging.join(archive_path));
                if k < placed {
                    assert_eq!(live, new[k], "{at}: unit {target} is the new one, whole");
                    assert_eq!(
                        kept, old[k],
                        "{at}: the old {target} is whole under pre-restore"
                    );
                    assert!(staged.is_none(), "{at}: {target} left the staging tree");
                } else if aside == Some(k) {
                    assert!(live.is_none(), "{at}: {target} is between old and new");
                    assert_eq!(
                        kept, old[k],
                        "{at}: the old {target} is whole under pre-restore"
                    );
                    if at != "extract" {
                        assert_eq!(
                            staged, new[k],
                            "{at}: the new {target} waits whole in staging"
                        );
                    }
                } else {
                    assert_eq!(live, old[k], "{at}: {target} is still the old one, whole");
                    assert!(kept.is_none(), "{at}: {target} was not moved");
                    if at != "extract" {
                        assert_eq!(
                            staged, new[k],
                            "{at}: the new {target} waits whole in staging"
                        );
                    }
                }
            }
            let absent_live = snap(&home.join(ABSENT));
            if absent_aside {
                assert!(absent_live.is_none(), "{at}");
                assert_eq!(
                    pre.as_ref().and_then(|p| snap(&p.join(ABSENT))),
                    old_absent,
                    "{at}"
                );
            } else {
                assert_eq!(absent_live, old_absent, "{at}");
            }
            for (t, before) in OTHERS.iter().zip(&others) {
                assert_eq!(&snap(&home.join(t)), before, "{at}: {t} is not a unit");
            }

            // No lock outlives the killed process, and the repeat converges. With a marker in place the repeat must not
            // run the retention (an earlier restore is unfinished) and says so.
            let keep: &[&str] = if marker { &["--keep", "1"] } else { &[] };
            let out = restore_with(&home, &archive, keep);
            assert_eq!(doc(&out)["applied"], true, "{at}");
            for (k, (_, target)) in UNITS.iter().enumerate() {
                assert_eq!(snap(&home.join(target)), new[k], "{at}: converged {target}");
            }
            assert!(!home.join(ABSENT).exists(), "{at}: the absent unit is gone");
            for (t, before) in OTHERS.iter().zip(&others) {
                assert_eq!(&snap(&home.join(t)), before, "{at}: {t} after the repeat");
            }
            assert!(
                home.join(MARKER).exists(),
                "{at}: the marker stays for the next core start"
            );
            if marker {
                for n in DECOYS {
                    assert!(
                        home.join("backups").join(n).is_dir(),
                        "{at}: --keep must not delete {n}"
                    );
                }
                let err = String::from_utf8_lossy(&out.stderr);
                assert!(
                    err.contains("--keep") && err.contains("re-apply"),
                    "{at}: warning: {err}"
                );
            }
            // The state the repeat displaced is the half state of the killed run: still whole under its pre-restore tree.
            if let Some(killed) = pre.as_ref() {
                for (k, (_, target)) in UNITS.iter().enumerate() {
                    if k < placed || aside == Some(k) {
                        assert_eq!(
                            snap(&killed.join(target)),
                            old[k],
                            "{at}: the killed run's copy of {target} is still whole"
                        );
                    }
                }
                if absent_aside {
                    assert_eq!(
                        snap(&killed.join(ABSENT)),
                        old_absent,
                        "{at}: the killed run's copy of the absent unit"
                    );
                }
            }
            let latest = fresh_after_repeat(&home, pre.as_deref());
            assert!(latest.is_dir(), "{at}");
        }
    }

    /// The pre-restore tree the repeat created (not a decoy, not the killed run's).
    fn fresh_after_repeat(home: &Path, killed: Option<&Path>) -> PathBuf {
        let found: Vec<PathBuf> = backups_entries(home)
            .into_iter()
            .filter(|n| n.starts_with("pre-restore-") && !DECOYS.contains(&n.as_str()))
            .map(|n| home.join("backups").join(n))
            .filter(|p| Some(p.as_path()) != killed)
            .collect();
        assert_eq!(found.len(), 1, "{found:?}");
        found[0].clone()
    }
}
