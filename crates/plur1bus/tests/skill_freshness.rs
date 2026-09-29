//! Freshness test for the `plur1bus-ops` operations skill (2a-H3b-b Task 9, spec §9, D4, D66,
//! criterion 10). This never trusts the skill's prose: every `plur1bus ` command line inside a
//! ```sh fence in `skills/plur1bus-ops/SKILL.md`, its three playbooks, or `docs/operations.md` is
//! checked against the real CLI (`--help` on its command path), required to carry `--json`, and a
//! fixed set of read-only ones are actually run against a temp home with no daemon. Separately,
//! every check id (`1staid check`'s `CHECK_IDS`), `CrashReason` value and RPC `ErrorCode` must be
//! named somewhere in the skill or a playbook, and every repair step id (`STEP_ORDER`) must be
//! named in `playbooks/repair.md`.
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn repo_root() -> PathBuf {
    // crates/plur1bus -> repo root
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn bin() -> PathBuf {
    assert_cmd::cargo::cargo_bin("plur1bus")
}

/// The skill's own files, in the fixed order the plan names them: `SKILL.md`, the three
/// playbooks, then the human doc. `read` fails loudly (not skips) when one is missing: a missing
/// file is exactly what this test exists to catch.
fn skill_files() -> Vec<(&'static str, String)> {
    let root = repo_root();
    [
        "skills/plur1bus-ops/SKILL.md",
        "skills/plur1bus-ops/playbooks/diagnose.md",
        "skills/plur1bus-ops/playbooks/configure.md",
        "skills/plur1bus-ops/playbooks/repair.md",
        "docs/operations.md",
    ]
    .iter()
    .map(|rel| {
        let text =
            fs::read_to_string(root.join(rel)).unwrap_or_else(|e| panic!("reading {rel}: {e}"));
        (*rel, text)
    })
    .collect()
}

/// Every line starting with `plur1bus ` inside a ```sh fence of `text`.
fn sh_command_lines(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut in_sh_block = false;
    for raw in text.lines() {
        let trimmed = raw.trim();
        if let Some(lang) = trimmed.strip_prefix("```") {
            if in_sh_block {
                in_sh_block = false;
            } else if lang.trim() == "sh" {
                in_sh_block = true;
            }
            continue;
        }
        if in_sh_block && trimmed.starts_with("plur1bus ") {
            lines.push(trimmed.to_string());
        }
    }
    lines
}

/// The text of every inline code span of `text` that starts with `plur1bus ` (outside fences too).
fn inline_command_spans(text: &str) -> Vec<String> {
    text.split('`')
        .skip(1)
        .step_by(2)
        .filter(|s| s.starts_with("plur1bus "))
        .map(str::to_string)
        .collect()
}

/// The command path of a collected line: the subcommand words after `plur1bus`, stopping at the
/// first token that is a flag (`-...`), a placeholder (`<...>`) or a quoted value (`"..."`/`'...'`)
/// — exactly the "strips arguments that are not flags or subcommands" rule (Task 9 interfaces).
/// Every example in the skill and its playbooks is written so a real positional value is always
/// placeholder- or quote-wrapped, so this never mistakes an argument for a subcommand word.
fn command_path(line: &str) -> Vec<String> {
    line.split_whitespace()
        .skip(1)
        .take_while(|t| {
            !t.starts_with('-')
                && !t.starts_with('<')
                && !t.starts_with('"')
                && !t.starts_with('\'')
        })
        .map(|s| s.to_string())
        .collect()
}

fn run(mut cmd: Command) -> (i32, String, String) {
    let out: Output = cmd.output().expect("spawn plur1bus");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    )
}

fn json_schema_field(stdout: &str) -> Option<String> {
    let v: Value = serde_json::from_str(stdout).ok()?;
    v.get("schema")?.as_str().map(str::to_string)
}

