//! Replays `fixtures/parity/delivery/*.json` (mode V, `scripts/parity/export-delivery.ts`): the allowlist rule over every
//! recorded case and every scenario of the delivery targets over a real store file. Each op must give the answer TypeScript
//! gave, write the audit lines it wrote, send the messages it sent, and the table, the schema text and the ids and codes at
//! the end must be the ones TypeScript left.
use super::testing::{identity_of, link_of, Rig};
use super::{delivery_allowed, DeliveryError};
use crate::handoff::testing::{dump_tables, principal_of, schema_of};
use crate::handoff::{ChatKind, InboundMessage};
use crate::rbac::types::Principal;
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let text = match name {
        "policy" => include_str!("../../../../fixtures/parity/delivery/policy.json"),
        "rules" => include_str!("../../../../fixtures/parity/delivery/rules.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

fn err_json(e: &DeliveryError) -> Value {
    match e {
        DeliveryError::Rpc { code, message } => json!({"code": code, "message": message}),
        DeliveryError::Audit(m) | DeliveryError::Store(m) => json!({"name": "Error", "message": m}),
    }
}

fn wrap(r: Result<Value, DeliveryError>) -> Value {
    match r {
        Ok(v) => json!({"ok": v}),
        Err(e) => json!({"err": err_json(&e)}),
    }
}

fn principal(v: &Value) -> Principal {
    principal_of(v["userId"].as_str().unwrap(), v)
}

fn to<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap()
}

#[test]
fn the_allowlist_rule_gives_typescripts_answers_for_every_recorded_case() {
    let f = fixture("policy");
    let keys = f["buzzKeys"].as_object().unwrap().clone();
    let buzz = |s: &str| keys.get(s).and_then(Value::as_str).map(str::to_owned);
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() > 2000, "the grid is part of the contract");
    let (mut yes, mut no) = (0, 0);
    for c in cases {
        let got = delivery_allowed(&c["channels"], &identity_of(&c["identity"]), &buzz);
        assert_eq!(got, c["allowed"].as_bool().unwrap(), "{c}");
        if got {
            yes += 1;
        } else {
            no += 1;
        }
    }
    assert!(
        yes >= 40 && no >= 1000,
        "both answers are well represented: {yes} {no}"
    );
}

