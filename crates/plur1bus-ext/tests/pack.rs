//! `pack_dir`, script derivation and the testkit (spec 2026-09-27 §5.3, §8.4 step 6; X1-R10, X1-R14).
use plur1bus_ext::manifest::parse_manifest;
use plur1bus_ext::pack::pack_dir;
use plur1bus_ext::refusal::reason;
use plur1bus_ext::scripts::is_script;
use plur1bus_ext::zipaudit::{audit_zip, hash_entry, read_entry, Limits};
use serde_json::{json, Value};
use std::io::Cursor;
use std::path::Path;

pub fn template(name: &str) -> Value {
    json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": format!("demo/{name}"),
        "name": name,
        "version": "1.0.0",
        "kind": "skill",
        "title": { "en": "Demo" },
        "summary": { "en": "A demo." },
        "publisher": { "id": "demo", "name": "Demo" },
        "licence": "MIT",
        "compat": { "harness": ">=0.0.0" },
        "requires": { "runtime": { "type": "none" } },
        "capabilities": {
            "network": { "mode": "none" },
            "filesystem": [],
            "processes": { "spawn": false },
            "harness": { "authority": "none" }
        }
    })
}

fn write(root: &Path, rel: &str, bytes: &[u8]) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, bytes).unwrap();
}

#[cfg(unix)]
fn chmod(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
fn pack_fills_files_and_scripts_and_the_result_audits_clean() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "SKILL.md", b"---\nname: demo\n---\n");
    write(dir.path(), "refs/b.md", b"b");
    write(dir.path(), "scripts/run.sh", b"#!/bin/sh\necho hi\n");
    write(dir.path(), "z.txt", b"zzz");
    write(dir.path(), "empty-dirs/../keep/a", b"a");
    std::fs::create_dir_all(dir.path().join("empty")).unwrap();
    #[cfg(unix)]
    chmod(&dir.path().join("scripts/run.sh"), 0o755);

    let mut out = Cursor::new(Vec::new());
    let m = pack_dir(
        &template("demo"),
        dir.path(),
        "2026-01-02T03:04:05Z",
        &mut out,
    )
    .unwrap();
    let bytes = out.into_inner();

    let names: Vec<&str> = m.files.keys().map(String::as_str).collect();
    assert_eq!(
        names,
        [
            "payload/SKILL.md",
            "payload/keep/a",
            "payload/refs/b.md",
            "payload/scripts/run.sh",
            "payload/z.txt"
        ]
    );
    assert_eq!(m.scripts, ["payload/scripts/run.sh"]);
    assert_eq!(m.rest["created"], "2026-01-02T03:04:05Z");
    #[cfg(unix)]
    assert!(m.files["payload/scripts/run.sh"].exec);

    let mut r = Cursor::new(&bytes);
    let audited = audit_zip(&mut r, &Limits::default()).unwrap();
    // p1x.json first, then payload/… sorted; no p1x.json.minisig from pack.
    let order: Vec<&str> = audited.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(order[0], "p1x.json");
    assert_eq!(&order[1..], names.as_slice());
    let manifest = read_entry(&mut r, &audited.entries[0], 1 << 20).unwrap();
    let parsed = parse_manifest(&manifest, &[]).unwrap();
    assert_eq!(parsed.files.len(), m.files.len());
    for e in &audited.entries[1..] {
        let d = hash_entry(&mut r, e).unwrap();
        let f = &m.files[&e.name];
        assert_eq!((d.sha256.as_str(), d.size), (f.sha256.as_str(), f.size));
        assert_eq!(e.exec, f.exec, "{}", e.name);
    }
    // Reproducible: the same input packs to the same bytes.
    let mut again = Cursor::new(Vec::new());
    pack_dir(
        &template("demo"),
        dir.path(),
        "2026-01-02T03:04:05Z",
        &mut again,
    )
    .unwrap();
    assert_eq!(again.into_inner(), bytes);
}

#[test]
fn pack_refuses_an_invalid_template() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "SKILL.md", b"x");
    let mut t = template("demo");
    t["version"] = json!("one");
    let e = pack_dir(
        &t,
        dir.path(),
        "2026-01-02T03:04:05Z",
        &mut Cursor::new(Vec::new()),
    )
    .unwrap_err();
    assert_eq!(e.reason, reason::PACKAGE_INVALID);
}

