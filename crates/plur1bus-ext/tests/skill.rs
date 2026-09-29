//! The Agent Skills check, skill normalisation and the folder hash (spec 2026-09-27 §4.3, §5.3; X1-R10, X1-R14;
//! controller rulings X1-C1, X1-C2).
use plur1bus_ext::folder_hash::skill_folder_hash;
use plur1bus_ext::manifest::{parse_manifest, P1xManifest};
use plur1bus_ext::normalise::{normalise_skill, normalise_skill_with_warnings, SkillInput};
use plur1bus_ext::refusal::reason;
use plur1bus_ext::skill::{is_excluded, is_skipped, validate_skill_md, EXCLUDED, SKIP};
use plur1bus_ext::zipaudit::{audit_zip, read_entry, Limits};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

const CREATED: &str = "2026-01-02T03:04:05Z";

fn md(name: &str, description: &str, extra: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n{extra}---\n\n# Body\n")
}

#[test]
fn validate_skill_md_enforces_the_agent_skills_rules() {
    let ok = validate_skill_md(
        &md(
            "demo-skill",
            "Does things.",
            "license: MIT\nversion: 1.2.3\n",
        ),
        "demo-skill",
    )
    .unwrap();
    assert_eq!(
        (ok.name.as_str(), ok.description.as_str()),
        ("demo-skill", "Does things.")
    );
    assert_eq!(ok.license.as_deref(), Some("MIT"));
    assert_eq!(ok.version.as_deref(), Some("1.2.3"));

    let bad = |raw: String, dir: &str| validate_skill_md(&raw, dir).unwrap_err();
    // name ≠ directory
    assert_eq!(
        bad(md("demo", "d", ""), "other").reason,
        reason::PACKAGE_INVALID
    );
    // bad names: uppercase, leading/trailing/double hyphen, empty, > 64
    for n in ["Demo", "-demo", "demo-", "de--mo", "de_mo", &"a".repeat(65)] {
        assert_eq!(
            bad(md(n, "d", ""), n).reason,
            reason::PACKAGE_INVALID,
            "{n}"
        );
    }
    // description empty or 1025 chars
    assert_eq!(
        bad(md("demo", "\"\"", ""), "demo").reason,
        reason::PACKAGE_INVALID
    );
    assert_eq!(
        bad(md("demo", &"x".repeat(1025), ""), "demo").reason,
        reason::PACKAGE_INVALID
    );
    validate_skill_md(&md("demo", &"x".repeat(1024), ""), "demo").unwrap();
    // compatibility ≤ 500
    assert_eq!(
        bad(
            md(
                "demo",
                "d",
                &format!("compatibility: {}\n", "c".repeat(501))
            ),
            "demo"
        )
        .reason,
        reason::PACKAGE_INVALID
    );
    validate_skill_md(
        &md(
            "demo",
            "d",
            &format!("compatibility: {}\n", "c".repeat(500)),
        ),
        "demo",
    )
    .unwrap();
    // missing frontmatter, missing description, missing name
    assert_eq!(
        bad("# no frontmatter\n".into(), "demo").reason,
        reason::PACKAGE_INVALID
    );
    assert_eq!(
        bad("---\nname: demo\n---\n".into(), "demo").reason,
        reason::PACKAGE_INVALID
    );
    assert_eq!(
        bad("---\ndescription: d\n---\n".into(), "demo").reason,
        reason::PACKAGE_INVALID
    );
}

