//! Replays `fixtures/parity/inbox/*.json` (mode V, `scripts/parity/export-inbox.ts`): every scenario of the store and of the
//! service over a real file, and every producer case. Each op must give the answer TypeScript gave, and the tables, the schema
//! text, the events and the log lines must be the ones TypeScript left.
use super::migrate::{breakglass_draft, migrate_breakglass_notices};
use super::producers::{
    always_grants_to_inbox, approval_to_inbox, breakglass_to_inbox, channel_to_inbox,
    job_failed_to_inbox, media_to_inbox, notice_json, pairing_to_inbox, GrantInfo, JobRun,
};
use super::service::{InboxNotice, InboxPort, SettleTarget};
use super::testing::{
    counts_json, draft_of, err_json, notice_of, open, page_json, SeqIds, TestClock,
};
use super::{
    Ids, InboxChange, InboxError, InboxListQuery, InboxService, InboxServiceOptions, InboxStore,
};
use crate::handoff::testing::{dump_tables, schema_of};
use crate::rbac::break_glass::BreakGlassNotice;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

/// `{ "$u16": [units] }` is a string TypeScript made with a `slice` that cut a surrogate pair in two (JSON cannot hold it). A
/// Rust string cannot either: the replay expects the string without its lone half (**K3-D4**).
fn revive(v: &Value) -> Value {
    match v {
        Value::Object(o) if o.len() == 1 && o.contains_key("$u16") => {
            let units: Vec<u16> = o["$u16"]
                .as_array()
                .unwrap()
                .iter()
                .map(|u| u.as_u64().unwrap() as u16)
                .collect();
            Value::String(char::decode_utf16(units).filter_map(Result::ok).collect())
        }
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), revive(x))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(revive).collect()),
        other => other.clone(),
    }
}

fn fixture(name: &str) -> Value {
    let text = match name {
        "store" => include_str!("../../../../fixtures/parity/inbox/store.json"),
        "service" => include_str!("../../../../fixtures/parity/inbox/service.json"),
        "producers" => include_str!("../../../../fixtures/parity/inbox/producers.json"),
        other => panic!("no fixture {other}"),
    };
    revive(&serde_json::from_str(text).expect("fixture parses"))
}

fn wrap(r: Result<Value, InboxError>) -> Value {
    match r {
        Ok(v) => json!({"ok": v}),
        Err(e) => json!({"err": err_json(&e)}),
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_owned())
        .collect()
}

/// `ids`: the string `all`, or a list.
fn with_ids<T>(v: &Value, f: impl FnOnce(Ids<'_>) -> T) -> T {
    if v.is_string() {
        f(Ids::All)
    } else {
        let list = strings(v);
        f(Ids::List(&list))
    }
}

fn query(v: &Value, last: &Option<String>) -> InboxListQuery {
    InboxListQuery {
        kinds: v.get("kinds").map(strings),
        unread_only: v["unreadOnly"].as_bool().unwrap_or(false),
        include_dismissed: v["includeDismissed"].as_bool().unwrap_or(false),
        limit: v["limit"].as_f64(),
        cursor: v.get("cursor").map(|c| match c.as_str() {
            Some("$last") => last.clone().unwrap_or_default(),
            Some(s) => s.to_owned(),
            None => String::new(),
        }),
    }
}

fn notices_of(v: &Value) -> Vec<BreakGlassNotice> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|n| BreakGlassNotice {
            user_id: n["userId"].as_str().unwrap().into(),
            grant_id: n["grantId"].as_str().unwrap().into(),
            holder_user_id: n["holderUserId"].as_str().unwrap().into(),
            reason: n["reason"].as_str().unwrap().into(),
            expires_at: n["expiresAt"].as_i64().unwrap(),
        })
        .collect()
}

