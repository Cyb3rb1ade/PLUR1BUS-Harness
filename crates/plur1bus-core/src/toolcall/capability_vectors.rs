//! Replays `fixtures/parity/capabilities/*.json` (mode V, `scripts/parity/export-capabilities.ts`): the two math
//! functions bit for bit, the calibration file and the usage prior, and scripted operations against the index with every
//! answer as the text TypeScript printed.
use super::capabilities::{
    load_calibration, usage_prior, CapabilityEntry, CapabilityIndex, CapabilityStats,
    EmbeddingPort, LexicalPort, PriorPort, SearchFilters,
};
use super::json::V;
use super::math::{js_log, js_pow2};
use super::registry::{RegistryError, RegistryEvent, SqliteCapabilityRegistry};
use super::validation::Thrown;
use super::vectors::{expect, value_of};
use crate::budget::Clock;
use plur1bus_store::rusqlite::types::ValueRef;
use plur1bus_store::rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

pub(super) fn fixture(name: &str) -> Value {
    let text = match name {
        "math" => include_str!("../../../../fixtures/parity/capabilities/math.json"),
        "calibration" => include_str!("../../../../fixtures/parity/capabilities/calibration.json"),
        "index" => include_str!("../../../../fixtures/parity/capabilities/index.json"),
        "registry" => include_str!("../../../../fixtures/parity/capabilities/registry.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

fn pair(case: &Value) -> (f64, f64) {
    let (x, y) = case.as_str().unwrap().split_once(':').unwrap();
    let bits = |hex: &str| f64::from_bits(u64::from_str_radix(hex, 16).unwrap());
    (bits(x), bits(y))
}

#[test]
fn math_log_is_fdlibm_bit_for_bit() {
    let f = fixture("math");
    let cases = f["log"].as_array().unwrap();
    assert!(cases.len() > 1000);
    for c in cases {
        let (x, want) = pair(c);
        let got = js_log(x);
        assert!(
            got.to_bits() == want.to_bits() || (got.is_nan() && want.is_nan()),
            "log({x:e}): {got:e} ({:016x}), TypeScript {want:e} ({:016x})",
            got.to_bits(),
            want.to_bits()
        );
    }
}

#[test]
fn math_pow2_of_an_integer_is_exact() {
    let f = fixture("math");
    for c in f["pow2"].as_array().unwrap() {
        let (x, want) = pair(c);
        assert_eq!(js_pow2(x).to_bits(), want.to_bits(), "2 ** {x:e}");
    }
}

fn number(v: &V, key: &str) -> f64 {
    v.get(key).and_then(V::as_f64).unwrap()
}

#[test]
fn calibration_file_and_usage_prior() {
    let f = fixture("calibration");
    let load = f["load"].as_array().unwrap();
    for (i, c) in load.iter().enumerate() {
        let content = c[0].as_str().unwrap();
        // The first case is the built-in default (no file).
        let got = load_calibration((i > 0).then_some(content));
        let printed = got.map(|config| {
            let source = if i > 0 {
                content
            } else {
                super::capabilities::CALIBRATION_DEFAULTS
            };
            // TypeScript returns the parsed object itself; its members are the configuration's seven numbers.
            let parsed = super::json::parse(source.trim_start_matches('\u{feff}'))
                .expect("an accepted file parses");
            for (key, want) in [
                ("minOffers", config.min_offers),
                ("maxBonus", config.max_bonus),
                ("maxPenalty", config.max_penalty),
                ("halfLifeDays", config.half_life_days),
                ("successTarget", config.success_target),
                ("successWeight", config.success_weight),
                ("searchWeight", config.search_weight),
            ] {
                assert_eq!(
                    number(&parsed, key).to_bits(),
                    want.to_bits(),
                    "{content}: {key}"
                );
            }
            parsed.stringify()
        });
        expect(&format!("calibration {content:?}"), &c[1], printed);
    }
    let stats = |text: &str| {
        let v = value_of(text);
        CapabilityStats {
            offered: number(&v, "offered"),
            used: number(&v, "used"),
            found_by_search: number(&v, "foundBySearch"),
            succeeded: number(&v, "succeeded"),
        }
    };
    for c in f["prior"].as_array().unwrap() {
        let config = load_calibration(Some(c[2].as_str().unwrap())).expect("a valid configuration");
        let got = usage_prior(
            &stats(c[0].as_str().unwrap()),
            &stats(c[1].as_str().unwrap()),
            &config,
        );
        assert_eq!(
            c[3].as_str().unwrap(),
            V::Num(got).stringify(),
            "prior of {} / {} with {}",
            c[0],
            c[1],
            c[2]
        );
    }
}

struct Table(HashMap<String, f64>);

impl EmbeddingPort for Table {
    fn score(&self, _query: &str, _entries: &[&CapabilityEntry]) -> HashMap<String, f64> {
        self.0.clone()
    }
}

fn table(world: &Value, key: &str) -> Option<HashMap<String, f64>> {
    world.get(key).map(|t| {
        t.as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_f64().unwrap()))
            .collect()
    })
}

fn filters_of(v: Option<&Value>) -> SearchFilters {
    let text = |key: &str| {
        v.and_then(|f| f.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    SearchFilters {
        category: text("category"),
        kind: text("kind"),
        effect: text("effect"),
        source: text("source"),
        limit: v.and_then(|f| f.get("limit")).and_then(Value::as_f64),
    }
}

#[test]
fn index_scenarios() {
    let f = fixture("index");
    for scenario in f["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let world = &scenario["world"];
        let embedding =
            table(world, "embedding").map(|t| Box::new(Table(t)) as Box<dyn EmbeddingPort>);
        let lexical = table(world, "lexical").map(|t| {
            Box::new(move |_query: &str, entries: &[&CapabilityEntry]| {
                entries
                    .iter()
                    .filter_map(|e| t.get(&e.id()).map(|score| (e.id(), *score)))
                    .collect()
            }) as LexicalPort
        });
        let prior = table(world, "prior").map(|t| {
            Box::new(move |e: &CapabilityEntry| t.get(&e.id()).copied().unwrap_or(0.0)) as PriorPort
        });
        let mut index = CapabilityIndex::new(embedding, lexical, prior);
        let ops = scenario["ops"].as_array().unwrap();
        for (i, (op, want)) in ops
            .iter()
            .zip(scenario["steps"].as_array().unwrap())
            .enumerate()
        {
            let null = || Ok("null".to_owned());
            let got: Result<String, Thrown> = match op["op"].as_str().unwrap() {
                "upsert" => index
                    .upsert(&value_of(op["entry"].as_str().unwrap()))
                    .and_then(|()| null()),
                "remove" => {
                    index.remove(op["id"].as_str().unwrap());
                    null()
                }
                "search" => index
                    .search(
                        op["query"].as_str().unwrap(),
                        &filters_of(op.get("filters")),
                    )
                    .map(|hits| V::Arr(hits.iter().map(|h| h.to_v()).collect()).stringify()),
                "rank" => index
                    .search(op["query"].as_str().unwrap(), &SearchFilters::default())
                    .map(|hits| {
                        V::Arr(
                            hits.into_iter()
                                .map(|hit| V::Str(hit.entry.id().into()))
                                .collect(),
                        )
                        .stringify()
                    }),
                "route" => {
                    let distribution: Vec<(String, f64)> = op["distribution"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|p| (p[0].as_str().unwrap().to_owned(), p[1].as_f64().unwrap()))
                        .collect();
                    let top_k = op.get("topK").and_then(Value::as_f64).unwrap_or(12.0);
                    let confidence = op.get("confidence").and_then(Value::as_f64).unwrap_or(1.0);
                    index
                        .route(
                            op["query"].as_str().unwrap(),
                            &distribution,
                            top_k,
                            confidence,
                        )
                        .map(|r| r.to_v().stringify())
                }
                "prefix" => Ok(V::s(&index.categories_prefix()).stringify()),
                other => panic!("unknown op {other}"),
            };
            expect(&format!("{name} #{i} {op}"), want, got);
        }
    }
}

pub(super) struct TestClock(pub AtomicI64);

impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

fn cell(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => json!(b),
    }
}

fn rows(conn: &Connection, sql: &str) -> Value {
    let mut statement = conn.prepare(sql).unwrap();
    let width = statement.column_count();
    let mut out = Vec::new();
    let mut found = statement.query([]).unwrap();
    while let Some(row) = found.next().unwrap() {
        out.push(Value::Array(
            (0..width).map(|i| cell(row.get_ref(i).unwrap())).collect(),
        ));
    }
    Value::Array(out)
}

/// What `dumpRegistry` of the exporter records: every row raw, the full-text rows, the schema text, the journal mode.
pub(super) fn dump_registry(path: &Path) -> Value {
    let conn = Connection::open(path).unwrap();
    let mut tables = serde_json::Map::new();
    for table in [
        "capability_index",
        "capability_stats",
        "capability_usage",
        "capability_hashes",
        "capability_vectors",
    ] {
        tables.insert(
            table.to_owned(),
            rows(&conn, &format!("SELECT * FROM {table} ORDER BY rowid")),
        );
    }
    tables.insert(
        "capability_fts".to_owned(),
        rows(
            &conn,
            "SELECT rowid, id, text FROM capability_fts ORDER BY rowid",
        ),
    );
    let schema = rows(&conn, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
    let journal: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    json!({ "tables": tables, "schema": schema, "journal": journal, "userVersion": version })
}

fn refused(e: RegistryError) -> Thrown {
    match e {
        RegistryError::Refused(thrown) => thrown,
        RegistryError::Store(message) => panic!("store error: {message}"),
    }
}

#[test]
fn registry_scenarios() {
    let f = fixture("registry");
    for scenario in f["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("capabilities.sqlite");
        let clock = Arc::new(TestClock(AtomicI64::new(
            scenario["start"].as_i64().unwrap(),
        )));
        let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let open = || {
            let mut registry = SqliteCapabilityRegistry::open(&path, clock.clone()).unwrap();
            let log = events.clone();
            registry.subscribe(Box::new(move |event: &RegistryEvent| {
                log.lock().unwrap().push(match event {
                    RegistryEvent::Upsert(entry) => json!(["upsert", entry.text()]),
                    RegistryEvent::Remove(id) => json!(["remove", id]),
                });
            }));
            registry
        };
        let mut registry = open();
        for (i, (op, want)) in scenario["ops"]
            .as_array()
            .unwrap()
            .iter()
            .zip(scenario["steps"].as_array().unwrap())
            .enumerate()
        {
            let before = events.lock().unwrap().len();
            let text = |key: &str| op[key].as_str().unwrap();
            let null = "null".to_owned();
            let stats = |s: CapabilityStats| {
                V::obj([
                    ("offered", V::Num(s.offered)),
                    ("used", V::Num(s.used)),
                    ("foundBySearch", V::Num(s.found_by_search)),
                    ("succeeded", V::Num(s.succeeded)),
                ])
                .stringify()
            };
            let got: Result<String, RegistryError> = match text("op") {
                "upsert" => registry.upsert(&value_of(text("entry"))).map(|()| null),
                "remove" => registry.remove(text("id")).map(|()| null),
                "record" => registry
                    .record(text("id"), text("agent"), text("event"))
                    .map(|()| null),
                "stats" => registry.stats(text("id"), text("agent")).map(stats),
                "weighted" => registry
                    // A half-life the fixture could not hold as a number (`1e400`) arrives as `null`.
                    .weighted_stats(
                        text("id"),
                        op.get("agent").and_then(Value::as_str),
                        op["halfLifeDays"].as_f64().unwrap_or(f64::INFINITY),
                        op.get("now").and_then(Value::as_f64),
                    )
                    .map(stats),
                "agents" => registry.agents().map(|a| V::strs(&a).stringify()),
                "search" => {
                    let allowed: HashSet<String> = op["allowed"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|s| s.as_str().unwrap().to_owned())
                        .collect();
                    registry
                        .search(
                            text("query"),
                            &allowed,
                            op.get("limit").and_then(Value::as_f64).unwrap_or(12.0),
                        )
                        .map(|found| {
                            V::Arr(
                                found
                                    .iter()
                                    .map(|e| e.get("id").cloned().unwrap_or(V::Null))
                                    .collect(),
                            )
                            .stringify()
                        })
                }
                "putVector" => {
                    let hash = match text("hash") {
                        "$hash" => registry.hash(text("id")).unwrap().unwrap_or_default(),
                        other => other.to_owned(),
                    };
                    // `1e400` in the vector text is an infinity once parsed, as in TypeScript.
                    let vector: Vec<f64> = value_of(text("vector"))
                        .as_arr()
                        .unwrap()
                        .iter()
                        .map(|n| n.as_f64().unwrap())
                        .collect();
                    registry
                        .put_vector(text("id"), &hash, text("model"), &vector)
                        .map(|stored| stored.to_string())
                }
                "vector" => registry.vector(text("id"), text("model")).map(|v| {
                    v.map_or(null, |list| {
                        V::Arr(list.into_iter().map(V::Num).collect()).stringify()
                    })
                }),
                "hash" => registry
                    .hash(text("id"))
                    .map(|h| h.map_or(null, |h| V::s(&h).stringify())),
                "snapshot" => registry.snapshot().map(|list| V::Arr(list).stringify()),
                "advance" => Ok((clock
                    .0
                    .fetch_add(op["ms"].as_i64().unwrap(), Ordering::SeqCst)
                    + op["ms"].as_i64().unwrap())
                .to_string()),
                "reopen" => {
                    drop(registry);
                    registry = open();
                    Ok(null)
                }
                other => panic!("unknown op {other}"),
            };
            expect(
                &format!("{name} #{i} {op}"),
                &want["out"],
                got.map_err(refused),
            );
            let told: Vec<Value> = events.lock().unwrap()[before..].to_vec();
            assert_eq!(
                want.get("events").cloned().unwrap_or_else(|| json!([])),
                Value::Array(told),
                "{name} #{i} {op}: what subscribers were told"
            );
        }
        drop(registry);
        assert_eq!(
            scenario["after"],
            dump_registry(&path),
            "{name}: the file TypeScript left and the file Rust left"
        );
    }
}
