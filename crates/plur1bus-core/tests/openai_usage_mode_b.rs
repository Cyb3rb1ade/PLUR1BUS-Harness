//! Parity mode B for the ChatGPT-plan usage book (`openai-plan-usage.sqlite`, P4-K K4): TypeScript writes the file with the
//! product code, Rust reads and writes a copy and creates a fresh file, TypeScript reads both again and compares the schema
//! text of the Rust files with its own (`tests/core-parity/openai-usage-b-driver.ts`). Needs Node (`PLUR1BUS_NODE` or `node`
//! on PATH) with the workspace's TypeScript sources, like the other mixed-language tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_core::provider_auth::openai::usage::{PlanUsage, PlanUsageStore, UsageError};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn driver(command: &str, dir: &Path) -> Value {
    let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(&node)
        .current_dir(root())
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
            "tests/core-parity/openai-usage-b-driver.ts",
            command,
        ])
        .arg(dir)
        .output()
        .unwrap_or_else(|e| {
            panic!("could not run Node {node:?}: {e}. Install Node and run `pnpm test:prep`.")
        });
    assert!(
        output.status.success(),
        "openai-usage-b-driver {command}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn total(s: &PlanUsageStore, person: &str) -> Value {
    s.total(person).unwrap().json()
}

#[test]
fn the_plan_usage_book_round_trips_between_typescript_and_rust() {
    let dir = tempfile::tempdir().unwrap();
    let ts = driver("prepare", dir.path());
    assert!(
        ts["refused"].as_str().unwrap().starts_with("RangeError"),
        "{}",
        ts["refused"]
    );

    // Rust reads what TypeScript wrote: the same totals, unknown usage left unknown, the repeated id ignored.
    let copy = dir.path().join("usage-rust.sqlite");
    std::fs::copy(dir.path().join("usage-ts.sqlite"), &copy).unwrap();
    let mut s = PlanUsageStore::open(&copy).unwrap();
    for p in ["alice", "bob", "carol"] {
        assert_eq!(total(&s, p), ts["totals"][p], "{p}");
    }
    // Rust writes: a new call, a repeated TypeScript id (kept as it was), unknown usage, a refused count.
    s.record(
        "call-5",
        "alice",
        "cred-a",
        "fixture-model",
        PlanUsage {
            input_tokens: Some(5.0),
            output_tokens: Some(6.0),
        },
        2_000,
    )
    .unwrap();
    s.record(
        "call-1",
        "alice",
        "cred-a",
        "fixture-model",
        PlanUsage {
            input_tokens: Some(1e6),
            output_tokens: None,
        },
        2_001,
    )
    .unwrap();
    s.record(
        "call-6",
        "carol",
        "cred-c",
        "fixture-model",
        PlanUsage::default(),
        2_002,
    )
    .unwrap();
    for bad in [-1.0, 1.5, 9_007_199_254_740_992.0, f64::NAN] {
        let refused = s.record(
            "call-7",
            "carol",
            "cred-c",
            "m",
            PlanUsage {
                input_tokens: Some(bad),
                output_tokens: None,
            },
            2_003,
        );
        assert_eq!(refused, Err(UsageError::Invalid));
    }
    drop(s);
    let mut fresh = PlanUsageStore::open(&dir.path().join("usage-fresh-rust.sqlite")).unwrap();
    fresh
        .record(
            "call-9",
            "bob",
            "cred-b",
            "fixture-model",
            PlanUsage {
                input_tokens: Some(1.0),
                output_tokens: Some(2.0),
            },
            3_000,
        )
        .unwrap();
    drop(fresh);

    // TypeScript reads both Rust files with the product code, and their schema is the TypeScript text.
    let back = driver("verify", dir.path());
    assert_eq!(
        back["rust"]["totals"]["alice"],
        json!({ "unit": "plan_tokens", "inputTokens": 15, "outputTokens": 26, "calls": 3 })
    );
    assert_eq!(back["rust"]["totals"]["bob"], ts["totals"]["bob"]);
    assert_eq!(
        back["rust"]["totals"]["carol"],
        json!({ "unit": "plan_tokens", "inputTokens": null, "outputTokens": null, "calls": 1 })
    );
    assert_eq!(
        back["fresh"]["totals"]["bob"],
        json!({ "unit": "plan_tokens", "inputTokens": 1, "outputTokens": 2, "calls": 1 })
    );
    assert_eq!(back["rust"]["rows"].as_array().unwrap().len(), 5);
    assert_eq!(
        back["rust"]["rows"][0], ts["rows"][0],
        "the TypeScript row stays as it was"
    );
    assert_eq!(back["schema"]["rust"], back["schema"]["ref"]);
    assert_eq!(back["schema"]["fresh"], back["schema"]["ref"]);
    assert_eq!(back["schema"]["ref"], ts["schema"]);
}
