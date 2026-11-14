//! Replay of the sequences recorded from the TypeScript card sensitivity store and service
//! (`scripts/parity/export-sensitivity.ts`, `fixtures/parity/sensitivity/`): every step's result or error and the content of
//! the table afterwards, with the clock of the step. Recorded, never edited by hand. Plus what the recording cannot hold: the
//! file is created by SQLite in an existing directory and not in a missing one, with no mode of its own, and the filter of
//! `memory-exposure/sensitivity.ts` run over the real service.
use super::scanner::MemorySensitivityRecord;
use super::sensitivity::{filter_sensitive_blocks, sensitivity_refusal, Block, SensitivityRefusal};
use super::sensitivity_service::{
    CardText, LocalModelClassifier, MemorySensitivityService, ModelFailure, ServiceOptions,
};
use super::sensitivity_store::{MemorySensitivityStore, SensitivityError};
use plur1bus_store::rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;

const TABLE: &str = "card_sensitivity";

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/sensitivity/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_owned())
        .collect()
}

/// A JavaScript number that holds an integer prints as one.
fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9.1e15 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

fn record_json(r: &MemorySensitivityRecord) -> Value {
    json!({
        "cardId": r.card_id, "contentHash": r.content_hash, "categories": r.categories,
        "source": r.source, "updatedAt": num(r.updated_at),
    })
}

fn opt_record(r: Option<MemorySensitivityRecord>) -> Value {
    r.map_or(Value::Null, |r| record_json(&r))
}

fn value_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => json!(n),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => json!(b),
    }
}

/// The error of a step as the exporter records it: the extended result code SQLite raised.
fn error_json(e: &SensitivityError) -> Value {
    match e.sqlite_code() {
        Some(code) => json!({ "sqlite": code }),
        None => panic!("an error the recording cannot hold: {e}"),
    }
}

/// `SELECT * FROM card_sensitivity ORDER BY 1` over a separate connection; `None` while there is no table.
fn dump(file: &Path) -> Option<Value> {
    let conn = Connection::open(file).ok()?;
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {TABLE} ORDER BY 1"))
        .ok()?;
    let width = stmt.column_count();
    let rows = stmt
        .query_map([], |row| {
            Ok(Value::Array(
                (0..width)
                    .map(|i| value_json(row.get_ref(i).unwrap()))
                    .collect(),
            ))
        })
        .ok()?;
    Some(Value::Array(rows.map(Result::unwrap).collect()))
}

struct World {
    file: PathBuf,
    clock: Rc<Cell<i64>>,
    svc: Option<MemorySensitivityService>,
    model: Rc<RefCell<Value>>,
    seen: Rc<RefCell<Vec<Value>>>,
    last: Value,
}

impl World {
    fn new(file: PathBuf) -> World {
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        World {
            file,
            clock: Rc::new(Cell::new(0)),
            svc: None,
            model: Rc::new(RefCell::new(Value::Null)),
            seen: Rc::new(RefCell::new(Vec::new())),
            last: json!([]),
        }
    }

    fn svc(&self) -> &MemorySensitivityService {
        self.svc.as_ref().expect("no open service")
    }

    fn open(&mut self, with_model: bool) {
        let store = MemorySensitivityStore::open(&self.file).unwrap();
        let clock = Rc::clone(&self.clock);
        let (model, seen) = (Rc::clone(&self.model), Rc::clone(&self.seen));
        let hook: Option<LocalModelClassifier> = with_model.then(|| {
            Box::new(move |text: &str, summary: Option<&str>| {
                seen.borrow_mut().push(json!([text, summary]));
                let script = model.borrow();
                if script.is_null() {
                    return Ok(Vec::new());
                }
                if script.get("throws").is_some() {
                    return Err(ModelFailure);
                }
                Ok(strs(&script["cats"]))
            }) as LocalModelClassifier
        });
        self.svc = Some(
            MemorySensitivityService::new(ServiceOptions {
                store,
                clock: Box::new(move || clock.get()),
                scanner: None,
                local_model_classifier: hook,
            })
            .unwrap(),
        );
    }

