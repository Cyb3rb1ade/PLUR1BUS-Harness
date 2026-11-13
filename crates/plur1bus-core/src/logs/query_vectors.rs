//! Replay of the parity vectors recorded from the TypeScript log query and `logs.*` handlers
//! (`scripts/parity/export-logs.ts`, `fixtures/parity/logs/{query,methods}.json`). Vectors are recorded, never edited by
//! hand.
//!
//! A scan case is a set of files (lists of segments: text, a run of one character, or a generated stamped-line file),
//! then steps: query, append, rotate. The recorded output of every query step is compared as a whole, the cursor and the
//! bytes scanned included, so the engine reads exactly what the TypeScript engine reads. Object keys of a record are
//! compared as values (a `serde_json::Map` is sorted, the TypeScript object keeps insertion order).
use super::files::Stream;
use super::levels::{LevelSettings, Source};
use super::methods::{
    AbortSignal, Actor, AuditEvent, AuditSink, CallContext, LevelsParams, LogsDeps, LogsError,
    LogsMethods, LogsParams,
};
use super::query::{
    decode_cursor, fingerprint, iso_string, mint_cursor, run_query, stream_name, CursorError, Key,
    LogFilter, Order, QueryError, QueryOptions, QueryResult,
};
use super::sink::SinkHooks;
use super::writer::{Writer, WriterOptions};
use plur1bus_log_schema::Level;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

/// `Date.UTC(2026, 9, 7, 9, 0, 0)`.
const QBASE: i64 = 1_791_363_600_000;
const PAD: &str =
    "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp";

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/logs/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap()
}

/// A stored string: plain, `{units}` or `{parts}`.
fn dec(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(o) if o.contains_key("units") => {
            let units: Vec<u16> = o["units"]
                .as_array()
                .unwrap()
                .iter()
                .map(|u| u.as_u64().unwrap() as u16)
                .collect();
            String::from_utf16_lossy(&units)
        }
        Value::Object(o) if o.contains_key("parts") => {
            o["parts"].as_array().unwrap().iter().map(dec).collect()
        }
        other => panic!("not an encoded string: {other}"),
    }
}

fn gen_line(i: i64, g: &Value) -> String {
    let step = g["stepMs"].as_i64().unwrap();
    let t = QBASE + i * step;
    let iso = iso_string(t).unwrap();
    match g.get("mix").and_then(Value::as_str) {
        Some("garbage") if i % 2 == 1 => return format!("garbage line without json {PAD}\n"),
        Some("array") if i % 2 == 1 => return "[1,2,3] \n".to_string(),
        Some("nullepoch") if i % 3 == 1 => return "null\n".to_string(),
        Some("nullepoch") if i % 3 == 2 => {
            return format!("{{\"at\":99999999999999999,\"level\":\"info\",\"pad\":\"{PAD}\"}}\n")
        }
        _ => {}
    }
    let rec = |msg: String| {
        format!("{{\"ts\":\"{iso}\",\"level\":\"info\",\"source\":{{\"kind\":\"harness\",\"id\":\"core\",\"version\":null}},\"event\":\"core.test\",\"msg\":\"{msg}\"}}\n")
    };
    match g["style"].as_str().unwrap() {
        "prefix" => {
            format!("{{\"ts\":\"{iso}\",\"level\":\"info\",\"msg\":\"n{i}\",\"pad\":\"{PAD}\"}}\n")
        }
        "late" => {
            format!("{{\"level\":\"info\",\"msg\":\"n{i}\",\"pad\":\"{PAD}\",\"ts\":\"{iso}\"}}\n")
        }
        "legacy-num" => {
            format!("{{\"at\":{t},\"level\":\"info\",\"msg\":\"n{i}\",\"pad\":\"{PAD}\"}}\n")
        }
        "legacy-str" => format!(
            "{{ \"at\" : \"{iso}\" , \"level\":\"info\",\"msg\":\"n{i}\",\"pad\":\"{PAD}\"}}\n"
        ),
        "rec" => rec(format!("m{i}")),
        "filler" => rec(format!("filler {i}")),
        other => panic!("unknown generator style {other}"),
    }
}