fn replay_store(sc: &Value) {
    let name = sc["name"].as_str().unwrap();
    let w = &sc["world"];
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("inbox.sqlite");
    let clock = Arc::new(TestClock(AtomicI64::new(
        w["now"].as_i64().unwrap_or(1_000_000),
    )));
    let ids = Arc::new(SeqIds::default());
    let mk = || {
        open(
            path.clone(),
            clock.clone(),
            ids.clone(),
            w["maxAgeMs"].as_f64(),
            w["maxEntries"].as_f64(),
        )
    };
    let mut s = Some(mk().unwrap());
    let mut last: Option<String> = None;
    for (i, step) in sc["ops"].as_array().unwrap().iter().enumerate() {
        let op = &step["op"];
        let kind = op["op"].as_str().unwrap();
        let user = op["user"].as_str().unwrap_or_default();
        let out = match kind {
            "publish" => wrap(
                s.as_mut()
                    .unwrap()
                    .publish(&draft_of(&op["draft"]))
                    .map(|p| json!({"id": p.id, "created": p.created})),
            ),
            "publishRL" => wrap(
                s.as_mut()
                    .unwrap()
                    .publish_rate_limited(
                        &draft_of(&op["draft"]),
                        op["cooldownMs"].as_f64().unwrap(),
                    )
                    .map(|p| json!({"id": p.id, "created": p.created})),
            ),
            "list" => {
                let r = s.as_ref().unwrap().list(user, &query(&op["q"], &last));
                if let Ok(p) = &r {
                    if p.next_cursor.is_some() {
                        last.clone_from(&p.next_cursor);
                    }
                }
                wrap(r.map(|p| page_json(&p)))
            }
            "count" => wrap(s.as_ref().unwrap().count(user).map(|c| counts_json(&c))),
            "kindsOf" => wrap(with_ids(&op["ids"], |ids| {
                s.as_ref()
                    .unwrap()
                    .kinds_of(user, ids, op["what"] == "unread")
                    .map(|k| json!(k))
            })),
            "markRead" => wrap(with_ids(&op["ids"], |ids| {
                s.as_mut().unwrap().mark_read(user, ids).map(|n| json!(n))
            })),
            "dismiss" => wrap(with_ids(&op["ids"], |ids| {
                s.as_mut().unwrap().dismiss(user, ids).map(|n| json!(n))
            })),
            "settle" => wrap(
                s.as_mut()
                    .unwrap()
                    .settle(user, op["key"].as_str().unwrap())
                    .map(|b| json!(b)),
            ),
            "settleEverywhere" => wrap(
                s.as_mut()
                    .unwrap()
                    .settle_everywhere(op["key"].as_str().unwrap())
                    .map(|v| json!(v)),
            ),
            "advance" => {
                let n = clock
                    .0
                    .fetch_add(op["ms"].as_i64().unwrap(), Ordering::SeqCst)
                    + op["ms"].as_i64().unwrap();
                json!({"ok": n})
            }
            "reopen" => {
                drop(s.take());
                s = Some(mk().unwrap());
                json!({"ok": null})
            }
            "construct" => {
                let o = &op["options"];
                let other = dir.path().join("other").join("inbox.sqlite");
                wrap(
                    open(
                        other,
                        clock.clone(),
                        ids.clone(),
                        o["maxAgeMs"].as_f64(),
                        o["maxEntries"].as_f64(),
                    )
                    .map(|t| {
                        let (a, e) = t.retention();
                        json!({"maxAgeMs": a, "maxEntries": e})
                    }),
                )
            }
            "migrate" => wrap(
                migrate_breakglass_notices(s.as_mut().unwrap(), &notices_of(&op["notices"]))
                    .map(|n| json!(n)),
            ),
            other => panic!("{name}: unknown op {other}"),
        };
        assert_eq!(
            &json!({"op": op, "out": out}),
            step,
            "{name}: op {i} ({kind})"
        );
    }
    drop(s);
    let n = ids.0.load(Ordering::SeqCst);
    let got = json!({
        "tables": dump_tables(&path, &[("inbox_entries", &["params", "ref"]), ("inbox_cooldowns", &[])]),
        "schema": schema_of(&path),
        "ids": (1..=n).map(|i| format!("e{i}")).collect::<Vec<_>>(),
    });
    assert_eq!(got, sc["final"], "{name}: final state");
}

#[test]
fn every_store_scenario_gives_typescripts_answers_rows_and_schema() {
    let f = fixture("store");
    let all = f.as_array().unwrap();
    assert!(all.len() >= 11);
    for sc in all {
        replay_store(sc);
    }
}

