//! RE-D174: the hop budget of the engine process, measured over the real socket.
//!
//! `cargo test --release -p plur1bus-engine --test hop_budget -- --ignored --nocapture`
//!
//! The measurement spawns the real engine binary with the flat-embedder seam and a minimal
//! Core peer (workspace directory, events), then times blocking round trips of the Rust
//! `Client`: 10,000 `engine.status` and 1,000 `engine.recall` calls after an uncounted warm-up.
//! `engine.status` is the bare hop and must stay at or below 5 ms at p99 (ruling E8); the
//! recall figures are recorded, with the engine's own `timing.totalMs` subtracted as an
//! estimate of the hop. A recall answered with a degradation or `composition-pending` voids
//! the measurement. Only the percentile function runs by default.
#![cfg(any(unix, windows))]
// Process fixtures panic on a failed setup or RPC answer so a measurement cannot pass vacuously.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[allow(
    dead_code,
    reason = "This integration test uses only part of the shared engine process fixture."
)]
mod rpc_process_support;

use plur1bus_engine::contract::MemoryRow;
use plur1bus_engine::embedding::VectorSpaceIdentity;
use plur1bus_engine::store::Store;
use plur1bus_rpc::server_transport::Listener;
use rpc_process_support::{home, process_test, EngineProcess};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const STATUS_WARMUP: usize = 500;
const STATUS_RUNS: usize = 10_000;
const RECALL_WARMUP: usize = 50;
const RECALL_RUNS: usize = 1_000;
/// The binding limit for the bare hop (`engine.status`), in milliseconds.
const STATUS_P99_LIMIT_MS: f64 = 5.0;
const AGENT: &str = "hop-bench";
const CORE_TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

/// Nearest-rank percentile of an ascending slice, as `scripts/bench/metrics.mjs` computes it.
fn nearest_rank(sorted: &[f64], fraction: f64) -> f64 {
    assert!(!sorted.is_empty(), "no samples");
    let rank = (fraction * sorted.len() as f64).ceil() as usize;
    sorted[rank.max(1) - 1]
}

struct Summary {
    p50: f64,
    p99: f64,
    max: f64,
}

fn summarize(samples: &[f64]) -> Summary {
    assert!(
        samples
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0),
        "invalid sample"
    );
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Summary {
        p50: nearest_rank(&sorted, 0.50),
        p99: nearest_rank(&sorted, 0.99),
        max: *sorted.last().unwrap(),
    }
}

#[test]
fn nearest_rank_matches_the_bench_metrics_definition() {
    let samples: Vec<f64> = (1..=100).rev().map(f64::from).collect();
    let summary = summarize(&samples);
    assert_eq!((summary.p50, summary.p99, summary.max), (50.0, 99.0, 100.0));
    // One sample, and a rank that rounds up (ceil(0.99 * 10) = 10): outliers are kept.
    let one = summarize(&[7.5]);
    assert_eq!((one.p50, one.p99, one.max), (7.5, 7.5, 7.5));
    let ten: Vec<f64> = (1..=10).map(f64::from).collect();
    let summary = summarize(&ten);
    assert_eq!((summary.p50, summary.p99), (5.0, 10.0));
}

type Closer = Arc<dyn Fn() + Send + Sync>;

/// A Core peer that serves exactly what a recall needs: authentication, a workspace
/// directory, and event/backlog sinks.
struct CorePeer {
    stop: Arc<AtomicBool>,
    closers: Arc<Mutex<Vec<Closer>>>,
    thread: Option<JoinHandle<()>>,
}