#[test]
fn validate_skill_md_reads_yaml_block_scalars_quotes_crlf_and_metadata_version() {
    let raw = "---\r\nname: demo\r\ndescription: >\r\n  Folded over\r\n  two lines.\r\nmetadata:\r\n  version: \"2.0.0\"\r\n  author: x\r\nlicense: 'Apache-2.0'\r\n---\r\nbody";
    let f = validate_skill_md(raw, "demo").unwrap();
    assert_eq!(f.description, "Folded over two lines.");
    assert_eq!(f.version.as_deref(), Some("2.0.0"));
    assert_eq!(f.license.as_deref(), Some("Apache-2.0"));
    let lit = "---\nname: demo\ndescription: |\n  a\n  b\n---\n";
    assert_eq!(validate_skill_md(lit, "demo").unwrap().description, "a\nb");
    // A BOM before the fence is tolerated; Hermes-style nested metadata is ignored.
    let herm =
        "\u{feff}---\nname: demo\ndescription: d\nmetadata:\n  hermes:\n    tags: [a, b]\n---\n";
    validate_skill_md(herm, "demo").unwrap();
    // A frontmatter version wins over metadata.version.
    let both =
        "---\nname: demo\ndescription: d\nversion: 1.0.0\nmetadata:\n  version: 9.9.9\n---\n";
    assert_eq!(
        validate_skill_md(both, "demo").unwrap().version.as_deref(),
        Some("1.0.0")
    );
}

#[test]
fn excluded_names_match_docs_import_9_3() {
    assert_eq!(EXCLUDED.len(), 14);
    for p in [
        ".env",
        "a/.env.local",
        "auth.json",
        "x/credentials.json",
        "k.pem",
        "d/k.key",
        "id_rsa",
        "id_rsa.pub",
        ".git/config",
        "sub/.git/HEAD",
        ".DS_Store",
        "a/.DS_Store",
        "A/.ENV",
        ".netrc",
        "a/.npmrc",
        ".pypirc",
        "id_ed25519",
        "id_ed25519.pub",
        "x/id_ecdsa_sk",
    ] {
        assert!(is_excluded(p), "{p}");
    }
    assert_eq!(SKIP, [".hg/", ".svn/", "__pycache__/"]);
    for p in [".hg", "a/.svn/x", "__pycache__/m.pyc", "x/__pycache__"] {
        assert!(is_skipped(p) && !is_excluded(p), "{p}");
    }
    for p in ["hg", "a.svn", "my__pycache__/x", "SKILL.md"] {
        assert!(!is_skipped(p), "{p}");
    }
    for p in [
        "SKILL.md",
        "environment.md",
        "a/env",
        "gitignore",
        ".github/x",
        "keys/a.txt",
        "auth.jsonl",
    ] {
        assert!(!is_excluded(p), "{p}");
    }
}

// ---- normalise ----------------------------------------------------------------------------------------------------

fn write(root: &Path, rel: &str, bytes: &[u8]) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, bytes).unwrap();
}

fn skill_files(name: &str) -> Vec<(&'static str, Vec<u8>, bool)> {
    vec![
        (
            "SKILL.md",
            md(name, "Does things.", "license: MIT\nversion: 1.2.3\n").into_bytes(),
            false,
        ),
        ("references/a.md", b"ref a".to_vec(), false),
        ("scripts/run.sh", b"#!/bin/sh\necho hi\n".to_vec(), true),
    ]
}

