//! Replays `fixtures/parity/jobs/user.json` (mode V, `scripts/parity/export-jobs.ts`): every scenario over a real
//! `user-jobs.sqlite`. Each op must give the answer TypeScript gave, write the audit lines, make the calls and raise the events
//! it did, and the tables, the schema text and the ids at the end must be the ones TypeScript left.
use super::testing::{apply, dump, open, wrap, Ctx, ScriptedIds, World};
use super::UserJobs;
use crate::handoff::testing::schema_of;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::{Rc, Weak};
use std::sync::{Arc, Mutex};

fn replay(sc: &Value) {
    let name = sc["name"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("user-jobs.sqlite");
    let w = Arc::new(Mutex::new(World::from_json(&sc["world"])));
    let cx = Rc::new(Ctx {
        w: w.clone(),
        path: path.clone(),
        ids: RefCell::new(Vec::new()),
    });
    let ids = Arc::new(ScriptedIds::default());
    let me: Rc<RefCell<Weak<UserJobs>>> = Rc::new(RefCell::new(Weak::new()));
    let mut jobs = Rc::new(open(&cx, &me, &ids).unwrap());
    *me.borrow_mut() = Rc::downgrade(&jobs);
    for (i, step) in sc["ops"].as_array().unwrap().iter().enumerate() {
        {
            let mut g = w.lock().unwrap();
            g.audit.clear();
            g.events.clear();
            g.calls.clear();
        }
        let op = &step["op"];
        let out = if op["op"] == "reopen" {
            // A reopen that fails leaves the closed service in place, as the assignment never happens in TypeScript.
            jobs.close();
            match open(&cx, &me, &ids) {
                Ok(j) => {
                    jobs = Rc::new(j);
                    *me.borrow_mut() = Rc::downgrade(&jobs);
                    json!({"ok": null})
                }
                Err(e) => wrap(Err(e), &step["out"]),
            }
        } else {
            apply(&jobs, &cx, op, &step["out"])
        };
        assert_eq!(out, step["out"], "{name} op {i}: {op}");
        let g = w.lock().unwrap();
        let audit: Vec<Value> = g
            .audit
            .iter()
            .map(|a| {
                json!({"at": a.at, "user": a.user, "host": a.host, "action": a.action, "target": a.target,
                    "detail": Value::Object(a.detail.iter().cloned().collect())})
            })
            .collect();
        let want = step.get("audit").cloned().unwrap_or(json!([]));
        assert_eq!(Value::Array(audit), want, "{name} op {i} audit: {op}");
        let want = step.get("events").cloned().unwrap_or(json!([]));
        assert_eq!(
            Value::Array(g.events.clone()),
            want,
            "{name} op {i} events: {op}"
        );
        let want = step.get("calls").cloned().unwrap_or(json!([]));
        assert_eq!(
            Value::Array(g.calls.clone()),
            want,
            "{name} op {i} calls: {op}"
        );
    }
    jobs.close();
    assert_eq!(dump(&path), sc["final"]["tables"], "{name} tables");
    assert_eq!(schema_of(&path), sc["final"]["schema"], "{name} schema");
    assert_eq!(json!(*cx.ids.borrow()), sc["final"]["ids"], "{name} ids");
}

#[test]
fn the_user_job_methods_of_rpc_give_typescripts_answers_merges_and_refusals() {
    let all: Value =
        serde_json::from_str(include_str!("../../../../../fixtures/parity/jobs/rpc.json")).unwrap();
    let list = all.as_array().unwrap();
    assert_eq!(list.len(), 3);
    let ops: usize = list
        .iter()
        .map(|s| s["ops"].as_array().unwrap().len())
        .sum();
    assert!(ops > 150, "{ops} ops");
    for sc in list {
        replay(sc);
    }
}

#[test]
fn every_recorded_scenario_gives_typescripts_answers_audit_lines_events_and_rows() {
    let all: Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/jobs/user.json"
    ))
    .unwrap();
    let list = all.as_array().unwrap();
    assert!(list.len() >= 20, "the scenarios are part of the contract");
    let ops: usize = list
        .iter()
        .map(|s| s["ops"].as_array().unwrap().len())
        .sum();
    assert!(ops > 500, "{ops} ops");
    for sc in list {
        replay(sc);
    }
}