impl CorePeer {
    fn start(home: &Path, engine_token: &str, workspace: &Path) -> Self {
        let run = home.join("run");
        plur1bus_engine::store::paths::secure_dir(&run).unwrap();
        let address = plur1bus_engine::rpc::layout::unit_address(home, "core");
        #[cfg(unix)]
        let _ = fs::remove_file(&address);
        let listener = Listener::bind(&address).unwrap();
        fs::write(run.join("core.token"), CORE_TOKEN).unwrap();
        fs::write(
            run.join("core.pid"),
            format!("{} hop-budget-core\n", std::process::id()),
        )
        .unwrap();
        for file in [run.join("core.token"), run.join("core.pid")] {
            plur1bus_engine::store::paths::secure_file(&file).unwrap();
        }
        let stop = Arc::new(AtomicBool::new(false));
        let closers: Arc<Mutex<Vec<Closer>>> = Arc::new(Mutex::new(Vec::new()));
        let (stopped, active) = (stop.clone(), closers.clone());
        let expected_auth = json!({
            "token": engine_token,
            "engine": {"clientId": "plur1bus-engine", "token": engine_token}
        });
        let workspace = workspace.to_str().unwrap().to_owned();
        let thread = thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                let Ok(Some(connection)) = listener.accept_timeout(Duration::from_millis(25))
                else {
                    continue;
                };
                connection.set_read_timeout(None).unwrap();
                active.lock().unwrap().push(connection.closer.clone());
                let mut reader = BufReader::new(connection.reader);
                let mut writer = connection.writer;
                let mut authed = false;
                loop {
                    let mut line = String::new();
                    if matches!(reader.read_line(&mut line), Ok(0) | Err(_)) {
                        break;
                    }
                    let request: Value = serde_json::from_str(&line).unwrap();
                    let method = request["method"].as_str().unwrap_or_default();
                    let result: Result<Value, &str> = if method == "core.auth" {
                        authed = request["params"] == expected_auth;
                        if authed {
                            Ok(json!({"contract": "1.17.0", "rpc": "1.17.0",
                                "instanceId": "hop-budget-core", "pid": std::process::id()}))
                        } else {
                            Err("E_UNAUTHORIZED")
                        }
                    } else if !authed {
                        Err("E_DENIED")
                    } else {
                        match method {
                            "events.subscribe" => Ok(json!({"subscriptionId": "hop-budget"})),
                            "host.workspaceDir" => Ok(json!({"path": workspace})),
                            "host.event" => Ok(json!({})),
                            "host.journalBacklog" => Ok(Value::Null),
                            _ => Err("E_DENIED"),
                        }
                    };
                    let response = match result {
                        Ok(value) => {
                            json!({"jsonrpc": "2.0", "id": request["id"], "result": value})
                        }
                        Err(code) => json!({"jsonrpc": "2.0", "id": request["id"],
                            "error": {"code": -32000, "message": "refused",
                                "data": {"error": code, "reason": "refused"}}}),
                    };
                    if writeln!(writer, "{response}").is_err() || writer.flush().is_err() {
                        break;
                    }
                }
                (connection.closer)();
            }
        });
        Self {
            stop,
            closers,
            thread: Some(thread),
        }
    }
}

