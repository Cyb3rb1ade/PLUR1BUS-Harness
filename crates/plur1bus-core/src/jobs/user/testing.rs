//! Test doubles of the user-jobs ports, driven by the "world" of a recorded scenario (`scripts/parity/export-jobs.ts`): one
//! shared state the clock, the principal lookup, the audit sink, the delivery check and the turn all read, so a scenario can
//! change a right or an agent between two calls, or script what the turn does (including calls back into the service, which is
//! where TypeScript awaits and another caller gets in).
use super::{UserJobOutcome, UserJobs, UserJobsOptions};
use crate::approvals::js_json::J;
use crate::budget::{Clock, IdSource};
use crate::handoff::testing::principal_of;
use crate::jobs::JobsError;
use crate::rbac::audit::{AuditEvent, AuditSink};
use crate::rbac::types::{Principal, Role};
use plur1bus_store::rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::rc::{Rc, Weak};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) struct World {
    pub now: i64,
    pub principals: Vec<(String, Value)>,
    pub agents: Vec<String>,
    pub agent_list: Option<Vec<String>>,
    pub blocked: Vec<String>,
    pub delivery_ok: Vec<String>,
    pub validate: bool,
    pub display_names: Option<serde_json::Map<String, Value>>,
    pub display_throws: bool,
    pub notify_throws: bool,
    pub recorded_throws: bool,
    pub audit_fail: bool,
    pub stopping: bool,
    pub audit: Vec<AuditEvent>,
    pub events: Vec<Value>,
    pub calls: Vec<Value>,
    pub submits: VecDeque<Value>,
}

pub(crate) type Shared = Arc<Mutex<World>>;

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

impl World {
    pub fn from_json(w: &Value) -> World {
        let mut world = World {
            now: w["now"].as_i64().unwrap_or(0),
            principals: w["principals"]
                .as_object()
                .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default(),
            agents: Vec::new(),
            agent_list: None,
            blocked: Vec::new(),
            delivery_ok: Vec::new(),
            validate: false,
            display_names: None,
            display_throws: false,
            notify_throws: false,
            recorded_throws: false,
            audit_fail: false,
            stopping: false,
            audit: Vec::new(),
            events: Vec::new(),
            calls: Vec::new(),
            submits: VecDeque::new(),
        };
        world.patch(w);
        world
    }

    /// `Object.assign(world, patch)` for the members a scenario changes.
    pub fn patch(&mut self, p: &Value) {
        if let Some(a) = p.get("agents") {
            self.agents = strings(a);
        }
        if let Some(a) = p.get("agentList") {
            self.agent_list = a.as_array().map(|_| strings(a));
        }
        if let Some(a) = p.get("blocked") {
            self.blocked = strings(a);
        }
        if let Some(a) = p.get("deliveryOk") {
            self.delivery_ok = strings(a);
        }
        if let Some(b) = p["validate"].as_bool() {
            self.validate = b;
        }
        if let Some(d) = p.get("displayNames") {
            self.display_names = d.as_object().cloned();
        }
        for (key, slot) in [
            ("displayThrows", &mut self.display_throws),
            ("notifyThrows", &mut self.notify_throws),
            ("recordedThrows", &mut self.recorded_throws),
            ("auditFail", &mut self.audit_fail),
            ("stopping", &mut self.stopping),
        ] {
            if let Some(b) = p[key].as_bool() {
                *slot = b;
            }
        }
    }
}

struct WorldClock(Shared);
impl Clock for WorldClock {
    fn now(&self) -> i64 {
        self.0.lock().unwrap().now
    }
}

struct WorldAudit(Shared);
impl AuditSink for WorldAudit {
    fn append(&mut self, event: &AuditEvent) -> Result<(), String> {
        let mut w = self.0.lock().unwrap();
        if w.audit_fail {
            return Err("audit unavailable".into());
        }
        w.audit.push(event.clone());
        Ok(())
    }
}

/// `randomUUID()` of `k3b-support.ts`: the first 16 bytes of the SHA-256 of `uuid:k`, formatted as a UUID.
#[derive(Default)]
pub(crate) struct ScriptedIds(AtomicU64);
impl IdSource for ScriptedIds {
    fn next_id(&self) -> String {
        let k = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        let h: String = Sha256::digest(format!("uuid:{k}").as_bytes())
            .iter()
            .take(16)
            .map(|b| format!("{b:02x}"))
            .collect();
        format!(
            "{}-{}-{}-{}-{}",
            &h[0..8],
            &h[8..12],
            &h[12..16],
            &h[16..20],
            &h[20..32]
        )
    }
}

