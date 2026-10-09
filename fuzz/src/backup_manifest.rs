//! Backup manifest parsing and archive path validation (the real `backup/manifest.rs` and `backup/archive.rs`).
//!
//! First byte selects the mode:
//! * 0: `safe_rel` and the target/prefix helpers on arbitrary text.
//! * 1: raw bytes as `manifest.json`: parse, `validate`, round trip.
//! * 2: raw bytes as a file `backup verify` opens (gzip/tar structure, usually refused early).
//! * 3: raw bytes as a gzip stream of a tar made of the rest (gzip layer always valid, tar layer hostile).
//! * otherwise: a structured manifest (units, files, dirs with hostile and near-valid paths) inside a well-formed
//!   tar.gz whose entry names and bodies come from the same input, so `verify` runs past the first entry.
//!
//! Invariants: no panic. `safe_rel(p)` never holds for an absolute path, a `..`/`.` segment, a backslash, a colon or a
//! NUL. A manifest that validates names only safe paths and round-trips. An archive that verifies yields only file
//! entries whose path is `safe_rel`.
use crate::backup::archive::verify;
use crate::backup::manifest::*;
use arbitrary::Unstructured;
use serde_json::{json, Value};
use std::io::Write;

fn assert_safe(p: &str) {
    assert!(safe_rel(p), "validated manifest names unsafe path {p:?}");
    assert!(!p.starts_with('/') && !p.contains(['\\', ':', '\0']));
    assert!(p.split('/').all(|s| !s.is_empty() && s != "." && s != ".."));
}

fn check_manifest(m: &Manifest) {
    if m.validate().is_err() {
        return;
    }
    assert!(!m.secrets.included);
    assert_safe(&m.store_target);
    for u in &m.units {
        assert_safe(&u.target);
        assert_safe(&u.archive);
        assert_eq!(target_kind(&u.target, &m.store_target), Some(u.kind));
    }
    for p in m.dirs.iter().chain(m.absent.iter()) {
        assert_safe(p);
    }
    for f in &m.files {
        assert_safe(&f.path);
        assert_eq!(f.sha256.len(), 64);
    }
    let text = serde_json::to_vec(m).expect("a manifest serialises");
    let again: Manifest = serde_json::from_slice(&text).expect("a serialised manifest re-parses");
    assert_eq!(*m, again, "manifest round trip changed it");
    again
        .validate()
        .expect("a validated manifest still validates after a round trip");
}

fn verify_bytes(bytes: &[u8]) {
    let mut f = tempfile::NamedTempFile::new().expect("temp file");
    f.write_all(bytes).expect("write");
    f.flush().expect("flush");
    if let Ok(m) = verify(f.path()) {
        check_manifest(&m);
        assert!(m.validate().is_ok());
    }
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(bytes).expect("gzip");
    e.finish().expect("gzip finish")
}

/// A tar entry whose name is written into the header verbatim (the builder API refuses `..` and absolute names, which
/// is exactly what an attacker's archive does not do). Names longer than 100 bytes are cut.
fn tar_entry(out: &mut Vec<u8>, name: &[u8], body: &[u8], kind: u8) {
    let mut h = tar::Header::new_old();
    let n = name.len().min(100);
    h.as_old_mut().name[..n].copy_from_slice(&name[..n]);
    h.set_size(body.len() as u64);
    h.set_mode(0o644);
    h.set_entry_type(tar::EntryType::new(kind));
    h.set_cksum();
    out.extend_from_slice(h.as_bytes());
    out.extend_from_slice(body);
    out.resize(out.len().div_ceil(512) * 512, 0);
}

const SEGMENTS: &[&str] = &[
    "agents",
    "skills",
    "modules",
    "extensions",
    "catalog",
    "state",
    "journal",
    "memory",
    "_archive",
    "config.json",
    "lancedb",
    "run",
    "logs",
    "core.lock",
    "a.sqlite",
    "a.sqlite-wal",
    "store",
    "data",
    "..",
    ".",
    "",
    "C:",
    "x\\y",
    ".restore-1",
    "backups",
    "system-jobs",
];

fn path(u: &mut Unstructured) -> String {
    let n = u.int_in_range(0..=4).unwrap_or(0);
    let mut parts = Vec::new();
    for _ in 0..n {
        if u.ratio(3, 4).unwrap_or(true) {
            parts.push(
                u.choose(SEGMENTS)
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
            );
        } else {
            parts.push(u.arbitrary::<String>().unwrap_or_default());
        }
    }
    let mut p = parts.join("/");
    if u.ratio(1, 16).unwrap_or(false) {
        p.insert(0, '/');
    }
    p
}