fn make_dir(parent: &Path, name: &str) -> PathBuf {
    let d = parent.join(name);
    for (rel, bytes, exec) in skill_files(name) {
        write(&d, rel, &bytes);
        #[cfg(unix)]
        if exec {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(d.join(rel), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(not(unix))]
        let _ = exec;
    }
    d
}

/// A ZIP like Anthropic's `package_skill.py` writes it: `<folder>/…` (or, with `top` = "", files at the root).
fn make_zip(path: &Path, top: &str, name: &str) {
    let mut w = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    for (rel, bytes, exec) in skill_files(name) {
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(if exec { 0o755 } else { 0o644 });
        let n = if top.is_empty() {
            rel.to_string()
        } else {
            format!("{top}/{rel}")
        };
        w.start_file(n, opts).unwrap();
        w.write_all(&bytes).unwrap();
    }
    w.finish().unwrap();
}

fn run(input: &SkillInput) -> (P1xManifest, Vec<u8>) {
    let mut out = Cursor::new(Vec::new());
    let m = normalise_skill(input, CREATED, &mut out).unwrap();
    (m, out.into_inner())
}

/// The manifest as the package carries it, parsed by Task 2's `parse_manifest`, plus the audit.
fn reparse(bytes: &[u8]) -> P1xManifest {
    let mut r = Cursor::new(bytes);
    let a = audit_zip(&mut r, &Limits::default()).unwrap();
    let raw = read_entry(&mut r, &a.entries[0], 1 << 20).unwrap();
    parse_manifest(&raw, &[]).unwrap()
}

#[test]
fn normalise_a_folder_a_zip_and_a_dot_skill_to_the_same_manifest_files() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = make_dir(tmp.path(), "demo-scripts");
    make_zip(
        &tmp.path().join("demo-scripts.zip"),
        "demo-scripts",
        "demo-scripts",
    );
    make_zip(
        &tmp.path().join("demo-scripts.skill"),
        "demo-scripts",
        "demo-scripts",
    );
    make_zip(&tmp.path().join("root.zip"), "", "demo-scripts");

    let (a, a_bytes) = run(&SkillInput::Dir(dir));
    let (b, _) = run(&SkillInput::Zip(tmp.path().join("demo-scripts.zip")));
    let (c, _) = run(&SkillInput::Zip(tmp.path().join("demo-scripts.skill")));
    let (d, _) = run(&SkillInput::Zip(tmp.path().join("root.zip")));
    let files = |m: &P1xManifest| serde_json::to_value(&m.files).unwrap();
    for other in [&b, &c, &d] {
        assert_eq!(files(&a), files(other));
        assert_eq!(a.scripts, other.scripts);
        assert_eq!(a.id, other.id);
    }
    assert_eq!(
        a.files.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "payload/SKILL.md",
            "payload/references/a.md",
            "payload/scripts/run.sh"
        ]
    );
    assert_eq!(a.scripts, ["payload/scripts/run.sh"]);
    assert!(a.files["payload/scripts/run.sh"].exec);

    // Identity and defaults (X1-R10).
    assert_eq!(a.id, "local/demo-scripts");
    assert_eq!(a.publisher, json!({ "id": "local", "name": "Local" }));
    assert_eq!(a.version, "1.2.3");
    assert_eq!(a.licence, "MIT");
    assert_eq!(a.compat, json!({ "harness": ">=0.0.0" }));
    assert_eq!(a.requires, json!({ "runtime": { "type": "none" } }));
    assert_eq!(a.summary["en"], "Does things.");
    assert_eq!(a.rest["created"], CREATED);
    // The emitted manifest passes Task 2's parse_manifest.
    assert_eq!(reparse(&a_bytes).files.len(), 3);
}

#[test]
fn normalise_emits_an_explicit_capabilities_block() {
    let tmp = tempfile::tempdir().unwrap();
    // With scripts (X1-C1).
    let (m, _) = run(&SkillInput::Dir(make_dir(tmp.path(), "demo-scripts")));
    assert_eq!(
        m.capabilities,
        json!({
            "network": { "mode": "any" },
            "filesystem": [{ "scope": "agent-workspace", "access": "read-write" }],
            "processes": { "spawn": true },
            "harness": { "authority": "none" }
        })
    );
    // Without scripts.
    let d = tmp.path().join("demo-plain");
    write(&d, "SKILL.md", md("demo-plain", "Plain.", "").as_bytes());
    write(&d, "references/a.md", b"a");
    let (m, bytes) = run(&SkillInput::Dir(d));
    assert!(m.scripts.is_empty());
    assert_eq!(
        m.capabilities,
        json!({
            "network": { "mode": "none" },
            "filesystem": [],
            "processes": { "spawn": false },
            "harness": { "authority": "none" }
        })
    );
    assert_eq!(
        m.licence, "unspecified",
        "X1-C2: no licence in the frontmatter"
    );
    assert_eq!(m.version, "0.0.0");
    reparse(&bytes);
}