    /// One call; `Err` is an error the store raised.
    fn call(&mut self, op: &str, a: &Value, at: i64) -> Result<Value, SensitivityError> {
        let now = a.get("nowMs").map_or(at, |n| n.as_i64().unwrap());
        let category = a.get("category").and_then(Value::as_str);
        Ok(match op {
            "seed" | "sql" => {
                Connection::open(&self.file)
                    .unwrap()
                    .execute_batch(a["text"].as_str().unwrap())
                    .unwrap();
                Value::Null
            }
            "pragma" => {
                let conn = Connection::open(&self.file).unwrap();
                let name = a["name"].as_str().unwrap();
                conn.pragma_query_value(None, name, |row| Ok(value_json(row.get_ref(0)?)))
                    .unwrap()
            }
            "model" => {
                *self.model.borrow_mut() = a["model"].clone();
                Value::Null
            }
            "open" => {
                self.open(a.get("model").and_then(Value::as_bool).unwrap_or(false));
                Value::Null
            }
            "close" => {
                self.svc.take().expect("no open service").close();
                Value::Null
            }
            "store.get" => opt_record(self.svc().store().get(a["cardId"].as_str().unwrap())?),
            "store.getByHash" => opt_record(
                self.svc()
                    .store()
                    .get_by_hash(a["contentHash"].as_str().unwrap())?,
            ),
            "store.set" => record_json(&self.svc().store().set(
                a["cardId"].as_str().unwrap(),
                &strs(&a["categories"]),
                a["source"].as_str().unwrap(),
                a["contentHash"].as_str().unwrap(),
                now,
            )?),
            "store.clear" => {
                let out = self
                    .svc()
                    .store()
                    .clear(a["cardId"].as_str().unwrap(), category, now)?;
                json!({ "cleared": out.cleared, "remaining": out.remaining })
            }
            "store.hasManualCategories" => {
                json!(self
                    .svc()
                    .store()
                    .has_manual_categories(&strs(&a["categories"]))?)
            }
            "assessCard" => {
                let card = &a["card"];
                json!(self.svc().assess_card(
                    card["id"].as_str().unwrap(),
                    card["text"].as_str().unwrap(),
                    card.get("summary").and_then(Value::as_str),
                )?)
            }
            "assessAggregate" => json!(self.svc().assess_aggregate(
                a["text"].as_str().unwrap(),
                a.get("summary").and_then(Value::as_str)
            )),
            "setSensitivity" => {
                let card = a.get("card").map(|c| CardText {
                    text: c["text"].as_str().unwrap(),
                    summary: c.get("summary").and_then(Value::as_str),
                });
                record_json(&self.svc().set_sensitivity(
                    a["cardId"].as_str().unwrap(),
                    &strs(&a["categories"]),
                    card,
                )?)
            }
            "clearSensitivity" => {
                let out = self
                    .svc()
                    .clear_sensitivity(a["cardId"].as_str().unwrap(), category)?;
                json!({ "cleared": out.cleared, "remaining": out.remaining })
            }
            "hasManualCategories" => {
                json!(self.svc().has_manual_categories(&strs(&a["categories"]))?)
            }
            "getSensitivity" => {
                opt_record(self.svc().get_sensitivity(a["cardId"].as_str().unwrap())?)
            }
            other => panic!("unknown op {other}"),
        })
    }

    /// Replays one step; what differs from the recording is returned, not asserted, so a run reports every divergent step.
    fn step(&mut self, scenario: &str, i: usize, line: &str) -> Vec<String> {
        let step: Value = serde_json::from_str(line).unwrap();
        let op = step["op"].as_str().unwrap();
        let at = step["at"].as_i64().unwrap();
        let where_ = format!("{scenario} step {i} ({op} {})", step["args"]);
        let mut problems = Vec::new();
        self.clock.set(at);
        self.seen.borrow_mut().clear();
        let out = match self.call(op, &step["args"], at) {
            Ok(v) => json!({ "ok": v }),
            Err(e) => json!({ "err": error_json(&e) }),
        };
        if out != step["out"] {
            problems.push(format!("{where_}: result {out} against {}", step["out"]));
        }
        let seen = Value::Array(self.seen.borrow().clone());
        let want_seen = step.get("seen").cloned().unwrap_or(json!([]));
        if seen != want_seen {
            problems.push(format!(
                "{where_}: what the model hook saw {seen} against {want_seen}"
            ));
        }
        let rows = if self.file.exists() {
            dump(&self.file)
        } else {
            None
        };
        match step.get("tables") {
            Some(tables) => {
                if rows.as_ref() != Some(&tables[TABLE]) {
                    problems.push(format!(
                        "{where_}: table after the step {rows:?} against {}",
                        tables[TABLE]
                    ));
                }
                self.last = tables[TABLE].clone();
            }
            // A step that records no table left it as it was (and a table that cannot be read changes nothing).
            None => {
                if !(rows.is_none() || rows.as_ref() == Some(&self.last)) {
                    problems.push(format!(
                        "{where_}: table changed: {rows:?} against {}",
                        self.last
                    ));
                    if let Some(rows) = rows {
                        self.last = rows;
                    }
                }
            }
        }
        problems
    }
}