fn target_of(v: &Value) -> SettleTarget {
    match (v["userId"].as_str(), v["audience"].as_str()) {
        (Some(u), _) => SettleTarget::User(u.to_owned()),
        (_, Some("all")) => SettleTarget::All,
        _ => SettleTarget::Admins,
    }
}

type Shared<T> = Arc<Mutex<T>>;

fn replay_service(sc: &Value) {
    let name = sc["name"].as_str().unwrap();
    let w = &sc["world"];
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("inbox.sqlite");
    let clock = Arc::new(TestClock(AtomicI64::new(
        w["now"].as_i64().unwrap_or(1_000_000),
    )));
    let ids = Arc::new(SeqIds::default());
    let admins: Shared<Vec<String>> = Arc::new(Mutex::new(strings(&w["admins"])));
    let events: Shared<Vec<InboxChange>> = Arc::default();
    let ticks: Shared<Vec<String>> = Arc::default();
    let logs: Shared<Vec<Value>> = Arc::default();
    let fail_listener = Arc::new(AtomicBool::new(false));
    let fail_metric = Arc::new(AtomicBool::new(false));
    let store: InboxStore = open(path.clone(), clock.clone(), ids.clone(), None, None).unwrap();
    let mut svc = InboxService::new(InboxServiceOptions {
        store,
        admins: {
            let a = admins.clone();
            Box::new(move || a.lock().unwrap().clone())
        },
        on_change: Some({
            let (e, f) = (events.clone(), fail_listener.clone());
            Box::new(move |c| {
                e.lock().unwrap().push(c.clone());
                if f.load(Ordering::SeqCst) {
                    return Err("listener boom".into());
                }
                Ok(())
            })
        }),
        on_published: Some({
            let (t, f) = (ticks.clone(), fail_metric.clone());
            Box::new(move |k| {
                t.lock().unwrap().push(k.to_owned());
                if f.load(Ordering::SeqCst) {
                    return Err("metric boom".into());
                }
                Ok(())
            })
        }),
        log: Some({
            let l = logs.clone();
            Box::new(move |m, f| l.lock().unwrap().push(json!({"message": m, "fields": f})))
        }),
    });
    for (i, step) in sc["ops"].as_array().unwrap().iter().enumerate() {
        let op = &step["op"];
        let kind = op["op"].as_str().unwrap();
        let user = op["user"].as_str().unwrap_or_default();
        events.lock().unwrap().clear();
        ticks.lock().unwrap().clear();
        logs.lock().unwrap().clear();
        let out = match kind {
            "publish" => {
                svc.publish(
                    &notice_of(&op["notice"]),
                    op["options"]["cooldownMs"].as_f64(),
                );
                json!({"ok": null})
            }
            "settle" => {
                svc.settle(&target_of(&op["target"]), op["key"].as_str().unwrap());
                json!({"ok": null})
            }
            "list" => wrap(
                svc.list(user, &query(&op["q"], &None))
                    .map(|p| page_json(&p)),
            ),
            "count" => wrap(svc.count(user).map(|c| counts_json(&c))),
            "markRead" => wrap(with_ids(&op["ids"], |ids| {
                svc.mark_read(user, ids).map(|n| json!(n))
            })),
            "dismiss" => wrap(with_ids(&op["ids"], |ids| {
                svc.dismiss(user, ids).map(|n| json!(n))
            })),
            "admins" => {
                *admins.lock().unwrap() = strings(&op["admins"]);
                json!({"ok": null})
            }
            "failListener" => {
                fail_listener.store(op["on"].as_bool().unwrap(), Ordering::SeqCst);
                json!({"ok": null})
            }
            "failMetric" => {
                fail_metric.store(op["on"].as_bool().unwrap(), Ordering::SeqCst);
                json!({"ok": null})
            }
            "advance" => {
                let ms = op["ms"].as_i64().unwrap();
                json!({"ok": clock.0.fetch_add(ms, Ordering::SeqCst) + ms})
            }
            other => panic!("{name}: unknown op {other}"),
        };
        let mut got = json!({"op": op, "out": out});
        let ev: Vec<Value> = events
            .lock()
            .unwrap()
            .iter()
            .map(|c| json!({"userId": c.user_id, "change": c.change, "kinds": c.kinds}))
            .collect();
        if !ev.is_empty() {
            got["events"] = json!(ev);
        }
        let tk = ticks.lock().unwrap().clone();
        if !tk.is_empty() {
            got["ticks"] = json!(tk);
        }
        let lg = logs.lock().unwrap().clone();
        if !lg.is_empty() {
            got["logs"] = json!(lg);
        }
        assert_eq!(&got, step, "{name}: op {i} ({kind})");
    }
    drop(svc);
    let got = dump_tables(
        &path,
        &[
            ("inbox_entries", &["params", "ref"]),
            ("inbox_cooldowns", &[]),
        ],
    );
    assert_eq!(got, sc["final"]["tables"], "{name}: final tables");
}

