//! Test doubles for the system-jobs registry, driven by the "world" of a recorded scenario (`scripts/parity/export-jobs.ts`):
//! scripted handlers (what `run` does is data), a clock the scenario moves, and logs of what the logger, the secure hook and
//! the recorded/failed ports heard.
use super::arm::{IntegrityArm, IntegrityTimers};
use super::registry::{
    CreateSystemJobsOptions, HistoryQuery, RunContext, RunOptions, SystemJobHandler,
    SystemJobOutcome, SystemJobSpec, SystemJobs, SystemOutcome,
};
use crate::approvals::js_json::J;
use crate::budget::Clock;
use crate::jobs::user::testing::{wrap, ScriptedIds};
use crate::jobs::JobsError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(crate) struct SWorld {
    pub now: i64,
    pub engine: Vec<String>,
    pub secure_ok: bool,
    pub recorded_throws: bool,
    pub failed_throws: bool,
    pub handlers: Vec<Value>,
    pub warns: Vec<Value>,
    pub secure: Vec<String>,
    pub recorded: Vec<Value>,
    pub failed: Vec<Value>,
}

pub(crate) type SShared = Arc<Mutex<SWorld>>;

struct SClock(SShared);
impl Clock for SClock {
    fn now(&self) -> i64 {
        self.0.lock().unwrap().now
    }
}

fn num_arg(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Object(o) => o.get("$num").and_then(Value::as_str).map(|s| match s {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            other => other.parse().unwrap_or(f64::NAN),
        }),
        _ => None,
    }
}

/// A handler whose behaviour is the recorded `h.behaviour`.
struct Scripted {
    h: Value,
    w: SShared,
}

fn rpc_args(message: &str) -> JobsError {
    JobsError::Rpc {
        code: "E_INVALID_PARAMS",
        message: message.into(),
        detail: Some(json!({"detail": "args"})),
    }
}

impl SystemJobHandler for Scripted {
    fn spec(&self) -> SystemJobSpec {
        SystemJobSpec {
            name: self.h["name"].as_str().unwrap().to_owned(),
            every: self.h["every"].as_f64().unwrap(),
            jitter: self.h["jitter"].as_f64().unwrap(),
            exclusive: self.h["exclusive"].as_bool() == Some(true),
        }
    }

    fn next_run_at(&self) -> Option<f64> {
        if self.h["nextRunAtFn"] == "now" {
            return Some(self.w.lock().unwrap().now as f64);
        }
        self.h["nextRunAt"].as_f64()
    }

    fn validate_args(&self, args: Option<&J>) -> Result<J, JobsError> {
        let empty = || J::Obj(Vec::new());
        if self.h["args"] == "none" {
            return match args {
                None | Some(J::Null) => Ok(empty()),
                Some(J::Obj(m)) if m.is_empty() => Ok(empty()),
                _ => Err(rpc_args("takes no args")),
            };
        }
        match args {
            None | Some(J::Null) => Ok(empty()),
            Some(a @ J::Obj(_)) => Ok(a.clone()),
            Some(_) => Err(rpc_args("args must be an object")),
        }
    }

    fn run(&self, args: &J, ctx: &RunContext<'_>) -> Result<SystemJobOutcome, JobsError> {
        let _ = args;
        let b = &self.h["behaviour"];
        let done = |outcome: SystemOutcome, detail: J| SystemJobOutcome {
            outcome,
            reason: None,
            running_run_id: None,
            detail,
        };
        match b["do"].as_str().unwrap_or("complete") {
            "throw" => Err(JobsError::Other("handler failed".into())),
            "rpc-throw" => Err(JobsError::Rpc {
                code: "E_DENIED",
                message: "handler denied".into(),
                detail: None,
            }),
            "advance" => {
                self.w.lock().unwrap().now += b["ms"].as_i64().unwrap();
                Ok(done(SystemOutcome::Completed, J::Null))
            }
            "outcome" => Ok(SystemJobOutcome {
                outcome: match b["outcome"].as_str().unwrap() {
                    "completed" => SystemOutcome::Completed,
                    "skipped" => SystemOutcome::Skipped,
                    "failed" => SystemOutcome::Failed,
                    "abandoned" => SystemOutcome::Abandoned,
                    "incomplete" => SystemOutcome::Incomplete,
                    other => panic!("unknown outcome {other}"),
                },
                reason: b["reason"].as_str().map(str::to_owned),
                running_run_id: b["runningRunId"].as_str().map(str::to_owned),
                detail: b.get("detail").map_or(J::Null, J::from_value),
            }),
            "nested" => {
                let op = json!({
                    "op": "run", "name": b["name"], "args": b["args"],
                    "trigger": b.get("trigger").cloned().unwrap_or(json!("manual")),
                });
                let o = run_op(ctx.jobs, &op, &Value::Null);
                Ok(done(
                    SystemOutcome::Completed,
                    J::obj([("nested", J::from_value(&o))]),
                ))
            }
            _ => Ok(done(
                SystemOutcome::Completed,
                b.get("detail").map_or(J::Null, J::from_value),
            )),
        }
    }
}