#[test]
fn normalise_truncates_a_long_description_and_maps_a_non_semver_version() {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path().join("demo-long");
    let long = "word ".repeat(200); // 1000 chars, within the Agent Skills 1024 limit
    write(
        &d,
        "SKILL.md",
        md("demo-long", long.trim(), "version: \"v2\"\nlicense: MIT\n").as_bytes(),
    );
    let mut out = Cursor::new(Vec::new());
    let (m, warnings) =
        normalise_skill_with_warnings(&SkillInput::Dir(d), CREATED, &mut out).unwrap();
    let s = &m.summary["en"];
    assert_eq!(s.chars().count(), 280);
    assert!(s.ends_with('…'));
    assert!(long.starts_with(&s[..s.len() - '…'.len_utf8()]));
    assert_eq!(m.version, "0.0.0");
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("v2") && w.contains("0.0.0")),
        "{warnings:?}"
    );
    assert!(
        warnings.iter().any(|w| w.contains("summary")),
        "{warnings:?}"
    );
    // Both still pass parse_manifest (schema maxLength 280, semver pattern).
    let re = reparse(&out.into_inner());
    assert_eq!(re.summary["en"], *s);

    // A description of exactly 280 characters is kept whole; a multi-byte one is cut on a character.
    let d = tmp.path().join("demo-wide");
    let wide = "ü".repeat(500);
    write(&d, "SKILL.md", md("demo-wide", &wide, "").as_bytes());
    let mut out = Cursor::new(Vec::new());
    let m = normalise_skill(&SkillInput::Dir(d), CREATED, &mut out).unwrap();
    assert_eq!(m.summary["en"].chars().count(), 280);
    reparse(&out.into_inner());
}

#[test]
fn normalise_refuses_excluded_secret_files_and_symlinks() {
    let tmp = tempfile::tempdir().unwrap();
    for (i, secret) in [
        ".env",
        ".env.local",
        "auth.json",
        "credentials.json",
        "k.pem",
        "k.key",
        "id_rsa",
        ".DS_Store",
        ".git/config",
    ]
    .into_iter()
    .enumerate()
    {
        let d = make_dir(tmp.path(), &format!("demo-s{i}"));
        // The directory name differs from the skill's name; rewrite SKILL.md to match.
        write(
            &d,
            "SKILL.md",
            md(&format!("demo-s{i}"), "d", "").as_bytes(),
        );
        write(&d, &format!("sub/{secret}"), b"secret");
        let e = normalise_skill(&SkillInput::Dir(d), CREATED, &mut Cursor::new(Vec::new()))
            .unwrap_err();
        assert_eq!(
            (e.code, e.reason),
            ("E_INVALID_PARAMS", reason::UNSAFE_ENTRY),
            "{secret}"
        );
        assert!(
            e.detail.contains(secret.split('/').next().unwrap()),
            "{}",
            e.detail
        );
    }
    // The same in a ZIP.
    let p = tmp.path().join("s.zip");
    let mut w = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
    let o = zip::write::SimpleFileOptions::default();
    w.start_file("demo/SKILL.md", o).unwrap();
    w.write_all(md("demo", "d", "").as_bytes()).unwrap();
    w.start_file("demo/.env", o).unwrap();
    w.write_all(b"x=1").unwrap();
    w.finish().unwrap();
    let e =
        normalise_skill(&SkillInput::Zip(p), CREATED, &mut Cursor::new(Vec::new())).unwrap_err();
    assert_eq!(e.reason, reason::UNSAFE_ENTRY);

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let d = make_dir(tmp.path(), "demo-link");
        write(&d, "SKILL.md", md("demo-link", "d", "").as_bytes());
        symlink("/etc/passwd", d.join("passwd")).unwrap();
        let e = normalise_skill(&SkillInput::Dir(d), CREATED, &mut Cursor::new(Vec::new()))
            .unwrap_err();
        assert_eq!(e.reason, reason::UNSAFE_ENTRY);
        // A symlinked skill root is refused, never followed.
        let real = make_dir(tmp.path(), "demo-real");
        write(&real, "SKILL.md", md("demo-real", "d", "").as_bytes());
        symlink(&real, tmp.path().join("demo-alias")).unwrap();
        let e = normalise_skill(
            &SkillInput::Dir(tmp.path().join("demo-alias")),
            CREATED,
            &mut Cursor::new(Vec::new()),
        )
        .unwrap_err();
        assert_eq!(e.reason, reason::UNSAFE_ENTRY);
    }
}