fn gen_text(g: &Value) -> String {
    let count = g["count"].as_i64().unwrap();
    let mut lines: Vec<String> = (0..count).map(|i| gen_line(i, g)).collect();
    if let Some(swap) = g.get("swap").and_then(Value::as_array) {
        let (a, b) = (
            swap[0].as_u64().unwrap() as usize,
            swap[1].as_u64().unwrap() as usize,
        );
        lines.swap(a, b);
    }
    lines.concat()
}

fn seg_text(seg: &Value) -> String {
    match seg {
        Value::Object(o) if o.contains_key("fill") => o["fill"]
            .as_str()
            .unwrap()
            .repeat(o["bytes"].as_u64().unwrap() as usize),
        Value::Object(o) if o.contains_key("gen") => gen_text(&o["gen"]),
        other => dec(other),
    }
}

fn segs_text(segs: &Value) -> String {
    segs.as_array().unwrap().iter().map(seg_text).collect()
}

fn write_files(dir: &Path, files: &Value) {
    for (name, segs) in files.as_object().unwrap() {
        fs::write(dir.join(name), segs_text(segs)).unwrap();
    }
}

/// module-api's logger rotation: `name.N` shifts up (five kept), `name` becomes `.1`, a fresh `name` appears.
fn rotate(dir: &Path, name: &str) {
    for i in (1..5).rev() {
        let _ = fs::rename(
            dir.join(format!("{name}.{i}")),
            dir.join(format!("{name}.{}", i + 1)),
        );
    }
    fs::rename(dir.join(name), dir.join(format!("{name}.1"))).unwrap();
    fs::write(dir.join(name), "").unwrap();
}

fn filter_of(v: &Value) -> LogFilter {
    let stream = match v["stream"].as_str().unwrap() {
        "audit" => Stream::Audit,
        _ => Stream::Diagnostic,
    };
    let mut f = LogFilter::new(stream);
    let s = |k: &str| v.get(k).filter(|x| !x.is_null()).map(dec);
    f.from = s("from");
    f.to = s("to");
    f.min_level = s("minLevel").map(|l| Level::parse(&l).unwrap());
    f.component = s("component");
    f.text = s("text");
    f.trace_id = s("traceId");
    f
}

fn order_of(v: &Value) -> Order {
    Order::parse(v.as_str().unwrap()).unwrap()
}

fn record_json(r: &QueryResult) -> Vec<Value> {
    r.records
        .iter()
        .map(|x| {
            json!({
                "ts": x.ts, "level": x.level.map(Level::as_str), "component": x.component,
                "stream": stream_name(x.stream), "record": x.record,
            })
        })
        .collect()
}

fn project(r: &QueryResult, how: Option<&str>) -> Value {
    let msg = |x: &super::query::LogRecordOut| x.record["msg"].as_str().unwrap().to_string();
    match how {
        Some("msg") => Value::from(r.records.iter().map(msg).collect::<Vec<_>>()),
        Some("span") => json!({
            "count": r.records.len(),
            "first": r.records.first().map(msg),
            "last": r.records.last().map(msg),
        }),
        _ => Value::from(record_json(r)),
    }
}

