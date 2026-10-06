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
    w("agents/bernd/persona.md", "old persona");
    w("agents/anna/persona.md", "created after the backup");
    w("state/journal/bernd.jsonl", "old journal");
    w("run/core.token", "SECRET-TOKEN");
    w("logs/supervisor.log", "log line");
    w("models/m.bin", "model");
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
                out.insert(rel, Some(fs::read(e.path()).unwrap()));
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
            .code(1)
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
            .code(1)
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
fn restore_without_yes_in_a_script_is_refused_before_anything_changes() {
    let (_d, home, a) = setup();
    old_home(&home);
    build(&a, &fixture());
    let before = tree(&home);
    let out = cli(&home)
        .args(["backup", "restore"])
        .arg(&a)
        .assert()
        .failure()
        .code(2)
        .get_output()
        .clone();
    assert_eq!(doc(&out)["applied"], false);
    assert_eq!(tree(&home), before);
}

#[test]
fn a_restore_swaps_the_units_keeps_what_it_replaced_and_leaves_everything_else_alone() {
    let (_d, home, a) = setup();
    old_home(&home);
    build(&a, &fixture());
    let before = tree(&home);
    let out = cli(&home)
        .args(["backup", "restore", "--yes"])
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