fn run_op(jobs: &SystemJobs, op: &Value, expected: &Value) -> Value {
    let args = match (op["argsText"].as_str(), op.get("args")) {
        (Some(t), _) => Some(J::parse(t).expect("argsText parses")),
        (None, Some(a)) => Some(J::from_value(a)),
        _ => None,
    };
    let aborted = Arc::new(AtomicBool::new(op["aborted"] == true));
    let o = RunOptions {
        trigger: op["trigger"].as_str().unwrap_or("manual").to_owned(),
        signal: Some(aborted),
    };
    wrap(
        jobs.run(op["name"].as_str().unwrap(), args.as_ref(), &o)
            .map(|(rec, detail)| json!({"record": rec.to_j().to_value(), "detail": detail.to_value()})),
        expected,
    )
}

fn make(w: &SShared, ledger: &Path, ids: &Arc<ScriptedIds>) -> SystemJobs {
    let (w1, w2, w3, w4, w5) = (w.clone(), w.clone(), w.clone(), w.clone(), w.clone());
    SystemJobs::new(CreateSystemJobsOptions {
        ledger_path: ledger.to_path_buf(),
        clock: Arc::new(SClock(w.clone())),
        ids: ids.clone(),
        secure_path: Box::new(move |p| {
            let mut g = w1.lock().unwrap();
            g.secure.push(p.to_string_lossy().into_owned());
            g.secure_ok
        }),
        warn: Rc::new(move |m, f| {
            w2.lock()
                .unwrap()
                .warns
                .push(json!({"m": m, "f": f.to_value()}));
        }),
        engine_has_job: Box::new(move |n| w3.lock().unwrap().engine.iter().any(|e| e == n)),
        on_recorded: Some(Box::new(move |r| {
            let mut g = w4.lock().unwrap();
            g.recorded.push(r.to_j().to_value());
            if g.recorded_throws {
                return Err(JobsError::Other("recorded".into()));
            }
            Ok(())
        })),
        on_failed: Some(Box::new(move |r| {
            let mut g = w5.lock().unwrap();
            g.failed.push(r.to_j().to_value());
            if g.failed_throws {
                return Err(JobsError::Other("failed".into()));
            }
            Ok(())
        })),
    })
}

/// The root of the scenario's directory in every string, as the exporter writes it.
fn clean(v: &Value, root: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace(root, "$ROOT")),
        Value::Array(a) => Value::Array(a.iter().map(|x| clean(x, root)).collect()),
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, x)| (k.clone(), clean(x, root))).collect())
        }
        other => other.clone(),
    }
}

