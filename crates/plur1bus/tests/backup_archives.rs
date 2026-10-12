//! Archives `backup verify` and `backup restore` must refuse, written as matrices: manifest schema strings, entry names, unit
//! targets, entry types, duplicates and ordering. `tests/backup.rs` has one case of each kind; these are the neighbours. Every
//! refused archive is also fed to `restore --yes` against a live home, which must be byte-identical afterwards.
//!
//! Round trips, truncation, single-byte damage and the secrets markers are in `src/backup/hardening.rs`.
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
        .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS")
        .timeout(std::time::Duration::from_secs(60));
    c
}

fn sha(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

fn files() -> Vec<(String, Vec<u8>)> {
    vec![
        ("store/table.lance".into(), b"restored-store".to_vec()),
        ("config.json".into(), b"{\"restored\":true}".to_vec()),
        (
            "agents/bernd/persona.md".into(),
            b"restored persona".to_vec(),
        ),
    ]
}

fn manifest_for(files: &[(String, Vec<u8>)]) -> Value {
    json!({
        "schema": "plur1bus.backup/1", "createdAtMs": 1, "harness": { "version": "0.1.0" },
        "platform": { "os": "linux", "arch": "x86_64" }, "engine": { "contract": "1.12.0", "storeSchema": "1" },
        "storeTarget": "state/lancedb",
        "units": [
            { "archive": "store", "target": "state/lancedb", "kind": "dir" },
            { "archive": "config.json", "target": "config.json", "kind": "file" },
            { "archive": "agents", "target": "agents", "kind": "dir" },
        ],
        "absent": [], "dirs": ["agents/bernd"],
        "files": files.iter().map(|(p, b)| json!({ "path": p, "bytes": b.len(), "sha256": sha(b) })).collect::<Vec<_>>(),
        "skipped": [], "secrets": { "included": false, "note": "none" },
    })
}

/// One tar entry: its name as written (no validation, so `..` and absolute names can be written), type and optional link target.
struct Entry {
    name: String,
    data: Vec<u8>,
    kind: tar::EntryType,
    link: Option<String>,
}
impl Entry {
    fn file(name: &str, data: &[u8]) -> Entry {
        Entry {
            name: name.into(),
            data: data.to_vec(),
            kind: tar::EntryType::Regular,
            link: None,
        }
    }
}

fn write_tar(path: &Path, entries: &[Entry]) {
    let mut t = tar::Builder::new(GzEncoder::new(
        fs::File::create(path).unwrap(),
        Compression::default(),
    ));
    for e in entries {
        let mut h = tar::Header::new_gnu();
        {
            let gnu = h.as_gnu_mut().unwrap();
            assert!(e.name.len() < 100, "name too long for a plain header");
            gnu.name[..e.name.len()].copy_from_slice(e.name.as_bytes());
        }
        if let Some(l) = &e.link {
            h.as_gnu_mut().unwrap().linkname[..l.len()].copy_from_slice(l.as_bytes());
        }
        h.set_size(if e.kind == tar::EntryType::Regular {
            e.data.len() as u64
        } else {
            0
        });
        h.set_mode(0o600);
        h.set_entry_type(e.kind);
        h.set_cksum();
        let body: &[u8] = if e.kind == tar::EntryType::Regular {
            &e.data
        } else {
            &[]
        };
        t.append(&h, body).unwrap();
    }
    t.into_inner().unwrap().finish().unwrap();
}

fn standard_entries(manifest: &Value, files: &[(String, Vec<u8>)]) -> Vec<Entry> {
    let mut v = vec![Entry::file(
        "manifest.json",
        &serde_json::to_vec(manifest).unwrap(),
    )];
    v.extend(
        files
            .iter()
            .map(|(p, b)| Entry::file(&format!("data/{p}"), b)),
    );
    v
}

/// A live home the restore would replace.
fn live_home(home: &Path) {
    for (p, c) in [
        ("config.json", "{\"old\":true}"),
        ("state/lancedb/table.lance", "old-store"),
        ("agents/bernd/persona.md", "old persona"),
        ("run/core.token", "SECRET"),
        ("logs/a.log", "log"),
    ] {
        let f = home.join(p);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, c).unwrap();
    }
}

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
                if let Ok(b) = fs::read(e.path()) {
                    out.insert(rel, Some(b));
                }
            }
        }
    }
    let mut m = BTreeMap::new();
    go(root, root, &mut m);
    m
}

