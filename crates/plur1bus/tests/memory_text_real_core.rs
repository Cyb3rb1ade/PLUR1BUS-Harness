//! `memory import-text` / `export-text` against the REAL core (`packages/core/dist/core.js`), not the fake one:
//! the CLI reaches it over the token socket with the default principal resolver, so the import, the export and the
//! rollback only succeed if that principal is a person (`guard.ts`: `LOCAL_OWNER`, `kind: "person"`).
mod common;

use serde_json::{json, Value};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

fn cli(home: &Path, args: &[&str]) -> (i32, Value, String) {
    let o = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--json")
        .arg("--home")
        .arg(home)
        .args(args)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&o.stdout).into_owned();
    let doc = serde_json::from_str(&stdout).unwrap_or(Value::Null);
    (
        o.status.code().unwrap_or(-1),
        doc,
        String::from_utf8_lossy(&o.stderr).into_owned(),
    )
}

#[test]
fn the_cli_reaches_a_real_core_as_a_person_import_export_and_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let directory = dir.path().canonicalize().unwrap();
    let home = directory.join("h");
    std::fs::create_dir_all(&home).unwrap();
    let mut config = serde_json::to_value(plur1bus_config::defaults()).unwrap();
    config["agents"]["main"] = json!({});
    config["engine"] =
        json!({"neo":{"enabled":false},"reranker":{"enabled":false},"dreaming":{"enabled":false}});
    std::fs::write(
        home.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let core_js = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/dist/core.js");
    // No skipping and no stale builds: a missing dist is a clear failure (CI runs `pnpm build` before cargo test).
    assert!(
        core_js.is_file(),
        "{} is missing: run `pnpm --filter @plur1bus/core build` before this test",
        core_js.display()
    );
    let built = std::fs::metadata(&core_js).unwrap().modified().unwrap();
    let newest_src = [
        "src/import/prompt/execute.ts",
        "src/import/prompt/recommend.ts",
        "src/rpc/methods.ts",
    ]
    .iter()
    .filter_map(|f| {
        std::fs::metadata(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/core")
                .join(f),
        )
        .and_then(|m| m.modified())
        .ok()
    })
    .max();
    if let Some(src) = newest_src {
        assert!(
            built >= src,
            "{} is older than the prompt-import sources: run `pnpm --filter @plur1bus/core build`",
            core_js.display()
        );
    }
    let _supervisor = common::start_with_core(
        &home,
        &directory.join("events.jsonl"),
        "0.2",
        &[
            ("PLUR1BUS_CORE_JS", core_js.to_str().unwrap()),
            ("PLUR1BUS_TEST_INTERNALS", "flat-embedder"),
        ],
    );
    let mut supervisor = common::client(&home);
    common::wait_child(
        &mut supervisor,
        "real core ready",
        Duration::from_secs(60),
        |child| child["process"]["state"] == "ready",
    );

    let input = directory.join("export.txt");
    std::fs::write(
        &input,
        "PLUR1BUS-MEMORY-EXPORT v1\n\
         ## Preferences\n\
         [2026-01-01] [memory] - Ich bevorzuge den dunklen Modus bei Nacht.\n\
         ## Projects\n\
         [2026-01-02] [memory] - Projekt Zeta verwendet Rust und Tokio.\n\
         STATUS: COMPLETE\n",
    )
    .unwrap();
    let file = input.to_str().unwrap();

    // preview: the core's recommendations are for a person, so the Projects entry is recommended for an agent
    let (code, plan, err) = cli(
        &home,
        &["memory", "import-text", "--file", file, "--dry-run"],
    );
    assert_eq!(code, 0, "{plan} {err}");
    assert_eq!(plan["entries"].as_array().unwrap().len(), 2, "{plan}");
    assert_eq!(plan["targets"][1]["target"], "agent", "{plan}");
    // Projects without any workspace option: only an agent target (or a skip) is ever planned
    assert!(!plan.to_string().contains("workspace"), "{plan}");
    assert_eq!(plan["targets"][1]["agentIds"], json!(["main"]), "{plan}");

    // apply: refused by the core unless the caller is a person ("only human persons may perform memory import")
    let (code, applied, err) = cli(
        &home,
        &[
            "memory",
            "import-text",
            "--file",
            file,
            "--yes",
            "--all-preferences-to-user",
        ],
    );
    assert_eq!(code, 0, "{applied} {err}");
    assert_eq!(applied["imported"], 2, "{applied}");
    let run_id = applied["runId"].as_str().unwrap().to_string();

    // export: user scope of the calling person, agent-private with --agent
    let (code, exported, err) = cli(&home, &["memory", "export-text", "--agent", "main"]);
    assert_eq!(code, 0, "{exported} {err}");
    let text = exported["text"].as_str().unwrap();
    assert!(text.contains("dunklen Modus"), "{text}");
    assert!(text.contains("Projekt Zeta"), "{text}");

    // rollback: everything goes back and the counters say so
    let (code, rolled, err) = cli(
        &home,
        &["memory", "import-text", "--rollback", &run_id, "--yes"],
    );
    assert_eq!(code, 0, "{rolled} {err}");
    assert_eq!(rolled["rolledBack"], 2, "{rolled}");
    assert_eq!(rolled["remaining"], 0, "{rolled}");
    assert_eq!(rolled["failed"], 0, "{rolled}");
    assert_eq!(rolled["preservedUserScope"], 0, "{rolled}");
    let (_, after, _) = cli(&home, &["memory", "export-text", "--agent", "main"]);
    assert!(
        !after["text"]
            .as_str()
            .unwrap_or("")
            .contains("Projekt Zeta"),
        "{after}"
    );
}