#[test]
fn pack_refuses_credential_vcs_and_cache_names_in_a_skill_payload() {
    for bad in [
        ".env",
        "sub/id_rsa",
        ".netrc",
        "a/.git/config",
        "__pycache__/m.pyc",
        ".hg/x",
    ] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "SKILL.md", b"x");
        write(dir.path(), bad, b"secret");
        let e = pack_dir(
            &template("demo"),
            dir.path(),
            "2026-01-02T03:04:05Z",
            &mut Cursor::new(Vec::new()),
        )
        .unwrap_err();
        assert_eq!(
            (e.code, e.reason),
            ("E_INVALID_PARAMS", reason::UNSAFE_ENTRY),
            "{bad}"
        );
        assert!(e.detail.contains("never carries"), "{}", e.detail);
    }
    // A module payload is not held to the skill rule.
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "module.json", b"{}");
    write(dir.path(), ".env", b"x");
    let mut t = template("demo");
    t["kind"] = json!("module");
    t["compat"] = json!({ "harness": ">=0.0.0", "moduleApi": ["1"] });
    pack_dir(
        &t,
        dir.path(),
        "2026-01-02T03:04:05Z",
        &mut Cursor::new(Vec::new()),
    )
    .unwrap();
}

#[test]
fn script_derivation_finds_exec_shebang_scripts_dir_bin_dir_and_native_magic() {
    assert!(is_script("payload/a.txt", true, b"x"), "exec bit");
    assert!(
        is_script("payload/a.txt", false, b"#!/usr/bin/env node"),
        "shebang"
    );
    assert!(is_script("payload/scripts/x.txt", false, b"hi"), "scripts/");
    assert!(
        is_script("payload/deep/bin/x", false, b"hi"),
        "bin/ at any depth"
    );
    for magic in [
        &[0x7F, b'E', b'L', b'F'][..],
        &[0xFE, 0xED, 0xFA, 0xCE],
        &[0xFE, 0xED, 0xFA, 0xCF],
        &[0xCE, 0xFA, 0xED, 0xFE],
        &[0xCF, 0xFA, 0xED, 0xFE],
        &[0xCA, 0xFE, 0xBA, 0xBE],
        b"MZ\x90\x00",
    ] {
        assert!(is_script("payload/lib.dat", false, magic), "{magic:02x?}");
    }
    assert!(!is_script("payload/SKILL.md", false, b"---\n"));
    assert!(
        !is_script("payload/scripts", false, b"x"),
        "a file named scripts is not under it"
    );
    assert!(!is_script("payload/my-scripts/x", false, b"x"));
    assert!(!is_script("payload/a", false, b"#"));
    assert!(!is_script("payload/a", false, b"M"));
}

#[cfg(unix)]
#[test]
fn pack_refuses_symlinks_and_special_files() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "SKILL.md", b"x");
    symlink("/etc/passwd", dir.path().join("link")).unwrap();
    let e = pack_dir(
        &template("demo"),
        dir.path(),
        "2026-01-02T03:04:05Z",
        &mut Cursor::new(Vec::new()),
    )
    .unwrap_err();
    assert_eq!(
        (e.code, e.reason),
        ("E_INVALID_PARAMS", reason::UNSAFE_ENTRY)
    );

    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "SKILL.md", b"x");
    let fifo = dir.path().join("pipe");
    let status = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap();
    assert!(status.success());
    let e = pack_dir(
        &template("demo"),
        dir.path(),
        "2026-01-02T03:04:05Z",
        &mut Cursor::new(Vec::new()),
    )
    .unwrap_err();
    assert_eq!(e.reason, reason::UNSAFE_ENTRY);

    // A symlinked directory is refused too, not followed.
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    write(other.path(), "secret", b"s");
    write(dir.path(), "SKILL.md", b"x");
    symlink(other.path(), dir.path().join("d")).unwrap();
    let e = pack_dir(
        &template("demo"),
        dir.path(),
        "2026-01-02T03:04:05Z",
        &mut Cursor::new(Vec::new()),
    )
    .unwrap_err();
    assert_eq!(e.reason, reason::UNSAFE_ENTRY);
}

#[cfg(feature = "testkit")]
mod testkit {
    use super::*;
    use plur1bus_ext::testkit::{build_package, tamper, test_key, Tamper};

