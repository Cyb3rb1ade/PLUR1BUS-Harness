//! Replays `fixtures/parity/handoff/*.json` (mode V, `scripts/parity/export-handoff.ts`): the Web address rule and every
//! scenario of the hand-off over a real store file. Each op must give the answer TypeScript gave, write the audit lines it
//! wrote, and the four tables, the sessions and the schema text at the end must be the ones TypeScript left.
use super::testing::{dump_tables, link_of, message_of, principal_of, schema_of, sess_of, Rig};
use super::{web_base, ChatKind, HandoffError, HistoryEntry, InboundMessage};
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let text = match name {
        "web-base" => include_str!("../../../../fixtures/parity/handoff/web-base.json"),
        "rules" => include_str!("../../../../fixtures/parity/handoff/rules.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

fn err_json(e: &HandoffError) -> Value {
    match e {
        HandoffError::Rpc { code, message } => json!({"code": code, "message": message}),
        HandoffError::Audit(m) => json!({"name": "Error", "message": m}),
        HandoffError::Identity(m) => json!({"name": "IdentityError", "message": m}),
        HandoffError::Store(m) => json!({"name": "StoreError", "message": m}),
    }
}

fn wrap(r: Result<Value, HandoffError>) -> Value {
    match r {
        Ok(v) => json!({"ok": v}),
        Err(e) => json!({"err": err_json(&e)}),
    }
}

fn msg(v: &Value) -> InboundMessage {
    InboundMessage {
        channel: v["channel"].as_str().unwrap().into(),
        chat_id: v["chatId"].as_str().unwrap().into(),
        chat_kind: match v["chatKind"].as_str().unwrap() {
            "direct" => ChatKind::Direct,
            "group" => ChatKind::Group,
            _ => ChatKind::Broadcast,
        },
        sender_id: v["senderId"].as_str().unwrap().into(),
        account_id: v["accountId"].as_str().map(str::to_owned),
        text: v["text"].as_str().unwrap().into(),
    }
}

fn entry(e: &HistoryEntry) -> Value {
    let mut o = json!({"id": e.id, "agentId": e.agent_id, "channel": e.channel, "updatedAt": e.updated_at, "readOnly": true});
    if let Some(t) = &e.title {
        o["title"] = json!(t);
    }
    o
}

#[test]
fn the_web_address_rule_gives_typescripts_answers() {
    for c in fixture("web-base").as_array().unwrap() {
        let input = c["input"].as_str().unwrap();
        let got = match web_base(input) {
            Ok(v) => json!({"input": input, "ok": v}),
            Err(e) => json!({"input": input, "err": err_json(&e)}),
        };
        assert_eq!(&got, c, "web_base({input:?})");
    }
}

fn replay(sc: &Value) {
    let name = sc["name"].as_str().unwrap();
    let mut rig = Rig::new(&sc["world"]);
    let mut tokens: Vec<String> = Vec::new();
    for (i, step) in sc["ops"].as_array().unwrap().iter().enumerate() {
        let op = &step["op"];
        let kind = op["op"].as_str().unwrap();
        rig.w.lock().unwrap().audit.clear();
        let person = op["person"].as_str().unwrap_or_default().to_owned();
        let out = match kind {
            "observe" => wrap(rig.h().observe(&msg(&op["msg"]), &person, op["sessionId"].as_str().unwrap()).map(|()| Value::Null)),
            "observeMany" => {
                for n in 0..op["count"].as_u64().unwrap() {
                    let sess = sess_of(&json!({"id": format!("b{n}"), "kind": "channel", "ownerPerson": person, "chatKey": format!("telegram:c{n}"), "agentId": "main", "title": "Private DM", "updatedAt": 500}));
                    rig.w.lock().unwrap().sessions.push(sess);
                    let m = InboundMessage { chat_id: format!("c{n}"), ..msg(&json!({"channel": "telegram", "chatId": "dm", "chatKind": "direct", "senderId": "sender", "accountId": "bot", "text": "hello"})) };
                    rig.h().observe(&m, &person, &format!("b{n}")).unwrap();
                }
                json!({"ok": null})
            }
            "issue" => wrap(rig.h().issue(op["id"].as_str().unwrap(), &person).map(|r| {
                tokens.push(r.token.clone());
                json!({"token": r.token, "expiresAt": r.expires_at, "path": r.path})
            })),
            "issueMessage" => wrap(rig.h().issue_message(&msg(&op["msg"]), &person).map(|r| {
                tokens.push(r.rsplit('/').next().unwrap().to_owned());
                json!(r)
            })),
            "redeem" => {
                let token = match op["token"].as_str() {
                    Some(t) => t.to_owned(),
                    None => tokens[op["nth"].as_u64().map_or(tokens.len() - 1, |n| n as usize)].clone(),
                };
                wrap(rig.h().redeem(&token, &person).map(|r| json!({"sessionId": r.session_id, "handoffFrom": {"sessionId": r.from_session_id, "channel": r.from_channel}})))
            }
            "list" => wrap(rig.h().list(&person).map(|l| json!({"sessions": l.sessions.iter().map(entry).collect::<Vec<_>>(), "truncated": l.truncated}))),
            "get" => wrap(rig.h().get(op["id"].as_str().unwrap(), &person).map(|v| {
                json!({"session": entry(&v.session), "messages": v.messages.iter().map(|m| json!({"role": m.role, "text": m.text, "createdAt": m.created_at})).collect::<Vec<_>>()})
            })),
            "advance" => {
                let mut w = rig.w.lock().unwrap();
                w.now += op["ms"].as_i64().unwrap();
                json!({"ok": w.now})
            }
            "unlink" => {
                let (c, a, u) = (op["channel"].as_str().unwrap(), op["accountId"].as_str().unwrap(), op["userId"].as_str().unwrap());
                rig.w.lock().unwrap().links.retain(|l| !(l.0 == c && l.1 == a && l.2 == u));
                json!({"ok": null})
            }
            "link" => {
                rig.w.lock().unwrap().links.push(link_of(&op["link"]));
                json!({"ok": null})
            }
            "principal" => {
                let mut w = rig.w.lock().unwrap();
                w.principals.retain(|(k, _)| k != &person);
                if !op["principal"].is_null() {
                    w.principals.push((person.clone(), op["principal"].clone()));
                }
                let _ = principal_of;
                json!({"ok": null})
            }
            "addMessages" => {
                let id = op["sessionId"].as_str().unwrap();
                let mut w = rig.w.lock().unwrap();
                let s = w.sessions.iter_mut().find(|s| s.id == id).unwrap();
                s.messages.extend(op["messages"].as_array().unwrap().iter().map(message_of));
                json!({"ok": null})
            }
            "patchSession" => {
                let id = op["sessionId"].as_str().unwrap();
                let mut w = rig.w.lock().unwrap();
                let s = w.sessions.iter_mut().find(|s| s.id == id).unwrap();
                let p = &op["patch"];
                if let Some(k) = p["kind"].as_str() {
                    s.kind = k.to_owned();
                }
                if let Some(o) = p["ownerPerson"].as_str() {
                    s.owner = crate::identity::principals::derive_user_principal(o).unwrap();
                }
                json!({"ok": null})
            }
            "addSession" => {
                let mut v = op["over"].clone();
                v["id"] = op["id"].clone();
                rig.w.lock().unwrap().sessions.push(sess_of(&v));
                json!({"ok": null})
            }
            "base" => {
                rig.w.lock().unwrap().base_url = op["baseUrl"].as_str().unwrap().into();
                json!({"ok": null})
            }
            "store" => {
                rig.w.lock().unwrap().store_available = op["available"].as_bool().unwrap();
                json!({"ok": null})
            }
            "auditFail" => {
                rig.w.lock().unwrap().audit_fail = op["fail"].as_bool().unwrap();
                json!({"ok": null})
            }
            "reopen" => {
                rig.reopen();
                json!({"ok": null})
            }
            other => panic!("{name}: unknown op {other}"),
        };
        assert_eq!(out, step["out"], "{name}: op {i} {op}");
        let audit: Vec<Value> = rig
            .w
            .lock()
            .unwrap()
            .audit
            .iter()
            .map(|a| json!({"at": a.at, "user": a.user, "host": a.host, "action": a.action, "target": a.target, "detail": {}}))
            .collect();
        let want = step.get("audit").cloned().unwrap_or_else(|| json!([]));
        assert_eq!(Value::Array(audit), want, "{name}: op {i} audit lines");
    }
    rig.h = None;
    let tables = dump_tables(
        &rig.path,
        &[
            ("channel_taint", &[]),
            ("channel_direct", &["value"]),
            ("channel_handoffs", &[]),
            ("channel_continuations", &["source"]),
        ],
    );
    assert_eq!(tables, sc["final"]["tables"], "{name}: final rows");
    assert_eq!(
        schema_of(&rig.path),
        sc["final"]["schema"],
        "{name}: schema text"
    );
    let w = rig.w.lock().unwrap();
    let sessions: Vec<Value> = w
        .sessions
        .iter()
        .map(|s| {
            let mut o = json!({"id": s.id, "kind": s.kind, "owner": w.person_of(&s.owner), "messages": s.messages.len()});
            if let Some(m) = s.messages.first() {
                o["firstText"] = json!(m.text);
            }
            o
        })
        .collect();
    assert_eq!(
        Value::Array(sessions),
        sc["final"]["sessions"],
        "{name}: sessions at the end"
    );
}

#[test]
fn every_scenario_gives_typescripts_answers_audit_lines_rows_and_schema() {
    let rules = fixture("rules");
    let list = rules.as_array().unwrap();
    assert!(list.len() >= 18, "the scenario list shrank");
    for sc in list {
        replay(sc);
    }
}
