//! `plur1bus import` (docs/import.md §8, §9): the Rust side's plumbing against a fake importer
//! (`tests/fixtures/fake-import.mjs`), plus one end-to-end run of the real `packages/core/dist/import.js`
//! (`pnpm build` first, as CI does) on a small synthetic OpenClaw state dir.
use assert_cmd::Command;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn bin() -> Command {
    Command::cargo_bin("plur1bus").unwrap()
}

fn fake() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-import.mjs")
}

fn json_of(out: &[u8]) -> Value {
    serde_json::from_slice(out)
        .unwrap_or_else(|e| panic!("not JSON ({e}): {}", String::from_utf8_lossy(out)))
}

#[test]
fn hermes_full_import_forwards_to_importer() {
    let home = tempfile::tempdir().unwrap();
    let out = bin()
        .env("PLUR1BUS_IMPORT_JS", fake())
        .env("PLUR1BUS_NODE", "node")
        .arg("--home")
        .arg(home.path())
        .args([
            "--json",
            "import",
            "hermes",
            "--conflict",
            "replace",
            "--adopt-store",
            "/path/to/store",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v = json_of(&out);
    let argv: Vec<String> = serde_json::from_value(v["argv"].clone()).unwrap();
    assert_eq!(
        &argv[..5],
        [
            "hermes",
            "--on-conflict",
            "replace",
            "--adopt-store",
            "/path/to/store"
        ]
    );
}

#[test]
fn openclaw_full_import_forwards_to_importer() {
    let home = tempfile::tempdir().unwrap();
    let out = bin()
        .env("PLUR1BUS_IMPORT_JS", fake())
        .env("PLUR1BUS_NODE", "node")
        .arg("--home")
        .arg(home.path())
        .args(["--json", "import", "openclaw", "--conflict", "replace"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v = json_of(&out);
    let argv: Vec<String> = serde_json::from_value(v["argv"].clone()).unwrap();
    assert_eq!(&argv[..3], ["openclaw", "--on-conflict", "replace"]);
}

#[test]
fn forwards_flags_and_inserts_the_schema() {
    let home = tempfile::tempdir().unwrap();
    let out = bin()
        .env("PLUR1BUS_IMPORT_JS", fake())
        .env("PLUR1BUS_NODE", "node")
        .arg("--home")
        .arg(home.path())
        .args([
            "--json", "import", "openclaw", "--detect", "--source", "/src",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v = json_of(&out);
    assert_eq!(v["schema"], "import.detect/1");
    let argv: Vec<String> = serde_json::from_value(v["argv"].clone()).unwrap();
    assert_eq!(&argv[..4], ["openclaw", "--detect", "--source", "/src"]);
    assert_eq!(argv[4], "--home");
    assert!(Path::new(&argv[5]).ends_with(home.path().file_name().unwrap()));
}

#[test]
fn prints_the_human_rendering_without_json() {
    bin()
        .env("PLUR1BUS_IMPORT_JS", fake())
        .env("PLUR1BUS_NODE", "node")
        .args(["import", "hermes", "--detect"])
        .assert()
        .success()
        .stdout("FAKE HUMAN SUMMARY\n");
}

#[test]
fn maps_an_error_envelope_to_an_error_document() {
    let out = bin()
        .env("PLUR1BUS_IMPORT_JS", fake())
        .env("PLUR1BUS_NODE", "node")
        .env("FAKE_IMPORT_MODE", "error")
        .args(["--json", "import", "hermes", "--detect"])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();
    let v = json_of(&out);
    assert_eq!(v["schema"], "error/1");
    assert_eq!(v["error"], "E_SOURCE_UNSUPPORTED");
    assert_eq!(v["reason"], "version-undeterminable");
}

#[test]
fn a_crash_or_a_missing_importer_is_e_import_failed() {
    let out = bin()
        .env("PLUR1BUS_IMPORT_JS", fake())
        .env("PLUR1BUS_NODE", "node")
        .env("FAKE_IMPORT_MODE", "crash")
        .args(["--json", "import", "hermes", "--detect"])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    assert_eq!(json_of(&out)["reason"], "importer-crashed");
    let out = bin()
        .env("PLUR1BUS_IMPORT_JS", "/nonexistent/import.js")
        .args(["--json", "import", "hermes", "--detect"])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    assert_eq!(json_of(&out)["reason"], "importer-missing");
}

/// The real importer, built by `pnpm build` (CI builds the TypeScript packages before `cargo test`).
fn real_importer() -> PathBuf {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/dist/import.js");
    assert!(
        p.exists(),
        "{} is missing: run `pnpm build` before `cargo test`",
        p.display()
    );
    p
}

#[cfg(unix)]
#[test]
fn hermes_dry_run_prints_report_with_errors_and_exits_one() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("hermes");
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("config.yaml"), "_config_version: 45\n").unwrap();
    std::fs::write(src.join("persona.md"), "synthetic persona\n").unwrap();
    std::os::unix::fs::symlink(src.join("persona.md"), src.join("SOUL.md")).unwrap();

    for json in [true, false] {
        let mut cmd = bin();
        cmd.timeout(std::time::Duration::from_secs(30))
            .env("PLUR1BUS_IMPORT_JS", real_importer())
            .env("PLUR1BUS_NODE", "node")
            .arg("--home")
            .arg(&home);
        if json {
            cmd.arg("--json");
        }
        let output = cmd
            .args(["import", "hermes", "--source"])
            .arg(&src)
            .assert()
            .code(1)
            .get_output()
            .stdout
            .clone();
        if json {
            let report = json_of(&output);
            assert_eq!(report["schema"], "import.hermes/1");
            assert_eq!(report["mode"], "dry-run");
            assert_eq!(report["profilesOrAgents"][0]["harnessAgentId"], "default");
            assert_eq!(report["errors"].as_array().unwrap().len(), 1);
            assert_eq!(report["errors"][0]["sourceRef"], "default:SOUL.md");
            assert_eq!(report["errors"][0]["reason"], "unsafe-symlink");
        } else {
            let human = String::from_utf8(output).unwrap();
            assert!(human.contains("DRY RUN"));
            assert!(human.contains("Profiles / Agents (1)"));
            assert!(human.contains("Summary:"));
            assert!(human.contains("Errors:"));
            assert!(human.contains("default:SOUL.md: unsafe-symlink"));
        }
        assert!(!home.exists(), "dry run wrote to the harness home");
    }
}

#[test]
fn detects_and_imports_skills_end_to_end_with_the_real_importer() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("state");
    let home = tmp.path().join("home");
    std::fs::create_dir_all(src.join("workspace/skills/hello")).unwrap();
    std::fs::write(
        src.join("openclaw.json"),
        "{ meta: { lastTouchedVersion: '2026.9.5' } }",
    )
    .unwrap();
    std::fs::write(
        src.join("workspace/skills/hello/SKILL.md"),
        "---\nname: hello\ndescription: Say hello\n---\n# Hello\n",
    )
    .unwrap();
    let run = |args: &[&str]| {
        let mut cmd = bin();
        cmd.env("PLUR1BUS_IMPORT_JS", real_importer())
            .env("PLUR1BUS_NODE", "node")
            .arg("--home")
            .arg(&home)
            .args(["--json", "import", "openclaw"]);
        if !args.contains(&"--rollback") {
            cmd.arg("--source").arg(&src);
        }
        let out = cmd
            .args(args)
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        json_of(&out)
    };
    let d = run(&["--detect"]);
    assert_eq!(d["schema"], "import.detect/1");
    assert_eq!(d["version"]["release"], "2026.9.5");
    assert_eq!(d["skills"][0]["id"], "hello");
    assert_eq!(d["skills"][0]["plannedAction"], "import");
    assert!(!home.exists(), "detect wrote to the harness home");
    let s = run(&["--skills", "--apply"]);
    assert_eq!(s["schema"], "import.skills/1");
    assert_eq!(s["skills"][0]["outcome"], "imported");
    let idx: Value =
        serde_json::from_str(&std::fs::read_to_string(home.join("skills/index.json")).unwrap())
            .unwrap();
    assert_eq!(idx["skills"][0]["id"], "hello");
    assert_eq!(idx["skills"][0]["enabled"], false);
    let report = s["reportPath"].as_str().unwrap().to_string();
    let r = run(&["--rollback", &report, "--apply"]);
    assert_eq!(r["schema"], "import.rollback/1");
    assert!(!home.join("skills").exists());
}