    fn signed() -> Vec<u8> {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "SKILL.md", b"---\nname: demo\n---\nbody\n");
        write(dir.path(), "references/a.md", b"a");
        build_package(&template("demo"), dir.path(), Some(&test_key("test")))
    }

    #[test]
    fn testkit_signs_a_package_that_audits_clean_and_carries_the_trusted_comment() {
        let pkg = signed();
        let mut r = Cursor::new(&pkg);
        let a = audit_zip(&mut r, &Limits::default()).unwrap();
        let names: Vec<&str> = a.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names[..2], ["p1x.json", "p1x.json.minisig"]);
        let sig = String::from_utf8(read_entry(&mut r, &a.entries[1], 1 << 20).unwrap()).unwrap();
        let raw = read_entry(&mut r, &a.entries[0], 1 << 20).unwrap();
        use sha2::{Digest, Sha256};
        let hex: String = Sha256::digest(&raw)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert!(
            sig.contains(&format!(
                "trusted comment: p1x demo/demo 1.0.0 sha256(p1x.json)={hex}"
            )),
            "{sig}"
        );
        assert_ne!(
            test_key("a").public_b64,
            test_key("a").public_b64,
            "a fresh key per call"
        );
    }

    #[test]
    fn testkit_signature_verifies_with_minisign_verify() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "SKILL.md", b"x");
        let key = test_key("test");
        let pkg = build_package(&template("demo"), dir.path(), Some(&key));
        let mut r = Cursor::new(&pkg);
        let a = audit_zip(&mut r, &Limits::default()).unwrap();
        let raw = read_entry(&mut r, &a.entries[0], 1 << 20).unwrap();
        let sig = String::from_utf8(read_entry(&mut r, &a.entries[1], 1 << 20).unwrap()).unwrap();
        let pk = minisign_verify::PublicKey::from_base64(&key.public_b64).unwrap();
        let sig = minisign_verify::Signature::decode(&sig).unwrap();
        pk.verify(&raw, &sig, false).unwrap();
        assert!(sig
            .trusted_comment()
            .starts_with("p1x demo/demo 1.0.0 sha256(p1x.json)="));
    }

    #[test]
    fn testkit_tamper_produces_the_eight_variants() {
        let pkg = signed();
        let mut seen = std::collections::HashSet::new();
        for how in Tamper::ALL {
            let t = tamper(&pkg, how);
            assert_ne!(t, pkg, "{how:?}");
            assert!(
                seen.insert(t.clone()),
                "{how:?} differs from the other variants"
            );
            let audit = audit_zip(&mut Cursor::new(&t), &Limits::default());
            match how {
                Tamper::DotDot | Tamper::Symlink | Tamper::CaseCollision => {
                    assert_eq!(audit.unwrap_err().reason, reason::UNSAFE_ENTRY, "{how:?}")
                }
                Tamper::Bomb101 => assert_eq!(audit.unwrap_err().reason, reason::TOO_LARGE),
                Tamper::AppendAfterEocd => {
                    assert_eq!(audit.unwrap_err().reason, reason::UNSUPPORTED)
                }
                // These stay valid ZIPs: Task 3's verify catches them against the manifest and the signature.
                Tamper::PayloadByte | Tamper::ExtraEntry | Tamper::ForeignId => {
                    audit.unwrap_or_else(|e| panic!("{how:?}: {e}"));
                }
            }
        }
        // PayloadByte: the entry's bytes change, the manifest does not.
        let t = tamper(&pkg, Tamper::PayloadByte);
        let mut r = Cursor::new(&t);
        let a = audit_zip(&mut r, &Limits::default()).unwrap();
        let manifest =
            parse_manifest(&read_entry(&mut r, &a.entries[0], 1 << 20).unwrap(), &[]).unwrap();
        let bad = a
            .entries
            .iter()
            .filter(|e| e.name.starts_with("payload/"))
            .filter(|e| hash_entry(&mut r, e).unwrap().sha256 != manifest.files[&e.name].sha256)
            .count();
        assert_eq!(bad, 1);
        // ForeignId: another id in a manifest that still parses, with the old signature kept.
        let t = tamper(&pkg, Tamper::ForeignId);
        let mut r = Cursor::new(&t);
        let a = audit_zip(&mut r, &Limits::default()).unwrap();
        let m = parse_manifest(&read_entry(&mut r, &a.entries[0], 1 << 20).unwrap(), &[]).unwrap();
        assert_ne!(m.id, "demo/demo");
        assert!(a.entries.iter().any(|e| e.name == "p1x.json.minisig"));
    }
}