#[test]
fn skill_names_only_real_json_commands_and_covers_every_check_crash_reason_error_and_repair_step() {
    let files = skill_files();
    let mut all_lines: Vec<(&str, String)> = Vec::new();
    for (name, text) in &files {
        for line in sh_command_lines(text) {
            all_lines.push((name, line));
        }
    }
    assert!(
        !all_lines.is_empty(),
        "no `plur1bus ` example command found in the skill or its docs"
    );

    // (b) every collected line carries --json.
    for (file, line) in &all_lines {
        assert!(
            line.contains("--json"),
            "{file}: example line does not pass --json: {line:?}"
        );
    }

    // (a) `plur1bus <path> --help` exits 0 for every distinct command path.
    let mut paths: BTreeSet<Vec<String>> = BTreeSet::new();
    for (_, line) in &all_lines {
        let path = command_path(line);
        assert!(!path.is_empty(), "no subcommand in example: {line:?}");
        paths.insert(path);
    }
    for path in &paths {
        let mut cmd = Command::new(bin());
        cmd.args(path).arg("--help");
        let (code, stdout, stderr) = run(cmd);
        assert_eq!(
            code, 0,
            "`plur1bus {} --help` failed (stale command in the skill?): stdout={stdout:?} stderr={stderr:?}",
            path.join(" ")
        );
    }

    // (a') every inline `plur1bus …` code span in prose and tables (the hints a person follows) names a real command
    // path too, for each `a|b` alternative of a word.
    let mut inline_paths: BTreeSet<Vec<String>> = BTreeSet::new();
    for (_, text) in &files {
        for span in inline_command_spans(text) {
            let mut alts: Vec<Vec<String>> = vec![vec![]];
            for word in command_path(&span) {
                alts = alts
                    .into_iter()
                    .flat_map(|p| {
                        word.split('|').map(move |w| {
                            let mut p = p.clone();
                            p.push(w.to_string());
                            p
                        })
                    })
                    .collect();
            }
            inline_paths.extend(alts.into_iter().filter(|p| !p.is_empty()));
        }
    }
    for path in inline_paths.difference(&paths) {
        let mut cmd = Command::new(bin());
        cmd.args(path).arg("--help");
        let (code, stdout, stderr) = run(cmd);
        assert_eq!(
            code, 0,
            "`plur1bus {} --help` failed (an inline command in the skill names no real command): stdout={stdout:?} stderr={stderr:?}",
            path.join(" ")
        );
    }

    // (c) the read-only commands actually run against a temp home with no daemon and print JSON
    // with a "schema" string.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("h");
    fs::create_dir_all(&home).unwrap();
    let manifest_fixture = repo_root().join("crates/plur1bus/tests/fixtures/release/stable.json");
    assert!(
        manifest_fixture.is_file(),
        "expected fixture at {manifest_fixture:?}"
    );

    let read_only: &[&[&str]] = &[
        &["1staid", "check", "--json"],
        &["1staid", "repair", "--dry-run", "--json"],
        &["daemon", "status", "--json"],
        &["config", "get", "--json"],
        &["module", "list", "--json"],
        &["module", "graph", "--json"],
    ];
    for args in read_only {
        let mut cmd = Command::new(bin());
        cmd.arg("--home").arg(&home).args(*args);
        let (code, stdout, stderr) = run(cmd);
        let schema = json_schema_field(&stdout).unwrap_or_else(|| {
            panic!(
                "`plur1bus {}` did not print JSON with a \"schema\" string: code={code} stdout={stdout:?} stderr={stderr:?}",
                args.join(" ")
            )
        });
        assert!(!schema.is_empty());
    }
    // `update --check` needs a real manifest argument; kept separate since it is not a bare flag list.
    {
        let mut cmd = Command::new(bin());
        cmd.arg("--home")
            .arg(&home)
            .args(["update", "--check", "--manifest"])
            .arg(&manifest_fixture)
            .arg("--json");
        let (code, stdout, stderr) = run(cmd);
        let schema = json_schema_field(&stdout).unwrap_or_else(|| {
            panic!(
                "`plur1bus update --check --manifest <fixture>` did not print JSON with a \"schema\" string: code={code} stdout={stdout:?} stderr={stderr:?}"
            )
        });
        assert!(!schema.is_empty());
    }
    // No daemon or run files were started by any of the read-only commands above.
    assert!(
        !home.join("run").exists() || fs::read_dir(home.join("run")).unwrap().next().is_none(),
        "a read-only command left files under run/"
    );

    let corpus: String = files
        .iter()
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    // (d) every `1staid check` id, every `CrashReason` value and every RPC `ErrorCode` appears in
    // the skill or a playbook. `1staid check --json` (run above) is the live source for the ids,
    // so this can never drift from the real check list; `CrashReason`/`ErrorCode` come straight
    // from the RPC schema, the single source of truth for both languages (AGENTS.md).
    let check_out = run({
        let mut cmd = Command::new(bin());
        cmd.arg("--json")
            .arg("--home")
            .arg(&home)
            .args(["1staid", "check"]);
        cmd
    });
    let check_doc: Value = serde_json::from_str(&check_out.1).expect("1staid check --json");
    let check_ids: Vec<String> = check_doc["checks"]
        .as_array()
        .expect("checks array")
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_string())
        .collect();
    assert!(check_ids.len() >= 18, "{check_ids:?}");
    for id in &check_ids {
        assert!(
            corpus.contains(id.as_str()),
            "check id {id:?} is not named in the skill or a playbook"
        );
    }

    let schema_path = repo_root().join("packages/rpc-schema/schema/rpc.schema.json");
    let schema_text = fs::read_to_string(&schema_path).unwrap_or_else(|e| {
        panic!("reading {schema_path:?}: {e}");
    });
    let schema: Value = serde_json::from_str(&schema_text).unwrap();
    let defs = &schema["$defs"];

    let crash_reasons: Vec<String> = defs["CrashReason"]["enum"]
        .as_array()
        .expect("$defs/CrashReason enum")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(!crash_reasons.is_empty());
    for reason in &crash_reasons {
        assert!(
            corpus.contains(reason.as_str()),
            "CrashReason value {reason:?} is not named in the skill or a playbook"
        );
    }

    let error_codes: Vec<String> = defs["ErrorCode"]["enum"]
        .as_array()
        .expect("$defs/ErrorCode enum")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(!error_codes.is_empty());
    for code in &error_codes {
        assert!(
            corpus.contains(code.as_str()),
            "RPC error code {code:?} is not named in the skill or a playbook"
        );
    }

    // (e) every repair `STEP_ORDER` id appears in `playbooks/repair.md`. Task 7/8 (`crates/plur1bus/src/repair/`)
    // are not merged into this branch yet, so there is no live constant to read; this list is the literal
    // `STEP_ORDER` from the plan (`docs/superpowers/plans/2026-09-27-m1b-2a-h3b-b.md` Task 7's interfaces,
    // extended by Task 8), which is binding and frozen for this plan.
    const STEP_ORDER: &[&str] = &[
        "run.permissions.fix",
        "run.stale-files.remove",
        "config.restore",
        "service.renew",
        "runtime.node.reinstall",
        "runtime.core.reinstall",
        "unit.terminate-hung",
        "store.migrate",
        "service.silent-exit",
        "service.restart-loop",
    ];
    let repair_text = files
        .iter()
        .find(|(name, _)| *name == "skills/plur1bus-ops/playbooks/repair.md")
        .map(|(_, t)| t.as_str())
        .unwrap();
    for id in STEP_ORDER {
        assert!(
            repair_text.contains(id),
            "repair step {id:?} is not named in playbooks/repair.md"
        );
    }
}
