//! Parity mode B for the capability registry (P4-K K9b, plan P4-42): TypeScript writes `capabilities.sqlite` with the
//! product code, Rust opens a copy, reads what is there and continues it, and creates a fresh file; TypeScript then reads
//! both with the product code, continues them, and compares their schema text with its own
//! (`tests/core-parity/toolcall-b-driver.ts`). Needs Node (`PLUR1BUS_NODE` or `node` on PATH) with the workspace's
//! TypeScript sources, like the other mixed-language tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_core::budget::Clock;
use plur1bus_core::toolcall::capabilities::CapabilityStats;
use plur1bus_core::toolcall::json::{parse, V};
use plur1bus_core::toolcall::registry::SqliteCapabilityRegistry;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn driver(command: &str, dir: &Path) -> String {
    let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(&node)
        .current_dir(root())
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
            "tests/core-parity/toolcall-b-driver.ts",
            command,
        ])
        .arg(dir)
        .output()
        .unwrap_or_else(|e| {
            panic!("could not run Node {node:?}: {e}. Install Node and run `pnpm test:prep`.")
        });
    assert!(
        output.status.success(),
        "toolcall-b-driver {command}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

struct At(i64);

impl Clock for At {
    fn now(&self) -> i64 {
        self.0
    }
}

fn entry(id: &str, description: &str, version: &str) -> V {
    V::obj([
        ("id", V::s(id)),
        ("name", V::s(id)),
        ("description", V::s(description)),
        ("category", V::s("docs.create")),
        ("kind", V::s("tool")),
        ("effect", V::s("read")),
        ("risk", V::s("low")),
        ("source", V::s("rust")),
        ("version", V::s(version)),
    ])
}

fn stats(offered: f64, used: f64, found_by_search: f64, succeeded: f64) -> CapabilityStats {
    CapabilityStats {
        offered,
        used,
        found_by_search,
        succeeded,
    }
}

/// The four counters of a TypeScript answer (JSON does not tell `1` from `1.0`; the numbers are compared as doubles).
fn stats_of(v: &Value) -> CapabilityStats {
    let n = |key: &str| v[key].as_f64().unwrap();
    stats(n("offered"), n("used"), n("foundBySearch"), n("succeeded"))
}

fn floats(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_f64().unwrap())
        .collect()
}

fn as_json(v: &V) -> Value {
    serde_json::from_str(&v.stringify()).unwrap()
}

/// Rust's part on a file: a new entry with a counter and a vector.
fn write_rust_rows(registry: &mut SqliteCapabilityRegistry) {
    registry
        .upsert(&entry("rust_tool", "Rust written report tool", "1"))
        .unwrap();
    registry.record("rust_tool", "carol", "offered").unwrap();
    let hash = registry.hash("rust_tool").unwrap().unwrap();
    assert!(registry
        .put_vector("rust_tool", &hash, "model-r", &[0.5, 0.125])
        .unwrap());
}