#[test]
fn fingerprint_and_cursor_vectors() {
    let v = fixture("query");
    for case in v["fingerprint"].as_array().unwrap() {
        let got = fingerprint(&filter_of(&case["filter"]), order_of(&case["order"]));
        assert_eq!(got, case["output"].as_str().unwrap(), "{}", case["name"]);
    }
    for case in v["mint"].as_array().unwrap() {
        let key = Key {
            ts: case["key"]["ts"].as_str().unwrap().to_string(),
            h: case["key"]["h"].as_str().unwrap().to_string(),
        };
        let got = mint_cursor(&filter_of(&case["filter"]), order_of(&case["order"]), &key);
        assert_eq!(got, case["output"].as_str().unwrap(), "{}", case["name"]);
    }
    let mut decoded = 0;
    for case in v["decode"].as_array().unwrap() {
        let fp = fingerprint(&filter_of(&case["filter"]), order_of(&case["order"]));
        let got = match decode_cursor(case["cursor"].as_str().unwrap(), &fp) {
            Ok(k) => json!({"key": {"ts": k.ts, "h": k.h}}),
            Err(e) => json!({"error": e.reason()}),
        };
        assert_eq!(got, case["output"], "{}", case["name"]);
        decoded += 1;
    }
    assert!(decoded > 45, "{decoded}");
    assert_eq!(CursorError::BadCursor.reason(), "bad-cursor");
}

#[test]
fn scan_vectors() {
    let v = fixture("query");
    let mut queries = 0;
    for case in v["scans"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        fs::create_dir(&dir).unwrap();
        write_files(&dir, &case["files"]);
        let target: PathBuf = if case.get("missingDir") == Some(&Value::Bool(true)) {
            dir.join("nope")
        } else {
            dir.clone()
        };
        let mut prev: Option<String> = None;
        for (i, (step, expected)) in case["steps"]
            .as_array()
            .unwrap()
            .iter()
            .zip(case["outputs"].as_array().unwrap())
            .enumerate()
        {
            match step["op"].as_str().unwrap() {
                "append" => {
                    use std::io::Write;
                    let mut f = fs::OpenOptions::new()
                        .append(true)
                        .open(dir.join(step["file"].as_str().unwrap()))
                        .unwrap();
                    f.write_all(segs_text(&step["segs"]).as_bytes()).unwrap();
                }
                "rotate" => rotate(&dir, step["file"].as_str().unwrap()),
                "query" => {
                    queries += 1;
                    let mut o = QueryOptions::new(
                        &target,
                        filter_of(&step["filter"]),
                        order_of(&step["order"]),
                        step["limit"].as_u64().unwrap() as usize,
                    );
                    o.cursor = match step.get("cursor") {
                        Some(Value::String(c)) if c == "prev" => prev.clone(),
                        Some(c) => Some(c.as_str().unwrap().to_string()),
                        None => None,
                    };
                    o.max_scan_bytes = step.get("maxScanBytes").and_then(Value::as_u64);
                    o.max_line = step
                        .get("maxLine")
                        .and_then(Value::as_u64)
                        .map(|n| n as usize);
                    let got = match run_query(&o) {
                        Ok(r) => {
                            prev = r.next_cursor.clone();
                            json!({
                                "records": project(&r, step.get("project").and_then(Value::as_str)),
                                "nextCursor": r.next_cursor,
                                "corrupt": r.corrupt,
                                "scanned": {"files": r.scanned_files, "bytes": r.scanned_bytes},
                                "truncated": r.truncated,
                            })
                        }
                        Err(QueryError::Cursor(e)) => json!({"error": e.reason()}),
                        Err(other) => panic!("{name} step {i}: {other}"),
                    };
                    assert_eq!(&got, expected, "{name} step {i}");
                }
                other => panic!("unknown step {other}"),
            }
        }
    }
    assert!(queries > 150, "{queries}");
}

// ---- the handlers ----

fn case_output(res: Result<Value, LogsError>, sleeps: &[u64]) -> Value {
    match res {
        Ok(ok) => json!({"ok": ok, "sleeps": sleeps}),
        Err(LogsError::Rpc(e)) => {
            let mut o = Map::new();
            o.insert("error".into(), Value::from(e.code));
            if let Some(reason) = e.reason.as_deref().filter(|r| !r.is_empty()) {
                o.insert("reason".into(), Value::from(reason));
            }
            o.insert("message".into(), Value::from(e.message));
            o.insert("sleeps".into(), json!(sleeps));
            Value::Object(o)
        }
        Err(LogsError::Internal(e)) => json!({"internal": e}),
    }
}