#[test]
fn every_recorded_step_replays() {
    let file = load("scenarios");
    let dir = tempfile::tempdir().unwrap();
    let mut steps = 0;
    let mut problems: Vec<String> = Vec::new();
    for (n, scenario) in file["scenarios"].as_array().unwrap().iter().enumerate() {
        let name = scenario["name"].as_str().unwrap();
        let mut world = World::new(
            dir.path()
                .join(format!("s{n}"))
                .join("memory-sensitivity.sqlite"),
        );
        for (i, line) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            problems.extend(world.step(name, i, line.as_str().unwrap()));
            steps += 1;
        }
    }
    assert!(
        problems.is_empty(),
        "{} of {steps} steps differ; the first: {:#?}",
        problems.len(),
        &problems[..problems.len().min(6)]
    );
    assert!(steps >= 200, "{steps} steps replayed");
}

/// A fresh store has the schema, the pragmas and the column order the TypeScript store has (`schema.json`).
#[test]
fn a_fresh_store_equals_the_recorded_schema() {
    let recorded = load("schema");
    let dir = tempfile::tempdir().unwrap();
    let store =
        MemorySensitivityStore::open(&dir.path().join("memory-sensitivity.sqlite")).unwrap();
    let conn = store.conn();
    let mut stmt = conn
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .unwrap();
    let master: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(json!({
                "type": value_json(row.get_ref(0)?), "name": value_json(row.get_ref(1)?),
                "tbl_name": value_json(row.get_ref(2)?), "sql": value_json(row.get_ref(3)?),
            }))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(Value::Array(master), recorded["master"], "sqlite_master");
    let columns: Vec<String> = conn
        .prepare(&format!("PRAGMA table_info({TABLE})"))
        .unwrap()
        .query_map([], |row| row.get(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        json!({ TABLE: columns }),
        recorded["columns"],
        "column order"
    );
    let mut pragmas = serde_json::Map::new();
    for name in [
        "journal_mode",
        "foreign_keys",
        "busy_timeout",
        "synchronous",
        "user_version",
    ] {
        let v = conn
            .pragma_query_value(None, name, |row| Ok(value_json(row.get_ref(0)?)))
            .unwrap();
        pragmas.insert(name.to_owned(), v);
    }
    assert_eq!(Value::Object(pragmas), recorded["pragmas"], "pragmas");
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o7777
}

/// SQLite creates a missing file in an existing directory; no directory is created; no mode is set (the file has the mode
/// SQLite gives a file it creates, compared with a plain connection's file next to it).
#[cfg(unix)]
#[test]
fn the_file_is_created_by_sqlite_without_a_directory_or_a_mode() {
    let dir = tempfile::tempdir().unwrap();
    let dir_mode = mode(dir.path());
    let file = dir.path().join("memory-sensitivity.sqlite");
    drop(MemorySensitivityStore::open(&file).unwrap());
    assert!(file.is_file());
    let plain = dir.path().join("plain.sqlite");
    drop(Connection::open(&plain).unwrap());
    assert!(plain.is_file());
    assert_eq!(
        mode(&file),
        mode(&plain),
        "no chmod: the mode SQLite gives a new file"
    );
    assert_eq!(mode(dir.path()), dir_mode, "the directory keeps its mode");
    let missing = dir
        .path()
        .join("no-such-dir")
        .join("memory-sensitivity.sqlite");
    assert!(MemorySensitivityStore::open(&missing).is_err());
    assert!(
        !dir.path().join("no-such-dir").exists(),
        "no directory is created"
    );
}

struct Text(&'static str);

impl Block for Text {
    fn text(&self) -> &str {
        self.0
    }
}

impl Clone for Text {
    fn clone(&self) -> Self {
        Text(self.0)
    }
}

/// The exposure filter reads the real service: a manual label in the filter refuses, the rules classify a block.
#[test]
fn the_exposure_filter_reads_the_service() {
    let dir = tempfile::tempdir().unwrap();
    let store =
        MemorySensitivityStore::open(&dir.path().join("memory-sensitivity.sqlite")).unwrap();
    let svc = MemorySensitivityService::new(ServiceOptions {
        store,
        clock: Box::new(|| 1),
        scanner: None,
        local_model_classifier: None,
    })
    .unwrap();
    let filter = vec!["health".to_owned()];
    let blocks = [Text("Diagnose: Diabetes"), Text("Water the plants")];
    let kept = filter_sensitive_blocks(&blocks, &filter, Some(&svc)).unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].0, "Water the plants");
    assert_eq!(sensitivity_refusal(&filter, Some(&svc)).unwrap(), None);
    svc.set_sensitivity("m1", &filter, None).unwrap();
    assert_eq!(
        sensitivity_refusal(&filter, Some(&svc)).unwrap(),
        Some(SensitivityRefusal::NotEnforceable)
    );
    assert!(filter_sensitive_blocks(&blocks, &filter, Some(&svc))
        .unwrap()
        .is_empty());
}
