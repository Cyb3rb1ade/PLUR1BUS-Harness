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