#[derive(Default)]
struct Plan {
    append: Option<(usize, PathBuf, String)>,
    abort_connection: Option<(usize, AbortSignal)>,
    abort_core: Option<(usize, AbortSignal)>,
}

#[test]
fn query_and_tail_handler_vectors() {
    let v = fixture("methods");
    let start = v["time"]["start"].as_i64().unwrap();
    let mut calls_run = 0;
    for case in v["query"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        fs::create_dir(&dir).unwrap();
        write_files(&dir, &case["files"]);
        let clock = Arc::new(AtomicI64::new(
            case.get("start").and_then(Value::as_i64).unwrap_or(start),
        ));
        let sleeps: Arc<Mutex<Vec<u64>>> = Arc::default();
        let plan: Arc<Mutex<Plan>> = Arc::default();
        let core = AbortSignal::new();
        let mut deps = LogsDeps::new(if case.get("missingDir") == Some(&Value::Bool(true)) {
            dir.join("nope")
        } else {
            dir.clone()
        });
        deps.signal = Some(core.clone());
        let c = clock.clone();
        deps.now = Some(Arc::new(move || c.load(Ordering::SeqCst)));
        deps.poll_ms = case.get("pollMs").and_then(Value::as_u64);
        deps.max_scan_bytes = case.get("maxScanBytes").and_then(Value::as_u64);
        {
            let (clock, sleeps, plan, core) =
                (clock.clone(), sleeps.clone(), plan.clone(), core.clone());
            deps.sleep = Some(Arc::new(move |ms, _signal| {
                clock.fetch_add(ms as i64, Ordering::SeqCst);
                let n = {
                    let mut s = sleeps.lock().unwrap();
                    s.push(ms);
                    s.len()
                };
                let plan = plan.lock().unwrap();
                if let Some((at, file, text)) = &plan.append {
                    if *at == n {
                        use std::io::Write;
                        let mut f = fs::OpenOptions::new().append(true).open(file).unwrap();
                        f.write_all(text.as_bytes()).unwrap();
                    }
                }
                if let Some((at, signal)) = &plan.abort_connection {
                    if *at == n {
                        signal.abort();
                    }
                }
                if let Some((at, _)) = &plan.abort_core {
                    if *at == n {
                        core.abort();
                    }
                }
            }));
        }
        let methods = LogsMethods::new(deps).unwrap();
        let mut outputs: Vec<Value> = Vec::new();
        for (i, call) in case["calls"].as_array().unwrap().iter().enumerate() {
            calls_run += 1;
            sleeps.lock().unwrap().clear();
            if let Some(file) = call.get("rotateBefore").and_then(Value::as_str) {
                rotate(&dir, file);
            }
            if let Some(a) = call.get("appendBefore") {
                use std::io::Write;
                let mut f = fs::OpenOptions::new()
                    .append(true)
                    .open(dir.join(a["file"].as_str().unwrap()))
                    .unwrap();
                f.write_all(segs_text(&a["segs"]).as_bytes()).unwrap();
            }
            let connection = AbortSignal::new();
            if call.get("connectionAborted") == Some(&Value::Bool(true)) {
                connection.abort();
            }
            {
                let mut p = plan.lock().unwrap();
                *p = Plan::default();
                if let Some(a) = call.get("appendOnSleep") {
                    p.append = Some((
                        a["n"].as_u64().unwrap() as usize,
                        dir.join(a["file"].as_str().unwrap()),
                        segs_text(&a["segs"]),
                    ));
                }
                if let Some(n) = call.get("abortConnectionOnSleep").and_then(Value::as_u64) {
                    p.abort_connection = Some((n as usize, connection.clone()));
                }
                if let Some(n) = call.get("abortCoreOnSleep").and_then(Value::as_u64) {
                    p.abort_core = Some((n as usize, core.clone()));
                }
            }
            let mut params = call["params"].clone();
            if let Some(from) = call.get("cursorFromCall").and_then(Value::as_u64) {
                let cursor = outputs[from as usize]["ok"]["nextCursor"].clone();
                params["cursor"] = cursor;
            }
            let ctx = CallContext {
                request_id: "r".into(),
                connection_id: "c".into(),
                signal: connection,
            };
            let parsed = LogsParams::from_value(&params).unwrap();
            let res = match call["method"].as_str().unwrap() {
                "logs.query" => methods.query(&parsed),
                "logs.tail" => methods.tail(&parsed, &ctx),
                other => panic!("{other}"),
            }
            .map(|p| p.to_value());
            let got = case_output(res, &sleeps.lock().unwrap());
            assert_eq!(&got, &case["outputs"][i], "{name} call {i}");
            outputs.push(got);
        }
    }
    assert!(calls_run > 100, "{calls_run}");
}