#[test]
fn normalise_refuses_layouts_and_names_that_are_not_a_skill() {
    let tmp = tempfile::tempdir().unwrap();
    // No SKILL.md.
    let d = tmp.path().join("empty");
    write(&d, "README.md", b"x");
    let e =
        normalise_skill(&SkillInput::Dir(d), CREATED, &mut Cursor::new(Vec::new())).unwrap_err();
    assert_eq!(e.reason, reason::PACKAGE_INVALID);
    // Directory name ≠ frontmatter name.
    let d = tmp.path().join("dirname");
    write(&d, "SKILL.md", md("other", "d", "").as_bytes());
    let e =
        normalise_skill(&SkillInput::Dir(d), CREATED, &mut Cursor::new(Vec::new())).unwrap_err();
    assert_eq!(e.reason, reason::PACKAGE_INVALID);
    // A 63-character name is valid Agent Skills but not a valid p1x name (≤ 62): refused by parse_manifest.
    let n = "a".repeat(63);
    let d = tmp.path().join(&n);
    write(&d, "SKILL.md", md(&n, "d", "").as_bytes());
    let e =
        normalise_skill(&SkillInput::Dir(d), CREATED, &mut Cursor::new(Vec::new())).unwrap_err();
    assert_eq!(e.reason, reason::PACKAGE_INVALID);
    // Two top folders in a ZIP; a file beside the top folder.
    for names in [&["a/SKILL.md", "b/x"][..], &["a/SKILL.md", "loose.txt"][..]] {
        let p = tmp.path().join("bad.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
        for n in names {
            w.start_file(*n, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(md("a", "d", "").as_bytes()).unwrap();
        }
        w.finish().unwrap();
        let e = normalise_skill(&SkillInput::Zip(p), CREATED, &mut Cursor::new(Vec::new()))
            .unwrap_err();
        assert_eq!(e.reason, reason::PACKAGE_INVALID, "{names:?}");
    }
    // A ZIP the audit refuses (a `..` entry) is refused with the audit's reason.
    let p = tmp.path().join("dd.zip");
    let mut w = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
    w.start_file("a/SKILL.md", zip::write::SimpleFileOptions::default())
        .unwrap();
    w.write_all(md("a", "d", "").as_bytes()).unwrap();
    w.start_file("a/../evil", zip::write::SimpleFileOptions::default())
        .unwrap();
    w.write_all(b"x").unwrap();
    w.finish().unwrap();
    let e =
        normalise_skill(&SkillInput::Zip(p), CREATED, &mut Cursor::new(Vec::new())).unwrap_err();
    assert_eq!(e.reason, reason::UNSAFE_ENTRY);
}

// ---- folder hash --------------------------------------------------------------------------------------------------

fn walk(root: &Path, rel: &str, out: &mut Vec<(String, String)>) {
    let mut names: Vec<_> = std::fs::read_dir(root.join(rel))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    for n in names {
        let r = if rel.is_empty() {
            n.clone()
        } else {
            format!("{rel}/{n}")
        };
        let p = root.join(&r);
        if p.is_dir() {
            walk(root, &r, out);
        } else if r != "expected.json" {
            let hex: String = Sha256::digest(std::fs::read(&p).unwrap())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            out.push((r, hex));
        }
    }
}

#[test]
fn folder_hash_matches_the_shared_vector() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/skill-hash");
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("expected.json")).unwrap()).unwrap();
    assert_eq!(expected["algorithm"], "plur1bus-skill-sha256/v1");
    let mut files = Vec::new();
    walk(&dir, "", &mut files);
    for (rel, hex) in &files {
        assert_eq!(expected["files"][rel], *hex, "{rel}");
    }
    assert_eq!(files.len(), expected["files"].as_object().unwrap().len());
    // Input order does not matter.
    let mut rev = files.clone();
    rev.reverse();
    assert_eq!(skill_folder_hash(&rev), skill_folder_hash(&files));
    assert_eq!(
        skill_folder_hash(&files),
        expected["sha256"].as_str().unwrap()
    );
}