fn doc(o: &std::process::Output) -> Value {
    serde_json::from_slice(&o.stdout).unwrap_or_else(|e| {
        panic!(
            "not json ({e}): {} / {}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        )
    })
}

/// `verify` and `restore --yes` both refuse `archive` with a reason in `reasons`, and the live home is unchanged.
fn assert_refused(what: &str, archive: &Path, reasons: &[&str]) {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().join("home");
    live_home(&home);
    let before = tree(&home);
    for verb in [vec!["backup", "verify"], vec!["backup", "restore", "--yes"]] {
        let out = cli(&home).args(&verb).arg(archive).output().unwrap();
        assert!(
            !out.status.success(),
            "{what}: `{}` accepted it",
            verb.join(" ")
        );
        let v = doc(&out);
        assert_eq!(v["schema"], "error/1", "{what}");
        let reason = v["reason"].as_str().unwrap_or("");
        assert!(
            reasons.contains(&reason),
            "{what}: `{}` refused with {reason:?}, expected one of {reasons:?}: {v}",
            verb.join(" ")
        );
    }
    assert_eq!(
        tree(&home),
        before,
        "{what}: a refused restore changed the live home"
    );
}

fn archive_path(d: &Path) -> PathBuf {
    d.join("b.tar.gz")
}

// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_good_archive_of_this_file_verifies_and_restores() {
    // The control for every refusal below: the same builders, nothing wrong.
    let d = tempfile::tempdir().unwrap();
    let a = archive_path(d.path());
    let f = files();
    write_tar(&a, &standard_entries(&manifest_for(&f), &f));
    let home = d.path().join("home");
    fs::create_dir_all(&home).unwrap();
    assert!(cli(&home)
        .args(["backup", "verify"])
        .arg(&a)
        .output()
        .unwrap()
        .status
        .success());
    assert!(cli(&home)
        .args(["backup", "restore", "--yes"])
        .arg(&a)
        .output()
        .unwrap()
        .status
        .success());
    assert_eq!(
        fs::read(home.join("config.json")).unwrap(),
        b"{\"restored\":true}"
    );
}