/// A caller as the scenarios write it. A role that is not one of the five cannot be built; TypeScript refuses it at the
/// person check, so it becomes a principal that is not a person.
pub(crate) fn caller_of(v: &Value) -> Principal {
    let id = v["userId"].as_str().unwrap_or_default();
    if let Some(r) = v["role"].as_str() {
        if Role::parse(r).is_none() {
            let mut p = Principal::new(id, Role::Viewer);
            p.kind = None;
            return p;
        }
    }
    principal_of(id, v)
}

pub(crate) struct Ctx {
    pub w: Shared,
    pub path: PathBuf,
    pub ids: RefCell<Vec<String>>,
}

fn err_json(e: &JobsError) -> Value {
    match e {
        JobsError::Rpc {
            code,
            message,
            detail,
        } => {
            let mut o = json!({"code": code, "message": message});
            if let Some(Value::Object(d)) = detail {
                for (k, v) in d {
                    o[k] = v.clone();
                }
            }
            o
        }
        JobsError::Other(m) => json!({"name": "Error", "message": m}),
    }
}

/// An answer as the vector holds it. A failure that is not an `RpcError` is compared by kind only: its text is the engine's
/// (a `SyntaxError` of `JSON.parse`, SQLite's, Node's `TypeError`).
pub(crate) fn wrap(r: Result<Value, JobsError>, expected: &Value) -> Value {
    match r {
        Ok(v) => json!({"ok": v}),
        Err(JobsError::Other(_))
            if expected["err"]["code"].is_null() && !expected["err"]["name"].is_null() =>
        {
            json!({"err": {"name": expected["err"]["name"], "message": expected["err"]["message"]}})
        }
        Err(e) => json!({"err": err_json(&e)}),
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

/// One op against the service. `reopen` is the caller's: it replaces the service.
pub(crate) fn apply(jobs: &UserJobs, cx: &Ctx, op: &Value, expected: &Value) -> Value {
    let id_of = |op: &Value| -> String {
        match op["nth"].as_u64() {
            Some(n) => cx.ids.borrow().get(n as usize).cloned().unwrap_or_default(),
            None => op["id"].as_str().unwrap_or_default().to_owned(),
        }
    };
    let note = |r: &J| {
        if let Some(J::Str(id)) = r.get("id") {
            let mut ids = cx.ids.borrow_mut();
            if id.starts_with("user:") && !ids.contains(id) {
                ids.push(id.clone());
            }
        }
    };
    let caller = || caller_of(&op["caller"]);
    match op["op"].as_str().unwrap_or_default() {
        "create" => wrap(
            jobs.create(&J::from_value(&op["input"]), &caller())
                .inspect(note)
                .map(|j| j.to_value()),
            expected,
        ),
        "update" => {
            let mut patch = J::from_value(&op["patch"]);
            if op["nth"].as_u64().is_some() {
                patch.set("id", J::Str(id_of(op)));
            }
            wrap(
                jobs.update(&patch, &caller()).map(|j| j.to_value()),
                expected,
            )
        }
        "delete" => wrap(
            jobs.delete(&id_of(op), &J::from_value(&op["confirm"]), &caller())
                .map(|j| j.to_value()),
            expected,
        ),
        "list" => wrap(
            jobs.list(&caller())
                .map(|l| Value::Array(l.into_iter().map(|j| j.to_value()).collect())),
            expected,
        ),
        "targets" => wrap(jobs.targets(&caller()).map(|l| json!(l)), expected),
        "history" => {
            let id = (op["id"].is_string() || op["nth"].is_u64()).then(|| id_of(op));
            wrap(
                jobs.history(id.as_deref(), &caller(), num_arg(&op["limit"]))
                    .map(|l| Value::Array(l.into_iter().map(|j| j.to_value()).collect())),
                expected,
            )
        }
        "get" => wrap(jobs.get(&id_of(op)).map(|j| j.to_value()), expected),
        "has" => wrap(jobs.has(&id_of(op)).map(Value::Bool), expected),
        "tick" => wrap(jobs.tick().map(|()| Value::Null), expected),
        "run" => wrap(
            jobs.run(&id_of(op), &caller()).map(|j| j.to_value()),
            expected,
        ),
        "close" => {
            jobs.close();
            json!({"ok": null})
        }
        "advance" => {
            let mut w = cx.w.lock().unwrap();
            w.now += op["ms"].as_i64().unwrap();
            json!({"ok": w.now})
        }
        "world" => {
            cx.w.lock().unwrap().patch(&op["patch"]);
            json!({"ok": null})
        }
        "principal" => {
            let mut w = cx.w.lock().unwrap();
            let p = op["person"].as_str().unwrap().to_owned();
            w.principals.retain(|(k, _)| *k != p);
            if !op["principal"].is_null() {
                w.principals.push((p, op["principal"].clone()));
            }
            json!({"ok": null})
        }
        "submit" => {
            let mut w = cx.w.lock().unwrap();
            for s in op["steps"].as_array().unwrap() {
                w.submits.push_back(s.clone());
            }
            json!({"ok": null})
        }
        "raw" => {
            let db = Connection::open(&cx.path).unwrap();
            let args: Vec<String> = op["args"]
                .as_array()
                .map(|a| a.iter().map(|x| x.as_str().unwrap().to_owned()).collect())
                .unwrap_or_default();
            db.execute(
                op["sql"].as_str().unwrap(),
                plur1bus_store::rusqlite::params_from_iter(args),
            )
            .unwrap();
            json!({"ok": null})
        }
        "rpc" => {
            let mut params = op.get("params").map(J::from_value);
            if let (Some(n), Some(p)) = (op["jobNth"].as_u64(), params.as_mut()) {
                let id = cx.ids.borrow().get(n as usize).cloned().unwrap_or_default();
                p.set("job", J::Str(id));
            }
            let who = (!op["caller"].is_null()).then(caller);
            let method = op["method"].as_str().unwrap();
            let legacy = |p: &J| -> Result<J, JobsError> {
                Ok(if method == "jobs.run" {
                    J::obj([("legacy", J::Bool(true)), ("p", p.clone())])
                } else {
                    J::from_value(&op["legacy"])
                })
            };
            let rpc = super::rpc::UserJobsRpc::new(jobs);
            let r = match method {
                "jobs.list" => rpc.list(params.as_ref(), who.as_ref(), &legacy),
                "jobs.history" => rpc.history(params.as_ref(), who.as_ref(), &legacy),
                "jobs.run" => rpc.run(params.as_ref(), who.as_ref(), &legacy),
                other => panic!("unknown method {other}"),
            };
            wrap(r.map(|j| j.to_value()), expected)
        }
        "rawRuns" => {
            let job = cx
                .ids
                .borrow()
                .get(op["nth"].as_u64().unwrap() as usize)
                .cloned()
                .unwrap();
            let db = Connection::open(&cx.path).unwrap();
            let at = cx.w.lock().unwrap().now;
            for i in 0..op["n"].as_i64().unwrap() {
                let id = format!("bulk-{i}");
                let record = J::obj([
                    ("runId", J::s(&id)),
                    ("jobId", J::s(&job)),
                    ("agentId", J::s("main")),
                    ("job", J::s("Daily")),
                    ("kind", J::s("user")),
                    ("runAs", J::s("mel")),
                    ("runAsDisplayName", J::s("mel")),
                    ("trigger", J::s("recurring")),
                    ("startedAt", J::Num((at + i) as f64)),
                    ("finishedAt", J::Num((at + i) as f64)),
                    ("durationMs", J::Num(0.0)),
                    ("outcome", J::s("completed")),
                ]);
                db.execute(
                    "INSERT INTO user_job_runs VALUES (?,?,?)",
                    [id, job.clone(), record.stringify()],
                )
                .unwrap();
            }
            json!({"ok": null})
        }
        "historyCount" => wrap(
            jobs.history(None, &caller(), num_arg(&op["limit"]))
                .map(|l| json!(l.len())),
            expected,
        ),
        "rawJob" => {
            let mut job = J::from_value(&op["job"]);
            if job.get("id").is_none() {
                job.set("id", J::Str(id_of(op)));
            }
            let id = job.get("id").and_then(J::as_str).unwrap().to_owned();
            let db = Connection::open(&cx.path).unwrap();
            db.execute(
                "INSERT INTO user_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition",
                [id, job.stringify()],
            )
            .unwrap();
            json!({"ok": null})
        }
        other => panic!("unknown op {other}"),
    }
}

/// The service over the world, opened the way the scenario's TypeScript options are.
pub(crate) fn open(
    cx: &Rc<Ctx>,
    me: &Rc<RefCell<Weak<UserJobs>>>,
    ids: &Arc<ScriptedIds>,
) -> Result<UserJobs, JobsError> {
    let w = cx.w.clone();
    let (validate, has_names) = {
        let g = w.lock().unwrap();
        (g.validate, g.display_names.is_some())
    };
    let (w1, w2, w3, w4, w5, w6, w7, w8, w9, w10) = (
        w.clone(),
        w.clone(),
        w.clone(),
        w.clone(),
        w.clone(),
        w.clone(),
        w.clone(),
        w.clone(),
        w.clone(),
        w.clone(),
    );
    let cx2 = cx.clone();
    let me2 = me.clone();
    UserJobs::open(UserJobsOptions {
        path: cx.path.clone(),
        clock: Arc::new(WorldClock(w.clone())),
        ids: ids.clone(),
        audit: Box::new(WorldAudit(w.clone())),
        agent_exists: Box::new(move |id| w1.lock().unwrap().agents.iter().any(|a| a == id)),
        agents: Some(Box::new(move || {
            let g = w2.lock().unwrap();
            g.agent_list.clone().unwrap_or_else(|| g.agents.clone())
        })),
        resolve: Box::new(move |id| {
            let g = w3.lock().unwrap();
            g.principals
                .iter()
                .find(|(k, _)| k == id)
                // `{ userId: id, ...spec }`: a recorded principal may name another user id than the one asked for.
                .map(|(_, spec)| principal_of(spec["userId"].as_str().unwrap_or(id), spec))
        }),
        display_name: has_names.then(|| {
            Box::new(move |id: &str| {
                let g = w4.lock().unwrap();
                if g.display_throws {
                    return Err(JobsError::Other("display".into()));
                }
                match &g.display_names {
                    None => Err(JobsError::Other("no names".into())),
                    Some(m) => Ok(m.get(id).and_then(Value::as_str).map(str::to_owned)),
                }
            }) as super::DisplayName
        }),
        budget_blocked: Box::new(move |a| w5.lock().unwrap().blocked.iter().any(|b| b == a)),
        notify: Box::new(move |r: &J| {
            let mut g = w6.lock().unwrap();
            g.events.push(json!({"notify": r.to_value()}));
            if g.notify_throws {
                return Err(JobsError::Other("notify".into()));
            }
            Ok(())
        }),
        on_recorded: Some(Box::new(move |r: &J| {
            let mut g = w7.lock().unwrap();
            g.events.push(json!({"recorded": r.to_value()}));
            if g.recorded_throws {
                return Err(JobsError::Other("recorded".into()));
            }
            Ok(())
        })),
        submit_turn: Box::new(move |job: &J, person: &Principal| {
            let step = {
                let mut g = w8.lock().unwrap();
                g.events.push(json!({"turn": {
                    "job": job.get("id").map(J::to_value),
                    "runAs": job.get("runAs").map(J::to_value),
                    "person": person.user_id,
                    "role": person.role.as_str(),
                }}));
                let s = g.submits.pop_front().unwrap_or_else(|| json!({}));
                if let Some(ms) = s["advance"].as_i64() {
                    g.now += ms;
                }
                s
            };
            if let Some(during) = step["during"].as_array() {
                let mut nested = Vec::new();
                for op in during {
                    let out = match me2.borrow().upgrade() {
                        Some(jobs) => apply(&jobs, &cx2, op, &Value::Null),
                        None => json!({"err": "gone"}),
                    };
                    nested.push(json!({"op": op, "out": out}));
                }
                w8.lock().unwrap().events.push(json!({"nested": nested}));
            }
            if step["throws"].as_bool() == Some(true) {
                return Err(JobsError::Other("turn failed".into()));
            }
            Ok(step["outcome"]
                .as_str()
                .and_then(UserJobOutcome::parse)
                .unwrap_or(UserJobOutcome::Completed))
        }),
        validate_delivery: validate.then(|| {
            Box::new(move |id: &str, person: &str, agent: &str| {
                let mut g = w9.lock().unwrap();
                g.calls.push(json!([id, person, agent]));
                if !g.delivery_ok.iter().any(|d| d == id) {
                    return Err(JobsError::Rpc {
                        code: "E_DENIED",
                        message: "delivery destination denied".into(),
                        detail: Some(json!({"reason": "delivery"})),
                    });
                }
                Ok(())
            }) as super::ValidateDelivery
        }),
        is_stopping: Some(Box::new(move || w10.lock().unwrap().stopping)),
        secure_path: None,
    })
}

/// Both tables as the exporter dumps them: a column that is not JSON is `{ "$raw": text }`.
pub(crate) fn dump(path: &std::path::Path) -> Value {
    let conn = Connection::open(path).unwrap();
    let mut out = serde_json::Map::new();
    for (t, json_col) in [("user_jobs", 1usize), ("user_job_runs", 2usize)] {
        let mut st = conn
            .prepare(&format!("SELECT * FROM {t} ORDER BY rowid"))
            .unwrap();
        let n = st.column_count();
        let rows: Vec<Value> = st
            .query_map([], |r| {
                let mut cells = Vec::new();
                for i in 0..n {
                    let text: String = r.get(i)?;
                    cells.push(if i == json_col {
                        serde_json::from_str(&text).unwrap_or_else(|_| json!({"$raw": text}))
                    } else {
                        Value::String(text)
                    });
                }
                Ok(Value::Array(cells))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        out.insert(t.to_owned(), Value::Array(rows));
    }
    Value::Object(out)
}