#[test]
fn folder_hash_sorts_like_the_ts_reference_and_hashes_the_empty_set() {
    let h = |v: &[(&str, &str)]| {
        skill_folder_hash(
            &v.iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect::<Vec<_>>(),
        )
    };
    // The empty construction is SHA-256 of nothing.
    assert_eq!(
        h(&[]),
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    // TS sorts by UTF-16 code units: U+1F600 (astral, surrogate D83D) sorts before U+FF5E (BMP), while the UTF-8
    // byte order says the opposite. The expected value below was computed with the TS `folderHash`.
    let a = h(&[("\u{ff5e}", "aa"), ("\u{1f600}", "bb")]);
    let expect = {
        let mut d = Sha256::new();
        d.update("\u{1f600}\0bb\n\u{ff5e}\0aa\n");
        format!(
            "sha256:{}",
            d.finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
    };
    assert_eq!(a, expect);
    assert_eq!(
        a,
        "sha256:e620e1be920c6d8b6bf65c649b814dfbed075dd6cae709ff67704475e196a2c2"
    );
}

// ---- fix round 1 --------------------------------------------------------------------------------------------------

/// Every quoted string in `s`.
fn quoted(s: &str) -> Vec<String> {
    s.split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

/// The text between `start` and the next `end` after it.
fn between<'a>(src: &'a str, start: &str, end: &str) -> &'a str {
    let a = src
        .find(start)
        .unwrap_or_else(|| panic!("{start} not found"))
        + start.len();
    &src[a..a + src[a..].find(end).unwrap()]
}

#[test]
fn rust_excluded_and_skip_cover_the_ts_importer_lists() {
    let ts = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/src/import");
    let readonly = std::fs::read_to_string(ts.join("readonly.ts")).unwrap();
    let scan = std::fs::read_to_string(ts.join("skills-scan.ts")).unwrap();
    // isSecretFileName: the SECRET_NAMES set plus the startsWith / endsWith tests in its body.
    let names = quoted(between(&readonly, "SECRET_NAMES = new Set([", "]"));
    assert!(names.len() >= 6, "{names:?}");
    for n in &names {
        assert!(is_excluded(n), "SECRET_NAMES entry {n:?}");
        assert!(is_excluded(&n.to_uppercase()), "{n:?} in upper case");
    }
    let body = between(
        &readonly,
        "export function isSecretFileName",
        "
}",
    );
    let (mut prefixes, mut suffixes) = (0, 0);
    for part in body.split("n.startsWith(").skip(1) {
        let p = quoted(part.split(')').next().unwrap())[0].clone();
        assert!(is_excluded(&format!("{p}x")), "startsWith({p:?})");
        prefixes += 1;
    }
    for part in body.split("n.endsWith(").skip(1) {
        let p = quoted(part.split(')').next().unwrap())[0].clone();
        assert!(is_excluded(&format!("x{p}")), "endsWith({p:?})");
        suffixes += 1;
    }
    assert!(prefixes >= 3 && suffixes >= 2, "{prefixes} {suffixes}");
    // SKIP_NAMES: refused (EXCLUDED) or skipped (SKIP), as a file and as a directory.
    let skip = quoted(between(&scan, "SKIP_NAMES = new Set([", "]"));
    assert!(skip.len() >= 5, "{skip:?}");
    for n in &skip {
        for path in [n.clone(), format!("d/{n}/x")] {
            assert!(
                is_excluded(&path) || is_skipped(&path),
                "SKIP_NAMES {path:?}"
            );
        }
    }
}

#[test]
fn an_unindented_sequence_belongs_to_the_key_above_it() {
    let raw = "---\nname: demo\nallowed-tools:\n- Bash\n- Read\ndescription: d\n---\n";
    let f = validate_skill_md(raw, "demo").unwrap();
    assert_eq!(f.description, "d");
    // Only a sequence entry before any key is an error.
    let e = validate_skill_md("---\n- a\nname: demo\n---\n", "demo").unwrap_err();
    assert_eq!(e.reason, reason::PACKAGE_INVALID);
}