#[test]
fn a_manifest_schema_that_is_not_exactly_version_one_is_refused() {
    let d = tempfile::tempdir().unwrap();
    for (schema, reasons) in [
        (
            json!("plur1bus.backup/0"),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (json!("plur1bus.backup/2"), vec!["unsupported-format"]),
        (json!("plur1bus.backup/3"), vec!["unsupported-format"]),
        (json!("plur1bus.backup/10"), vec!["unsupported-format"]),
        (
            json!("plur1bus.backup/1.1"),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (
            json!("plur1bus.backup/01"),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (
            json!("plur1bus.backup/001"),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (
            json!("plur1bus.backup/+1"),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (
            json!("plur1bus.backup/1e0"),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (
            json!("plur1bus.backup/0x1"),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (
            json!("plur1bus.backup/١"),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (
            json!("PLUR1BUS.BACKUP/1"),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (
            json!("plur1bus.backup/1 "),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (
            json!(" plur1bus.backup/1"),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (
            json!("plur1bus.backup/"),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (
            json!("plur1bus.restore/1"),
            vec!["unsupported-format", "manifest-invalid"],
        ),
        (json!(""), vec!["unsupported-format", "manifest-invalid"]),
        (json!(1), vec!["manifest-invalid"]),
        (json!(null), vec!["manifest-invalid"]),
        (json!(["plur1bus.backup/1"]), vec!["manifest-invalid"]),
    ] {
        let f = files();
        let mut m = manifest_for(&f);
        m["schema"] = schema.clone();
        let a = archive_path(d.path());
        write_tar(&a, &standard_entries(&m, &f));
        assert_refused(&format!("schema {schema}"), &a, &reasons);
    }
    // A missing schema is as bad as a wrong one.
    let f = files();
    let mut m = manifest_for(&f);
    m.as_object_mut().unwrap().remove("schema");
    let a = archive_path(d.path());
    write_tar(&a, &standard_entries(&m, &f));
    assert_refused("no schema", &a, &["unsupported-format", "manifest-invalid"]);
}

#[test]
fn an_unknown_manifest_field_is_refused_at_every_level() {
    let d = tempfile::tempdir().unwrap();
    for path in [
        vec![],
        vec!["harness"],
        vec!["platform"],
        vec!["engine"],
        vec!["secrets"],
    ] {
        let f = files();
        let mut m = manifest_for(&f);
        let mut cur = &mut m;
        for seg in &path {
            cur = cur.get_mut(*seg).unwrap();
        }
        cur.as_object_mut()
            .unwrap()
            .insert("zzUnknown".into(), json!(1));
        let a = archive_path(d.path());
        write_tar(&a, &standard_entries(&m, &f));
        assert_refused(
            &format!("unknown field at {path:?}"),
            &a,
            &["manifest-invalid"],
        );
    }
    {
        let f = files();
        let mut m = manifest_for(&f);
        m["files"][0]
            .as_object_mut()
            .unwrap()
            .insert("zzUnknown".into(), json!(1));
        m["units"][0]
            .as_object_mut()
            .unwrap()
            .insert("zzUnknown".into(), json!(1));
        let a = archive_path(d.path());
        write_tar(&a, &standard_entries(&m, &f));
        assert_refused(
            "unknown field in a file and a unit entry",
            &a,
            &["manifest-invalid"],
        );
    }
}

const HOSTILE_NAMES: &[&str] = &[
    "../outside",
    "a/../../outside",
    "agents/../../outside",
    "/etc/passwd",
    "//server/share/x",
    "a//b",
    "./a",
    "a/./b",
    "a/",
    "C:/Windows/x",
    "c:evil",
    "a\\b",
    "a/b:stream",
    "..",
    ".",
    "",
];

#[test]
fn an_entry_with_a_name_that_climbs_out_is_refused_listed_or_not() {
    let d = tempfile::tempdir().unwrap();
    for name in HOSTILE_NAMES {
        // Not listed in the manifest: an entry nobody announced.
        let f = files();
        let mut entries = standard_entries(&manifest_for(&f), &f);
        entries.push(Entry::file(&format!("data/{name}"), b"x"));
        let a = archive_path(d.path());
        write_tar(&a, &entries);
        assert_refused(
            &format!("unlisted entry data/{name}"),
            &a,
            &["unexpected-entry", "archive-corrupt"],
        );
        // Listed in the manifest under that path: the path itself is refused.
        let mut m = manifest_for(&f);
        m["files"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "path": name, "bytes": 1, "sha256": sha(b"x") }));
        let mut entries = standard_entries(&m, &f);
        entries.push(Entry::file(&format!("data/{name}"), b"x"));
        write_tar(&a, &entries);
        assert_refused(
            &format!("listed path {name:?}"),
            &a,
            &["manifest-invalid", "unexpected-entry"],
        );
    }
    // Longer than a manifest path may be (1024), listed and not present.
    let f = files();
    let mut m = manifest_for(&f);
    m["files"].as_array_mut().unwrap().push(json!({ "path": format!("agents/{}", "a/".repeat(600)) + "f", "bytes": 1, "sha256": sha(b"x") }));
    let a = archive_path(d.path());
    write_tar(&a, &standard_entries(&m, &f));
    assert_refused("a path over 1024 bytes", &a, &["manifest-invalid"]);
}

#[test]
fn a_unit_or_store_target_outside_the_allow_list_is_refused() {
    let d = tempfile::tempdir().unwrap();
    let bad_targets = [
        "../outside",
        "/etc",
        "run",
        "run/x",
        "logs/x",
        "runtime",
        "models",
        "backups",
        ".restore-1",
        "state",
        "state/core.lock",
        "state/lancedb/../../x",
        "agents/../run",
        "foo",
        "state/x.txt",
        "state/backup-staging",
        "a\\b",
        "C:/x",
        "",
        "agents/",
    ];
    for target in bad_targets {
        let f = files();
        let mut m = manifest_for(&f);
        m["units"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "archive": "extra", "target": target, "kind": "dir" }));
        let a = archive_path(d.path());
        write_tar(&a, &standard_entries(&m, &f));
        assert_refused(
            &format!("unit target {target:?}"),
            &a,
            &["manifest-invalid"],
        );
    }
    for store in [
        "state",
        "run/x",
        "agents",
        "config.json",
        "../x",
        "/abs",
        "logs",
        "state/journal",
        "agents/x",
        "",
    ] {
        let f = files();
        let mut m = manifest_for(&f);
        m["storeTarget"] = json!(store);
        m["units"][0]["target"] = json!(store);
        let a = archive_path(d.path());
        write_tar(&a, &standard_entries(&m, &f));
        assert_refused(
            &format!("store target {store:?}"),
            &a,
            &["manifest-invalid"],
        );
    }
    // An archive prefix that climbs out.
    for archive in ["../x", "/x", "a/../b", "run"] {
        let f = files();
        let mut m = manifest_for(&f);
        m["units"][2]["archive"] = json!(archive);
        let a = archive_path(d.path());
        write_tar(&a, &standard_entries(&m, &f));
        assert_refused(
            &format!("archive prefix {archive:?}"),
            &a,
            &["manifest-invalid", "unexpected-entry", "missing-entry"],
        );
    }
}

#[test]
fn an_entry_that_is_not_a_regular_file_is_refused_whatever_it_points_at() {
    let d = tempfile::tempdir().unwrap();
    let cases: Vec<(&str, tar::EntryType, Option<&str>)> = vec![
        (
            "symlink to a system file",
            tar::EntryType::Symlink,
            Some("/etc/passwd"),
        ),
        (
            "symlink out of the unit",
            tar::EntryType::Symlink,
            Some("../../outside"),
        ),
        (
            "symlink inside the unit",
            tar::EntryType::Symlink,
            Some("persona.md"),
        ),
        ("hard link", tar::EntryType::Link, Some("data/config.json")),
        ("directory", tar::EntryType::Directory, None),
        ("character device", tar::EntryType::Char, None),
        ("block device", tar::EntryType::Block, None),
        ("fifo", tar::EntryType::Fifo, None),
    ];
    for (what, kind, link) in cases {
        let f = files();
        // Replace the persona entry by the special entry of the same name, so the manifest lists it.
        let mut entries = standard_entries(&manifest_for(&f), &f);
        let at = entries
            .iter()
            .position(|e| e.name == "data/agents/bernd/persona.md")
            .unwrap();
        entries[at] = Entry {
            name: "data/agents/bernd/persona.md".into(),
            data: vec![],
            kind,
            link: link.map(String::from),
        };
        let a = archive_path(d.path());
        write_tar(&a, &entries);
        assert_refused(
            what,
            &a,
            &["unexpected-entry", "archive-corrupt", "checksum-mismatch"],
        );
    }
}

#[test]
fn duplicate_entries_a_manifest_that_is_not_first_and_a_wrong_size_are_refused() {
    let d = tempfile::tempdir().unwrap();
    let a = archive_path(d.path());
    let f = files();
    let m = manifest_for(&f);

    let mut entries = standard_entries(&m, &f);
    entries.push(Entry::file("data/config.json", b"{\"restored\":true}"));
    write_tar(&a, &entries);
    assert_refused("the same entry twice", &a, &["unexpected-entry"]);

    let mut entries = standard_entries(&m, &f);
    entries.swap(0, 1);
    write_tar(&a, &entries);
    assert_refused(
        "the manifest is not the first entry",
        &a,
        &["manifest-invalid"],
    );

    let mut entries = standard_entries(&m, &f);
    entries.remove(0);
    write_tar(&a, &entries);
    assert_refused("no manifest at all", &a, &["manifest-invalid"]);

    let mut wrong = m.clone();
    wrong["files"][1]["bytes"] = json!(3);
    write_tar(&a, &standard_entries(&wrong, &f));
    assert_refused(
        "a size that differs from the data",
        &a,
        &["checksum-mismatch", "truncated"],
    );

    let mut entries = standard_entries(&m, &f);
    entries[0] = Entry::file("manifest.json", b"not json at all");
    write_tar(&a, &entries);
    assert_refused("a manifest that is not JSON", &a, &["manifest-invalid"]);

    write_tar(&a, &[]);
    assert_refused(
        "an empty archive",
        &a,
        &["archive-corrupt", "manifest-invalid"],
    );

    fs::write(&a, b"").unwrap();
    assert_refused(
        "a zero-length file",
        &a,
        &["archive-corrupt", "truncated", "manifest-invalid"],
    );

    assert_refused(
        "a file that is not there",
        &d.path().join("nope.tar.gz"),
        &["io", "not-found", "archive-corrupt"],
    );
}

#[test]
fn restore_into_a_home_with_content_asks_first_and_keeps_what_it_replaces() {
    // Documented behaviour: a restore replaces the units, after a plan and a confirmation, and keeps the displaced tree in
    // <home>/backups/pre-restore-<id>. Without --yes in a script it is refused before anything changes.
    let d = tempfile::tempdir().unwrap();
    let a = archive_path(d.path());
    let f = files();
    write_tar(&a, &standard_entries(&manifest_for(&f), &f));
    let home = d.path().join("home");
    live_home(&home);
    let before = tree(&home);
    let out = cli(&home)
        .args(["backup", "restore"])
        .arg(&a)
        .output()
        .unwrap();
    assert!(
        !out.status.success(),
        "a script restore without --yes must not proceed"
    );
    assert_eq!(tree(&home), before);
    let out = cli(&home)
        .args(["backup", "restore", "--yes"])
        .arg(&a)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v = doc(&out);
    let pre = PathBuf::from(
        v["preRestore"]
            .as_str()
            .expect("the displaced tree is reported"),
    );
    assert_eq!(
        fs::read(pre.join("config.json")).unwrap(),
        b"{\"old\":true}",
        "the replaced config is kept aside"
    );
    assert_eq!(
        fs::read(home.join("config.json")).unwrap(),
        b"{\"restored\":true}"
    );
    // run/ and logs/ are never touched.
    assert_eq!(fs::read(home.join("run/core.token")).unwrap(), b"SECRET");
    assert_eq!(fs::read(home.join("logs/a.log")).unwrap(), b"log");
}