impl Drop for CorePeer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for closer in self.closers.lock().unwrap().drain(..) {
            closer();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn memory_row(index: usize, vector: Vec<f32>) -> MemoryRow {
    let schema: Value =
        serde_json::from_str(include_str!("../schema/engine-contract.schema.json")).unwrap();
    let mut fields = serde_json::Map::new();
    for (name, definition) in schema["$defs"]["MemoryRow"]["properties"]
        .as_object()
        .unwrap()
    {
        fields.insert(
            name.clone(),
            match definition["type"].as_str().unwrap() {
                "string" => json!(""),
                "number" => json!(0),
                "boolean" => json!(false),
                "array" => json!([]),
                _ => Value::Null,
            },
        );
    }
    let mut row: MemoryRow = serde_json::from_value(Value::Object(fields)).unwrap();
    row.id = format!("11111111-1111-4111-8111-{index:012}");
    row.agent_id = AGENT.into();
    row.scope = "agent-private".into();
    row.category = "decision".into();
    row.text = format!("The synthetic project archive keeps fixture decision number {index}.");
    row.status = "active".into();
    row.vector = vector;
    row
}

/// Seed a few cards into the agent store the engine will serve, in the configured space.
fn seed_store(home: &Path, space: &VectorSpaceIdentity, dimensions: usize) {
    let path = home.join("state/lancedb/current").join(AGENT);
    let store = Store::create(&path, space, dimensions).unwrap();
    let rows: Vec<MemoryRow> = (0..8)
        .map(|index| {
            let mut vector = vec![0.0_f32; dimensions];
            vector[0] = 1.0;
            memory_row(index, vector)
        })
        .collect();
    store.upsert(&rows).unwrap();
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn recall_params() -> Value {
    json!({"query": {
        "query": "synthetic project archive decision",
        "principal": {"agentId": AGENT, "workspace": format!("workspace:v1:{}", "b".repeat(64)),
            "channel": "cli", "accountId": "hop-budget",
            "chat": {"id": "hop-budget", "kind": "direct"}, "trust": "inferred"},
        "agent": {"origin": "user", "background": false}
    }, "options": {"reranker": "off"}})
}

fn line(label: &str, summary: &Summary, runs: usize) {
    println!(
        "{label:<22} n={runs:<6} p50={:.3} ms  p99={:.3} ms  max={:.3} ms",
        summary.p50, summary.p99, summary.max
    );
}

#[test]
#[ignore = "measurement: run with --release -- --ignored --nocapture"]
fn engine_hop_budget_over_the_process_socket() {
    let _serial = process_test();
    let home = home();

    // First start only reads the configured vector space to seed the store.
    let mut first = EngineProcess::start_with_seam(home.path(), "flat-embedder");
    let identities = first
        .connect()
        .call("engine.embedding.identities", json!({}))
        .unwrap();
    let identity = identities.as_array().unwrap().first().unwrap().clone();
    let dimensions = usize::try_from(identity["dimensions"].as_u64().unwrap()).unwrap();
    let space: VectorSpaceIdentity = serde_json::from_value(identity["space"].clone()).unwrap();
    first.connect().call("engine.shutdown", json!({})).unwrap();
    assert!(first.wait_for_exit().success(), "{}", first.diagnostics());
    drop(first);
    seed_store(home.path(), &space, dimensions);

    let workspace = tempfile::Builder::new()
        .prefix("hb-ws-")
        .tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap())
        .unwrap();
    let mut engine = EngineProcess::start_with_seam(home.path(), "flat-embedder");
    let _core = CorePeer::start(home.path(), &engine.token(), workspace.path());
    let mut client = engine.connect();
    client
        .call("engine.open", json!({"agentId": AGENT}))
        .unwrap();

    // The recall must be served for real: no degradation, no composition-pending, cards back.
    let params = recall_params();
    let deadline = Instant::now() + Duration::from_secs(30);
    let probe = loop {
        let result = client.call("engine.recall", params.clone()).unwrap();
        if result["degraded"].is_null() {
            break result;
        }
        assert!(
            Instant::now() < deadline,
            "recall stayed degraded, the measurement does not count: {}",
            result["degraded"]
        );
        thread::sleep(Duration::from_millis(100));
    };
    assert!(
        probe["blocks"].as_array().is_some_and(|b| !b.is_empty()),
        "recall returned no blocks: {probe}"
    );
    let status = client.call("engine.status", json!({})).unwrap();
    assert_ne!(
        status["degraded"]["reason"], "composition-pending",
        "{status}"
    );
    println!("engine.status degraded: {}", status["degraded"]);

    for _ in 0..STATUS_WARMUP {
        client.call("engine.status", json!({})).unwrap();
    }
    let mut status_ms = Vec::with_capacity(STATUS_RUNS);
    for _ in 0..STATUS_RUNS {
        let started = Instant::now();
        client.call("engine.status", json!({})).unwrap();
        status_ms.push(millis(started.elapsed()));
    }

    for _ in 0..RECALL_WARMUP {
        client.call("engine.recall", params.clone()).unwrap();
    }
    let mut recall_ms = Vec::with_capacity(RECALL_RUNS);
    let mut hop_ms = Vec::with_capacity(RECALL_RUNS);
    let mut work_ms = Vec::with_capacity(RECALL_RUNS);
    for _ in 0..RECALL_RUNS {
        let started = Instant::now();
        let result = client.call("engine.recall", params.clone()).unwrap();
        let roundtrip = millis(started.elapsed());
        assert!(
            result["degraded"].is_null(),
            "a degraded recall voids the measurement: {}",
            result["degraded"]
        );
        let total = result["timing"]["totalMs"].as_f64().unwrap();
        recall_ms.push(roundtrip);
        work_ms.push(total);
        // Clamped at zero: the engine's clock and ours are not the same instrument.
        hop_ms.push((roundtrip - total).max(0.0));
    }

    let status_summary = summarize(&status_ms);
    let recall_summary = summarize(&recall_ms);
    println!("--- hop budget (RE-D174) ---");
    line("engine.status", &status_summary, STATUS_RUNS);
    line("engine.recall", &recall_summary, RECALL_RUNS);
    line("recall timing.totalMs", &summarize(&work_ms), RECALL_RUNS);
    line("recall hop estimate", &summarize(&hop_ms), RECALL_RUNS);

    client.call("engine.shutdown", json!({})).unwrap();
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
    assert!(
        status_summary.p99 <= STATUS_P99_LIMIT_MS,
        "engine.status p99 {:.3} ms exceeds the {STATUS_P99_LIMIT_MS} ms hop budget (RE-D1 reopens)",
        status_summary.p99
    );
}