fn replay(sc: &Value) {
    let name = sc["name"].as_str().unwrap();
    let mut rig = Rig::new(&sc["world"]);
    let mut codes: Vec<String> = Vec::new();
    for (i, step) in sc["ops"].as_array().unwrap().iter().enumerate() {
        let op = &step["op"];
        let kind = op["op"].as_str().unwrap();
        {
            let mut w = rig.w.lock().unwrap();
            w.audit.clear();
            w.sent.clear();
        }
        let id = {
            let w = rig.w.lock().unwrap();
            match op["nth"].as_u64() {
                Some(n) => w.ids.get(n as usize).cloned().unwrap_or_default(),
                None => op["id"].as_str().unwrap_or_default().to_owned(),
            }
        };
        let text = |t: &str| {
            let last = codes.last().map_or("undefined", String::as_str);
            let mut s = t.replace("{code}", last);
            if let Some(a) = s.find("{code") {
                if let Some(len) = s[a..].find('}') {
                    if let Ok(n) = s[a + 5..a + len].parse::<usize>() {
                        let c = codes.get(n).map_or("undefined", String::as_str).to_owned();
                        s.replace_range(a..=a + len, &c);
                    }
                }
            }
            s
        };
        let person = op["person"].as_str().unwrap_or_default().to_owned();
        let agent = op["agentId"].as_str().unwrap_or_default().to_owned();
        let out = match kind {
            "add" => {
                let identity = if op["identity"].is_null() {
                    super::ChannelIdentity {
                        channel: "telegram".into(),
                        account_id: "bot".into(),
                        user_id: "sender".into(),
                    }
                } else {
                    identity_of(&op["identity"])
                };
                let r = rig.d().add(&identity, &principal(&op["caller"]));
                if let Ok(t) = &r {
                    let mut w = rig.w.lock().unwrap();
                    if !w.ids.contains(&t.id) {
                        w.ids.push(t.id.clone());
                    }
                }
                wrap(r.map(to))
            }
            "challenge" => wrap(rig.d().challenge(&id, &principal(&op["caller"])).map(to)),
            "confirm" => {
                let mut m = json!({"channel": "telegram", "chatId": "dm", "chatKind": "direct", "accountId": "bot", "senderId": "sender"});
                if let Some(o) = op["msg"].as_object() {
                    for (k, v) in o {
                        m[k] = v.clone();
                    }
                }
                let msg = InboundMessage {
                    channel: m["channel"].as_str().unwrap().into(),
                    chat_id: m["chatId"].as_str().unwrap().into(),
                    chat_kind: match m["chatKind"].as_str().unwrap() {
                        "direct" => ChatKind::Direct,
                        "group" => ChatKind::Group,
                        _ => ChatKind::Broadcast,
                    },
                    sender_id: m["senderId"].as_str().unwrap().into(),
                    account_id: m["accountId"].as_str().map(str::to_owned),
                    text: text(op["text"].as_str().unwrap()),
                };
                wrap(rig.d().confirm_message(&msg, &person).map(Value::Bool))
            }
            "list" => wrap(rig.d().list(&principal(&op["caller"])).map(to)),
            "eligible" => wrap(rig.d().eligible(&principal(&op["caller"])).map(to)),
            "remove" => wrap(
                rig.d()
                    .remove(&id, &principal(&op["caller"]))
                    .map(|_| json!({"removed": true})),
            ),
            "validate" => wrap(rig.d().validate(&id, &person, &agent).map(to)),
            "deliver" => wrap(
                rig.d()
                    .deliver(&id, &person, &agent, op["text"].as_str().unwrap())
                    .map(|_| json!({"sent": true})),
            ),
            "subscribe" => wrap(
                rig.d()
                    .subscribe(
                        &id,
                        op["source"].as_str().unwrap(),
                        op["job"].as_str().unwrap(),
                        &agent,
                        &principal(&op["caller"]),
                    )
                    .map(|_| json!({"subscribed": true})),
            ),
            "notify" => wrap(
                rig.d()
                    .notify(
                        op["source"].as_str().unwrap(),
                        op["job"].as_str().unwrap(),
                        op["agentId"].as_str(),
                        op["outcome"].as_str().unwrap(),
                    )
                    .map(|()| Value::Null),
            ),
            "advance" => {
                let mut w = rig.w.lock().unwrap();
                w.now += op["ms"].as_i64().unwrap();
                json!({"ok": w.now})
            }
            "world" => {
                rig.w.lock().unwrap().patch(&op["patch"]);
                json!({"ok": null})
            }
            "link" => {
                rig.w.lock().unwrap().links.push(link_of(&op["link"]));
                json!({"ok": null})
            }
            "unlink" => {
                let i = identity_of(op);
                rig.w.lock().unwrap().links.retain(|l| l.identity != i);
                json!({"ok": null})
            }
            "principal" => {
                let mut w = rig.w.lock().unwrap();
                let p = op["person"].as_str().unwrap().to_owned();
                w.principals.retain(|(k, _)| *k != p);
                if !op["principal"].is_null() {
                    w.principals.push((p, op["principal"].clone()));
                }
                json!({"ok": null})
            }
            "hook" => {
                rig.w.lock().unwrap().hooks.push_back(op["hook"].clone());
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
        let (audit, sent) = {
            let w = rig.w.lock().unwrap();
            (
                w.audit
                    .iter()
                    .map(|a| json!({"at": a.at, "user": a.user, "host": a.host, "action": a.action, "target": a.target, "detail": {}}))
                    .collect::<Vec<_>>(),
                w.sent
                    .iter()
                    .map(|(c, ch, t)| json!({"channel": c, "chatId": ch, "text": t}))
                    .collect::<Vec<_>>(),
            )
        };
        for (_, _, t) in &rig.w.lock().unwrap().sent {
            if let Some(code) = t.strip_prefix("Confirm delivery in this DM: /delivery ") {
                if code.len() == 32 && !codes.iter().any(|c| c == code) {
                    codes.push(code.to_owned());
                }
            }
        }
        let mut got = json!({"op": op, "out": out});
        if !audit.is_empty() {
            got["audit"] = Value::Array(audit);
        }
        if !sent.is_empty() {
            got["sent"] = Value::Array(sent);
        }
        assert_eq!(&got, step, "{name}: op {i} ({kind})");
    }
    let w = rig.w.lock().unwrap();
    let got = json!({
        "tables": dump_tables(&rig.path, &[("delivery_targets", &["value"])]),
        "schema": schema_of(&rig.path),
        "ids": w.ids,
        "codes": codes,
    });
    assert_eq!(got, sc["final"], "{name}: final state");
}

#[test]
fn every_scenario_gives_typescripts_answers_audit_lines_messages_rows_and_schema() {
    let f = fixture("rules");
    let all = f.as_array().unwrap();
    assert!(all.len() >= 16);
    for sc in all {
        replay(sc);
    }
}