#[derive(Default)]
struct MemoryAudit(Mutex<Vec<AuditEvent>>);

impl AuditSink for MemoryAudit {
    fn append(&self, event: &AuditEvent) -> Result<(), String> {
        self.0.lock().unwrap().push(event.clone());
        Ok(())
    }
}

fn audit_json(e: &AuditEvent) -> Value {
    json!({
        "at": e.at,
        "actor": {"user": e.actor.user, "host": e.actor.host},
        "action": e.action, "target": e.target, "detail": e.detail,
    })
}

#[test]
fn level_handler_vectors() {
    let v = fixture("methods");
    let t0 = v["time"]["t0"].as_i64().unwrap();
    let mut calls_run = 0;
    for case in v["levels"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        let mut deps = LogsDeps::new(&dir);
        deps.now = Some(Arc::new(move || t0));
        if case["actor"] == true {
            deps.actor = Some(Arc::new(|_| Actor {
                user: "owner".into(),
                host: "rpc".into(),
            }));
        }
        let audit = Arc::new(MemoryAudit::default());
        deps.audit = Some(audit.clone());
        let mut writer = None;
        if let Some(w) = case["writer"].as_object() {
            let mut o =
                WriterOptions::new(&dir, "core", Source::new("harness", "core", Some("0.1.0")));
            o.now = Some(Arc::new(move || t0));
            o.timers = false;
            o.hooks = SinkHooks {
                secure_path: Arc::new(|_, _| true),
                ..SinkHooks::default()
            };
            if let Some(l) = w.get("levels") {
                o.levels = Some(LevelSettings {
                    default_level: l
                        .get("defaultLevel")
                        .map(|x| Level::parse(x.as_str().unwrap()).unwrap()),
                    levels: l
                        .get("levels")
                        .and_then(Value::as_object)
                        .map(|m| {
                            m.iter()
                                .map(|(k, x)| {
                                    (k.clone(), Level::parse(x.as_str().unwrap()).unwrap())
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    trace_until: l
                        .get("traceUntilIn")
                        .and_then(Value::as_i64)
                        .map(|d| t0 + d),
                });
            }
            let w = Arc::new(Writer::new(o).unwrap());
            deps.writer = Some(w.clone());
            writer = Some(w);
        }
        let methods = LogsMethods::new(deps).unwrap();
        let ctx = CallContext::new("r", "c");
        for (i, params) in case["calls"].as_array().unwrap().iter().enumerate() {
            calls_run += 1;
            let res = LevelsParams::from_value(params)
                .map_err(LogsError::Rpc)
                .and_then(|p| methods.levels(&p, &ctx))
                .map(|s| s.to_value());
            let got = case_output(res, &[]);
            // the recorded levels outputs carry no sleeps
            let mut got = got;
            got.as_object_mut().unwrap().remove("sleeps");
            assert_eq!(&got, &case["outputs"][i], "{name} call {i}");
        }
        let events: Vec<Value> = audit.0.lock().unwrap().iter().map(audit_json).collect();
        assert_eq!(Value::from(events), case["audit"], "{name} audit");
        if let Some(w) = writer {
            let _ = w.close();
        }
    }
    assert!(calls_run > 30, "{calls_run}");
}