#[test]
fn untrusted_frontmatter_never_panics_on_multibyte_whitespace() {
    // A block scalar whose second line is indented with one space and U+3000 (3 bytes).
    let raw = "---\nname: demo\ndescription: |\n  x\n \u{3000}y\n---\n";
    let f = validate_skill_md(raw, "demo").unwrap();
    assert!(
        f.description.starts_with('x') && f.description.contains('y'),
        "{:?}",
        f.description
    );
    let raw = "---\nname: demo\ndescription: >\n \u{3000}\u{3000}a\n  b\nmetadata:\n \u{3000}version: 1\n  version: 2.0.0\n---\n";
    let _ = validate_skill_md(raw, "demo");
}

#[test]
fn yaml_nulls_read_as_absent() {
    let raw = "---\nname: demo\ndescription: d\nlicense: ~\nversion: null\nmetadata:\n  version: Null\n---\n";
    let f = validate_skill_md(raw, "demo").unwrap();
    assert_eq!((f.license, f.version), (None, None));
    let e = validate_skill_md("---\nname: demo\ndescription: null\n---\n", "demo").unwrap_err();
    assert_eq!(
        e.reason,
        reason::PACKAGE_INVALID,
        "a null description is empty"
    );
    // A quoted "null" is the string.
    let f = validate_skill_md(
        "---\nname: demo\ndescription: d\nlicense: \"null\"\n---\n",
        "demo",
    )
    .unwrap();
    assert_eq!(f.license.as_deref(), Some("null"));
}

#[test]
fn normalise_skips_the_scan_skip_names_with_a_warning_and_keeps_the_hash_of_what_remains() {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path().join("demo-skip");
    write(&d, "SKILL.md", md("demo-skip", "d", "").as_bytes());
    write(&d, "references/a.md", b"a");
    write(&d, "__pycache__/m.pyc", b"junk");
    write(&d, "sub/.hg/store", b"junk");
    write(&d, ".svn", b"file");
    let mut out = Cursor::new(Vec::new());
    let (m, warnings) =
        normalise_skill_with_warnings(&SkillInput::Dir(d), CREATED, &mut out).unwrap();
    assert_eq!(
        m.files.keys().map(String::as_str).collect::<Vec<_>>(),
        ["payload/SKILL.md", "payload/references/a.md"]
    );
    for p in ["__pycache__", "sub/.hg", ".svn"] {
        assert!(warnings.iter().any(|w| w.contains(p)), "{p}: {warnings:?}");
    }
    // The same in a ZIP.
    let z = tmp.path().join("z.zip");
    let mut w = zip::ZipWriter::new(std::fs::File::create(&z).unwrap());
    let o = zip::write::SimpleFileOptions::default();
    for (n, b) in [
        ("demo-skip/SKILL.md", md("demo-skip", "d", "")),
        ("demo-skip/__pycache__/m.pyc", "x".into()),
    ] {
        w.start_file(n, o).unwrap();
        w.write_all(b.as_bytes()).unwrap();
    }
    w.finish().unwrap();
    let (m, warnings) =
        normalise_skill_with_warnings(&SkillInput::Zip(z), CREATED, &mut Cursor::new(Vec::new()))
            .unwrap();
    assert_eq!(m.files.len(), 1);
    assert!(warnings.iter().any(|w| w.contains("__pycache__")));
}

#[test]
fn a_script_extension_without_the_exec_bit_gets_the_scripts_capability_block() {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path().join("demo-helper");
    write(&d, "SKILL.md", md("demo-helper", "d", "").as_bytes());
    write(&d, "helper.py", b"print('hi')\n");
    let mut out = Cursor::new(Vec::new());
    let m = normalise_skill(&SkillInput::Dir(d), CREATED, &mut out).unwrap();
    assert!(
        m.scripts.is_empty(),
        "scripts[] stays the brief's set: {:?}",
        m.scripts
    );
    assert_eq!(m.capabilities["network"], json!({ "mode": "any" }));
    assert_eq!(m.capabilities["processes"], json!({ "spawn": true }));
    reparse(&out.into_inner());
}