#[test]
fn every_service_scenario_gives_typescripts_answers_events_and_log_lines() {
    let f = fixture("service");
    let all = f.as_array().unwrap();
    assert!(all.len() >= 4);
    for sc in all {
        replay_service(sc);
    }
}

#[derive(Default)]
struct Rec(Vec<Value>);
impl InboxPort for Rec {
    fn publish(&mut self, n: &InboxNotice, cooldown_ms: Option<f64>) {
        let mut v = json!({"publish": notice_json(n)});
        if let Some(c) = cooldown_ms {
            v["options"] = json!({"cooldownMs": c});
        }
        self.0.push(v);
    }
    fn settle(&mut self, target: &SettleTarget, key: &str) {
        let t = match target {
            SettleTarget::User(u) => json!({"userId": u}),
            SettleTarget::Admins => json!({"audience": "admins"}),
            SettleTarget::All => json!({"audience": "all"}),
        };
        self.0.push(json!({"settle": {"target": t, "key": key}}));
    }
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}

fn replay_producer(c: &Value) -> Value {
    let f = s(&c["fn"]);
    let a = &c["args"];
    let mut rec = Rec::default();
    let out = |rec: Rec| json!({"fn": f, "args": a, "calls": rec.0});
    match f {
        "approvalToInbox" => approval_to_inbox(&mut rec, s(&a[0]), &a[1]),
        "jobFailedToInbox" => {
            let r = &a[0];
            job_failed_to_inbox(
                &mut rec,
                &JobRun {
                    run_id: s(&r["runId"]),
                    job: s(&r["job"]),
                    reason: r["reason"].as_str(),
                },
            );
        }
        "mediaToInbox" => media_to_inbox(&mut rec, s(&a[0]), &a[1]),
        "pairingToInbox" => pairing_to_inbox(
            &mut rec,
            s(&a[0]["action"]),
            s(&a[0]["target"]),
            &a[0]["detail"],
        ),
        "channelToInbox" => channel_to_inbox(&mut rec, s(&a[0]), &a[1]),
        "breakglassToInbox" => breakglass_to_inbox(&mut rec, &notices_of(&json!([a[0]]))[0]),
        "breakglassDraft" => {
            let d = breakglass_draft(&notices_of(&json!([a[0]]))[0]);
            let params: serde_json::Map<String, Value> = d.params.unwrap().into_iter().collect();
            let r = d.reference.unwrap();
            return json!({"fn": f, "args": a, "draft": {"userId": d.user_id, "kind": d.kind, "severity": d.severity, "titleKey": d.title_key,
                "params": params, "ref": {"route": r.route, "objectId": r.object_id}, "dedupeKey": d.dedupe_key}});
        }
        "alwaysGrantsToInbox" => {
            let grants: Vec<GrantInfo<'_>> = a[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| GrantInfo {
                    id: s(&g["id"]),
                    person: s(&g["person"]),
                    agent: s(&g["agent"]),
                    capability: s(&g["capability"]),
                    scope: s(&g["scope"]),
                    created_at: g["createdAt"].as_i64().unwrap(),
                })
                .collect();
            always_grants_to_inbox(&mut rec, &grants, a[1].as_i64().unwrap());
        }
        other => panic!("unknown producer {other}"),
    }
    out(rec)
}

#[test]
fn every_producer_case_gives_typescripts_notices_including_the_masked_params() {
    let f = fixture("producers");
    let cases = f.as_array().unwrap();
    assert!(cases.len() > 300);
    for c in cases {
        let got = replay_producer(c);
        // The reason text of a break-glass notice is never copied.
        assert_eq!(&got, c, "{} {}", c["fn"], c["args"]);
    }
}