#[test]
fn the_registry_file_is_shared_with_the_typescript_core() {
    let dir = tempfile::tempdir().unwrap();
    driver("prepare", dir.path());
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("manifest.json")).unwrap())
            .unwrap();
    let now = manifest["now"].as_i64().unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let from = dir.path().join(format!("capabilities-ts.sqlite{suffix}"));
        if from.exists() {
            std::fs::copy(
                &from,
                dir.path().join(format!("capabilities-rust.sqlite{suffix}")),
            )
            .unwrap();
        }
    }

    // Rust reads what TypeScript wrote.
    let mut registry = SqliteCapabilityRegistry::open(
        &dir.path().join("capabilities-rust.sqlite"),
        Arc::new(At(now)),
    )
    .unwrap();
    let snapshot = registry.snapshot().unwrap();
    assert_eq!(
        manifest["snapshot"],
        Value::Array(snapshot.iter().map(as_json).collect())
    );
    // The text of an entry is the text TypeScript stored, member order included.
    let stored = manifest["snapshot"][2].clone();
    assert_eq!(stored["id"], "ts_report");
    assert_eq!(
        parse(&snapshot[2].stringify()).unwrap().stringify(),
        snapshot[2].stringify()
    );
    for id in ["ts_report", "ts_file"] {
        assert_eq!(
            manifest["hashes"][id].as_str(),
            registry.hash(id).unwrap().as_deref(),
            "{id}: the stored hash"
        );
    }
    // Opening computes every entry's hash; had Rust computed another one, it would have dropped this vector.
    assert_eq!(
        registry.vector("ts_report", "model-a").unwrap(),
        Some(vec![0.1, -0.25, 1e-7, 3.0])
    );
    assert_eq!(
        registry.stats("ts_report", "alice").unwrap(),
        stats(3.0, 1.0, 0.0, 1.0)
    );
    assert_eq!(
        registry.stats("ts_report", "bob").unwrap(),
        stats(0.0, 0.0, 1.0, 0.0)
    );
    assert_eq!(registry.agents().unwrap(), ["alice", "bob"]);
    // One bucket is a day old (half its weight at a half-life of one day), the other is current.
    assert_eq!(
        registry
            .weighted_stats("ts_report", None, 1.0, None)
            .unwrap(),
        stats(2.0, 0.5, 0.5, 0.5)
    );
    assert_eq!(
        registry
            .weighted_stats("ts_report", Some("alice"), 1.0, None)
            .unwrap(),
        stats(2.0, 0.5, 0.0, 0.5)
    );
    let all: HashSet<String> = ["ts_report", "ts_file", "ts_old"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    let found: Vec<String> = registry
        .search("written report", &all, 12.0)
        .unwrap()
        .iter()
        .map(|e| e.get("id").unwrap().to_js_string().lossy())
        .collect();
    assert_eq!(found, ["ts_report"]);

    // Rust continues the file.
    write_rust_rows(&mut registry);
    registry.record("ts_report", "carol", "used").unwrap();
    registry
        .upsert(&entry(
            "ts_old",
            "A new version forgets the old counters",
            "2",
        ))
        .unwrap();
    registry.remove("ts_file").unwrap();
    drop(registry);

    // Rust makes a file of its own.
    let mut fresh = SqliteCapabilityRegistry::open(
        &dir.path().join("capabilities-fresh-rust.sqlite"),
        Arc::new(At(now)),
    )
    .unwrap();
    write_rust_rows(&mut fresh);
    drop(fresh);

    // TypeScript reads both, and continues them.
    let out: Value = serde_json::from_str(&driver("verify", dir.path())).unwrap();
    for name in ["capabilities-rust", "capabilities-fresh-rust"] {
        let file = &out[name];
        assert_eq!(
            file["schema"], true,
            "{name}: the schema text is TypeScript's"
        );
        assert_eq!(file["integrity"], "ok", "{name}");
        assert_eq!(file["journal"], "wal", "{name}");
        assert_eq!(file["userVersion"], 0, "{name}");
        assert_eq!(
            file["after"],
            json!({ "schema": true, "integrity": "ok" }),
            "{name}: after TypeScript wrote to it"
        );
        assert_eq!(floats(&file["vectorRust"]), [0.5, 0.125], "{name}");
        assert_eq!(
            stats_of(&file["again"][1]),
            stats(1.0, 1.0, 0.0, 0.0),
            "{name}: TypeScript counts on Rust's row"
        );
        assert_eq!(
            file["search"][0], "rust_tool",
            "{name}: the full-text rows Rust wrote are found"
        );
    }
    let continued = &out["capabilities-rust"];
    let ids: Vec<&str> = continued["snapshot"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["rust_tool", "ts_old", "ts_report"]);
    assert_eq!(
        continued["snapshot"][0],
        as_json(&entry("rust_tool", "Rust written report tool", "1"))
    );
    assert_eq!(
        continued["hashes"]["ts_report"],
        manifest["hashes"]["ts_report"]
    );
    assert_eq!(stats_of(&continued["alice"]), stats(3.0, 1.0, 0.0, 1.0));
    assert_eq!(stats_of(&continued["carol"]), stats(0.0, 1.0, 0.0, 0.0));
    assert_eq!(
        stats_of(&continued["old"]),
        stats(0.0, 0.0, 0.0, 0.0),
        "a new version forgot the counters"
    );
    assert_eq!(continued["agents"], json!(["alice", "bob", "carol"]));
    // Two days after the first bucket and one after the second, which now also holds Rust's `used`.
    assert_eq!(
        stats_of(&continued["weighted"]),
        stats(1.0, 0.75, 0.25, 0.25)
    );
    assert_eq!(floats(&continued["vectorA"]), [0.1, -0.25, 1e-7, 3.0]);
    assert_eq!(continued["again"][0], 4);
    let fresh = &out["capabilities-fresh-rust"];
    assert_eq!(
        fresh["snapshot"],
        json!([as_json(&entry(
            "rust_tool",
            "Rust written report tool",
            "1"
        ))])
    );
    assert_eq!(stats_of(&fresh["rustStats"]), stats(1.0, 0.0, 0.0, 0.0));
    assert_eq!(fresh["again"][0], 2);
}