/// An `error` member is the operating system's text and differs between systems: it is compared by being a string.
fn mask_errors(v: &mut Value) {
    match v {
        Value::Object(o) => {
            if let Some(e) = o.get_mut("error") {
                if e.is_string() {
                    *e = json!("$ERR");
                }
            }
            for x in o.values_mut() {
                mask_errors(x);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(mask_errors),
        _ => {}
    }
}

fn shown(p: &Path, root: &str) -> Value {
    let Ok(meta) = std::fs::metadata(p) else {
        return Value::Null;
    };
    if meta.is_dir() {
        return json!("$dir");
    }
    let bytes = std::fs::read(p).unwrap();
    if bytes.len() <= 8192 {
        return json!(String::from_utf8_lossy(&bytes).replace(root, "$ROOT"));
    }
    let tail: String = bytes[bytes.len() - 200..]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let sha: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    json!({"size": bytes.len(), "sha256": sha, "tailHex": tail})
}

fn rotated(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".1");
    PathBuf::from(s)
}

fn register(jobs: &SystemJobs, w: &SShared, h: &Value) -> Result<(), JobsError> {
    jobs.register(Rc::new(Scripted {
        h: h.clone(),
        w: w.clone(),
    }))
}

/// One scenario over a real ledger directory.
pub(crate) fn replay_system(sc: &Value) {
    let name = sc["name"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let ledger = dir
        .path()
        .join("state")
        .join("system-jobs")
        .join("ledger.jsonl");
    let w: SShared = Arc::new(Mutex::new(SWorld {
        now: sc["world"]["now"].as_i64().unwrap(),
        engine: sc["world"]["engine"]
            .as_array()
            .map(|a| a.iter().map(|x| x.as_str().unwrap().to_owned()).collect())
            .unwrap_or_default(),
        secure_ok: sc["world"]["secureOk"] != false,
        handlers: sc["world"]["handlers"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
        ..SWorld::default()
    }));
    let ids = Arc::new(ScriptedIds::default());
    let mut jobs = make(&w, &ledger, &ids);
    let handlers = w.lock().unwrap().handlers.clone();
    for h in &handlers {
        register(&jobs, &w, h).unwrap();
    }
    for (i, step) in sc["ops"].as_array().unwrap().iter().enumerate() {
        {
            let mut g = w.lock().unwrap();
            g.warns.clear();
            g.secure.clear();
            g.recorded.clear();
            g.failed.clear();
        }
        let op = &step["op"];
        let ctx = format!("{name} op {i}: {op}");
        let out = match op["op"].as_str().unwrap() {
            "register" => wrap(
                register(&jobs, &w, &op["handler"]).map(|()| Value::Null),
                &step["out"],
            ),
            "has" => json!({"ok": jobs.has(op["name"].as_str().unwrap())}),
            "list" => {
                json!({"ok": jobs.list().iter().map(|e| e.to_j().to_value()).collect::<Vec<_>>()})
            }
            "run" => run_op(&jobs, op, &step["out"]),
            "history" => {
                let q = HistoryQuery {
                    job: op["job"].as_str(),
                    since: num_arg(&op["since"]),
                    limit: num_arg(&op["limit"]),
                };
                json!({"ok": jobs.history(&q).iter().map(|r| r.to_j().to_value()).collect::<Vec<_>>()})
            }
            "advance" => {
                let mut g = w.lock().unwrap();
                g.now += op["ms"].as_i64().unwrap();
                json!({"ok": g.now})
            }
            "world" => {
                let mut g = w.lock().unwrap();
                if let Some(b) = op["patch"]["secureOk"].as_bool() {
                    g.secure_ok = b;
                }
                if let Some(b) = op["patch"]["recordedThrows"].as_bool() {
                    g.recorded_throws = b;
                }
                if let Some(b) = op["patch"]["failedThrows"].as_bool() {
                    g.failed_throws = b;
                }
                json!({"ok": null})
            }
            // The text a scenario writes is set-up: the recorded file after the op is that text (the fixture holds objects with
            // sorted keys, the file the order they were written in).
            "write" => {
                let to = if op["rotated"] == true {
                    rotated(&ledger)
                } else {
                    ledger.clone()
                };
                std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();
                let key = if op["rotated"] == true {
                    "rotated"
                } else {
                    "ledger"
                };
                let text = step["files"][key].as_str().unwrap().replace("$ROOT", &root);
                std::fs::write(to, text).unwrap();
                json!({"ok": null})
            }
            "pad" => {
                let cur = std::fs::read_to_string(&ledger).unwrap_or_default();
                let bytes = op["bytes"].as_i64().unwrap();
                let need = bytes - cur.len() as i64;
                if need > 0 {
                    let tidy = cur.is_empty() || cur.ends_with('\n');
                    let pad = need - i64::from(!tidy);
                    let mut next = cur.clone();
                    if !tidy {
                        next.push('\n');
                    }
                    next.push_str(&"\n".repeat(pad.max(0) as usize));
                    std::fs::write(&ledger, next).unwrap();
                }
                json!({"ok": std::fs::metadata(&ledger).unwrap().len()})
            }
            "mkdir" => {
                let p = if op["rotated"] == true {
                    rotated(&ledger)
                } else {
                    ledger.clone()
                };
                wrap(
                    std::fs::create_dir_all(p)
                        .map(|()| Value::Null)
                        .map_err(|e| JobsError::Other(e.to_string())),
                    &step["out"],
                )
            }
            "rm" => {
                let p = if op["rotated"] == true {
                    rotated(&ledger)
                } else {
                    ledger.clone()
                };
                if p.is_dir() {
                    std::fs::remove_dir_all(&p).unwrap();
                } else if p.exists() {
                    std::fs::remove_file(&p).unwrap();
                }
                json!({"ok": null})
            }
            "reopen" => {
                jobs = make(&w, &ledger, &ids);
                let handlers = w.lock().unwrap().handlers.clone();
                for h in &handlers {
                    register(&jobs, &w, h).unwrap();
                }
                json!({"ok": null})
            }
            other => panic!("unknown op {other}"),
        };
        assert_eq!(clean(&out, &root), step["out"], "{ctx}");
        let g = w.lock().unwrap();
        let mut warns = clean(&Value::Array(g.warns.clone()), &root);
        let mut want = step.get("warns").cloned().unwrap_or(json!([]));
        mask_errors(&mut warns);
        mask_errors(&mut want);
        assert_eq!(warns, want, "{ctx} warns");
        assert_eq!(
            clean(&json!(g.secure), &root),
            step.get("secure").cloned().unwrap_or(json!([])),
            "{ctx} secure"
        );
        assert_eq!(
            Value::Array(g.recorded.clone()),
            step.get("recorded").cloned().unwrap_or(json!([])),
            "{ctx} recorded"
        );
        assert_eq!(
            Value::Array(g.failed.clone()),
            step.get("failed").cloned().unwrap_or(json!([])),
            "{ctx} failed"
        );
        let files =
            json!({"ledger": shown(&ledger, &root), "rotated": shown(&rotated(&ledger), &root)});
        assert_eq!(files, step["files"], "{ctx} files");
    }
}

/// The timers of the arm scenarios: the host's queue.
struct Timers {
    w: SShared,
    queue: RefCell<VecDeque<f64>>,
    set: RefCell<Vec<f64>>,
}

impl IntegrityTimers for Timers {
    fn now(&self) -> f64 {
        self.w.lock().unwrap().now as f64
    }
    fn set_timer(&self, ms: f64) {
        self.queue.borrow_mut().push_back(ms);
        self.set.borrow_mut().push(ms);
    }
}

/// `armScenario`: the `approvals.integrity` job armed against recorded timers.
pub(crate) fn replay_arm(sc: &Value) {
    let name = sc["name"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let w: SShared = Arc::new(Mutex::new(SWorld {
        now: 1_780_300_800_000,
        secure_ok: true,
        ..SWorld::default()
    }));
    let ids = Arc::new(ScriptedIds::default());
    let jobs = make(
        &w,
        &dir.path()
            .join("state")
            .join("system-jobs")
            .join("ledger.jsonl"),
        &ids,
    );
    let next: Rc<RefCell<Option<f64>>> = Rc::new(RefCell::new(None));
    let throws = Rc::new(RefCell::new(false));
    struct Integrity {
        next: Rc<RefCell<Option<f64>>>,
        throws: Rc<RefCell<bool>>,
    }
    impl SystemJobHandler for Integrity {
        fn spec(&self) -> SystemJobSpec {
            SystemJobSpec {
                name: "approvals.integrity".into(),
                every: 86_400_000.0,
                jitter: 0.1,
                exclusive: true,
            }
        }
        fn next_run_at(&self) -> Option<f64> {
            *self.next.borrow()
        }
        fn validate_args(&self, _: Option<&J>) -> Result<J, JobsError> {
            Ok(J::Obj(Vec::new()))
        }
        fn run(&self, _: &J, _: &RunContext<'_>) -> Result<SystemJobOutcome, JobsError> {
            if *self.throws.borrow() {
                return Err(JobsError::Other("verify failed".into()));
            }
            Ok(SystemJobOutcome {
                outcome: SystemOutcome::Completed,
                reason: None,
                running_run_id: None,
                detail: J::Null,
            })
        }
    }
    jobs.register(Rc::new(Integrity {
        next: next.clone(),
        throws: throws.clone(),
    }))
    .unwrap();
    let timers = Timers {
        w: w.clone(),
        queue: RefCell::new(VecDeque::new()),
        set: RefCell::new(Vec::new()),
    };
    let mut arm: Option<IntegrityArm> = None;
    for (i, step) in sc["ops"].as_array().unwrap().iter().enumerate() {
        timers.set.borrow_mut().clear();
        let op = &step["op"];
        let mut out = Value::Null;
        match op["op"].as_str().unwrap() {
            "arm" => arm = Some(IntegrityArm::start(&jobs, &timers)),
            "world" => {
                if let Some(n) = op["patch"].get("next") {
                    *next.borrow_mut() = n.as_f64();
                }
                if let Some(t) = op["patch"]["throws"].as_bool() {
                    *throws.borrow_mut() = t;
                }
            }
            "advance" => w.lock().unwrap().now += op["ms"].as_i64().unwrap(),
            "fire" => {
                if timers.queue.borrow_mut().pop_front().is_some() {
                    arm.as_ref().unwrap().fire(&jobs, &timers);
                } else {
                    out = json!("no timer");
                }
            }
            "cancel" => arm.as_ref().unwrap().cancel(),
            other => panic!("unknown arm op {other}"),
        }
        let got = json!({"op": op, "out": out, "set": timers.set.borrow().iter().map(|n| crate::approvals::js_json::num_value(*n)).collect::<Vec<_>>(), "runs": jobs.history(&HistoryQuery::default()).len()});
        assert_eq!(got, *step, "{name} op {i}");
    }
}