fn hex(u: &mut Unstructured, good: &str) -> String {
    if u.ratio(3, 4).unwrap_or(true) {
        good.to_string()
    } else {
        u.arbitrary::<String>().unwrap_or_default()
    }
}

/// A manifest document plus the (path, body) pairs it lists, so the archive can carry matching entries.
fn structured(u: &mut Unstructured) -> (Value, Vec<(String, Vec<u8>)>) {
    use sha2::{Digest, Sha256};
    let store = if u.ratio(3, 4).unwrap_or(true) {
        "state/lancedb".to_string()
    } else {
        path(u)
    };
    let mut units = Vec::new();
    for _ in 0..u.int_in_range(0..=4).unwrap_or(0) {
        let target = if u.ratio(1, 2).unwrap_or(true) {
            {
                let all: Vec<&str> = FIXED_DIRS.iter().chain(FIXED_FILES).copied().collect();
                u.choose(&all).map(|s| s.to_string()).unwrap_or_default()
            }
        } else {
            path(u)
        };
        let archive = if u.ratio(2, 3).unwrap_or(true) {
            archive_prefix(&target, &store)
        } else {
            path(u)
        };
        let kind = if u.ratio(1, 2).unwrap_or(true) {
            "dir"
        } else {
            "file"
        };
        units.push(json!({"archive": archive, "target": target, "kind": kind}));
    }
    let mut files = Vec::new();
    let mut bodies = Vec::new();
    for _ in 0..u.int_in_range(0..=4).unwrap_or(0) {
        let p = if !units.is_empty() && u.ratio(2, 3).unwrap_or(true) {
            let base = units[u.int_in_range(0..=units.len() - 1).unwrap_or(0)]["archive"]
                .as_str()
                .unwrap_or("")
                .to_string();
            if u.ratio(1, 2).unwrap_or(true) {
                base
            } else {
                format!("{base}/{}", path(u))
            }
        } else {
            path(u)
        };
        let body: Vec<u8> = u.arbitrary().unwrap_or_default();
        let sha = hex(u, &format!("{:x}", Sha256::digest(&body)));
        files.push(json!({"path": p, "bytes": body.len(), "sha256": sha}));
        bodies.push((p, body));
    }
    let dirs: Vec<String> = (0..u.int_in_range(0..=2).unwrap_or(0))
        .map(|_| path(u))
        .collect();
    let absent: Vec<String> = (0..u.int_in_range(0..=2).unwrap_or(0))
        .map(|_| path(u))
        .collect();
    let doc = json!({
        "schema": if u.ratio(7, 8).unwrap_or(true) { SCHEMA.to_string() } else { u.arbitrary::<String>().unwrap_or_default() },
        "createdAtMs": 1,
        "harness": {"version": "0"},
        "platform": {"os": "linux", "arch": "x86_64"},
        "engine": {"contract": "1.0.0", "storeSchema": null},
        "storeTarget": store,
        "units": units,
        "absent": absent,
        "dirs": dirs,
        "files": files,
        "skipped": [],
        "secrets": {"included": u.ratio(1, 16).unwrap_or(false), "note": SECRETS_NOTE},
    });
    (doc, bodies)
}

pub fn run(data: &[u8]) {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    match mode {
        0 => {
            let s = String::from_utf8_lossy(rest);
            if safe_rel(&s) {
                assert_safe(&s);
            }
            let _ = (
                is_sqlite_sidecar(&s),
                is_sqlite_name(&s),
                store_target_allowed(&s),
            );
            let store = s.split('\n').next().unwrap_or("");
            let _ = (archive_prefix(&s, store), target_kind(&s, store));
        }
        1 => {
            if let Ok(m) = serde_json::from_slice::<Manifest>(rest) {
                check_manifest(&m);
            }
        }
        2 => verify_bytes(rest),
        3 => verify_bytes(&gzip(rest)),
        _ => {
            let mut u = Unstructured::new(rest);
            let (doc, bodies) = structured(&mut u);
            let manifest = serde_json::to_vec(&doc).expect("json");
            if let Ok(m) = serde_json::from_value::<Manifest>(doc) {
                check_manifest(&m);
            }
            let mut tar = Vec::new();
            tar_entry(&mut tar, b"manifest.json", &manifest, b'0');
            for (p, body) in &bodies {
                // Mostly the listed name under data/, sometimes a link, sometimes a name the manifest does not list.
                let kind = if u.ratio(1, 8).unwrap_or(false) {
                    b'2'
                } else {
                    b'0'
                };
                let name = if u.ratio(1, 8).unwrap_or(false) {
                    path(&mut u)
                } else {
                    p.clone()
                };
                tar_entry(&mut tar, format!("data/{name}").as_bytes(), body, kind);
            }
            tar.extend_from_slice(&[0u8; 1024]);
            verify_bytes(&gzip(&tar));
        }
    }
}
