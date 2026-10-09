//! Keeps `docs/errors.md` and `docs/cli.md` in step with the sources (no network, no wall clock).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

/// `E_*` codes that exist only as fixtures in a unit test of an unknown-code path, not as codes anyone is told about.
const TEST_FIXTURE_CODES: &[&str] = &["E_NOPE"];

fn rs_files(dir: &Path, acc: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            rs_files(&p, acc);
        } else if p.extension().is_some_and(|x| x == "rs") {
            acc.push(p);
        }
    }
}

/// Whole words of the form `E_[A-Z0-9_]+` (at least one character after the underscore).
fn error_words(text: &str) -> BTreeSet<String> {
    text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| {
            w.len() > 2
                && w.starts_with("E_")
                && w[2..]
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                && w[2..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_uppercase())
        })
        .map(str::to_string)
        .collect()
}

fn source_codes() -> BTreeSet<String> {
    let mut files = Vec::new();
    for krate in std::fs::read_dir(repo_root().join("crates")).unwrap() {
        let src = krate.unwrap().path().join("src");
        if src.is_dir() {
            rs_files(&src, &mut files);
        }
    }
    assert!(files.len() > 50, "sanity: found {} sources", files.len());
    let mut codes = BTreeSet::new();
    for f in files {
        codes.extend(error_words(&std::fs::read_to_string(f).unwrap()));
    }
    for fixture in TEST_FIXTURE_CODES {
        codes.remove(*fixture);
    }
    codes
}

fn documented_codes() -> BTreeSet<String> {
    let text = std::fs::read_to_string(repo_root().join("docs/errors.md")).unwrap();
    // Table rows only: "| `E_CODE` | exit | meaning |".
    text.lines()
        .filter_map(|l| l.strip_prefix("| `"))
        .filter_map(|l| l.split('`').next())
        .filter(|c| c.starts_with("E_"))
        .map(str::to_string)
        .collect()
}

#[test]
fn every_error_code_in_the_sources_is_documented() {
    let missing: Vec<_> = source_codes()
        .difference(&documented_codes())
        .cloned()
        .collect();
    assert!(missing.is_empty(), "docs/errors.md lacks: {missing:?}");
}

#[test]
fn every_documented_error_code_exists_in_the_sources() {
    let stale: Vec<_> = documented_codes()
        .difference(&source_codes())
        .cloned()
        .collect();
    assert!(
        stale.is_empty(),
        "docs/errors.md lists codes no source uses: {stale:?}"
    );
}

#[test]
fn the_word_scanner_only_takes_whole_error_codes() {
    let found = error_words("x(\"E_LOCKED\") ERROR_PIPE_BUSY FILE_E_X E_ E_a E_1 \"E_NOT_FOUND\"");
    assert_eq!(
        found.into_iter().collect::<Vec<_>>(),
        vec!["E_LOCKED".to_string(), "E_NOT_FOUND".to_string()]
    );
}

#[test]
fn docs_cli_md_is_the_current_generated_reference() {
    let bin = env!("CARGO_BIN_EXE_plur1bus");
    let out = std::process::Command::new(bin)
        .arg("__markdown")
        .output()
        .unwrap();
    assert!(out.status.success());
    let generated = String::from_utf8(out.stdout).unwrap().replace("\r\n", "\n");
    let doc = std::fs::read_to_string(repo_root().join("docs/cli.md"))
        .unwrap()
        .replace("\r\n", "\n");
    assert!(
        doc.ends_with(&generated),
        "docs/cli.md is stale: run `pnpm docs:gen` (scripts/gen-docs.mjs)"
    );
}
