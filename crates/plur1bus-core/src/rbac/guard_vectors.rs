//! Replay of the vectors recorded from the TypeScript guard, break-glass registry and audit writers
//! (`scripts/parity/export-rbac-guard.ts`, `fixtures/parity/rbac-guard/`). Recorded, never edited by hand.
use super::audit::{audit_line, detail_redactor, order, AuditEvent, AuditSink, JsonlAuditSink};
use super::break_glass::{
    BreakGlass, BreakGlassLimits, BreakGlassNotice, BreakGlassOptions, BreakGlassRequest,
};
use super::guard::{
    guard, principal_js, record, ApiContext, CallFacts, Caller, Resolved, RPC_RULES,
};
use super::loose::Js;
use super::types::{
    AgentRight, BreakGlassGrant, Decision, MemoryAgentScope, Principal, PrincipalKind, Resource,
    Role,
};
use crate::identity::audit::AuditWriter;
use crate::identity::service_impl::{AuditActor, AuditEvent as IdentityEvent, IdentityAudit};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/rbac-guard/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A parameter shape of the fixtures: "" is "no parameters".
fn params_of(text: &str) -> Option<Value> {
    (!text.is_empty()).then(|| serde_json::from_str(text).unwrap())
}

#[test]
fn the_rule_table_is_the_typescript_table_row_for_row() {
    let rules = load("rules");
    let methods = rules["methods"].as_array().unwrap();
    assert_eq!(RPC_RULES.len(), methods.len());
    let shapes = rules["shapes"].as_object().unwrap();
    assert!(shapes.len() >= 14);
    let mut wrong = Vec::new();
    for (rule, recorded) in RPC_RULES.iter().zip(methods) {
        let same = recorded["method"] == rule.method
            && recorded["action"] == rule.action
            && recorded["humanOnly"] == (rule.caller == Caller::Human)
            && recorded["apiServiceOnly"] == (rule.caller == Caller::Service);
        if !same {
            wrong.push(format!("{} is {rule:?}, recorded {recorded}", rule.method));
            continue;
        }
        let resources = &rules["resources"][recorded["resource"].as_u64().unwrap() as usize];
        for (shape, text) in shapes {
            let built = rule
                .resource
                .build(params_of(text.as_str().unwrap()).as_ref())
                .to_value();
            if built != resources[shape] {
                wrong.push(format!(
                    "{} with params {shape}: {built} instead of {}",
                    rule.method, resources[shape]
                ));
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "{} rows differ:\n{}",
        wrong.len(),
        wrong[..wrong.len().min(8)].join("\n")
    );
    let mut names: Vec<&str> = RPC_RULES.iter().map(|r| r.method).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), RPC_RULES.len(), "a method has two rules");
}

fn event_json(e: &AuditEvent) -> Value {
    order::tag(e.to_json(), &e.detail)
}

#[test]
fn every_recorded_guard_decision_is_reproduced_with_its_audit_event() {
    let g = load("guard");
    let table = |name: &str| -> Vec<String> {
        g["tables"][name]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    };
    let (methods, params, resolvers, ctxs, outcomes) = (
        table("method"),
        table("params"),
        table("resolver"),
        table("ctx"),
        table("outcome"),
    );
    // The action of a method comes from the recorded table, not from the Rust one: a wrong row cannot vouch for itself.
    let rules = load("rules");
    let actions: std::collections::HashMap<&str, &str> = rules["methods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["method"].as_str().unwrap(), m["action"].as_str().unwrap()))
        .collect();
    let now = g["index"]["now"].as_i64().unwrap();
    let host = g["index"]["host"].as_str().unwrap();
    let (mut total, mut wrong) = (0usize, Vec::new());
    for (layer, lines) in g["layers"].as_object().unwrap() {
        for line in lines.as_array().unwrap() {
            total += 1;
            let line = line.as_str().unwrap();
            let (refs, outcome) = line.split_once('\t').unwrap();
            let refs: Vec<usize> = refs.split('.').map(|r| r.parse().unwrap()).collect();
            let method = methods[refs[0]].as_str();
            let action = actions[method];
            let resolver: Value = serde_json::from_str(
                &resolvers[refs[2]].replace("\"$A\"", &json!(action).to_string()),
            )
            .unwrap();
            let ctx: Value = serde_json::from_str(&ctxs[refs[3]]).unwrap();
            let outcome_text = outcomes[outcome.parse::<usize>().unwrap()]
                .replace(
                    "\"target\":\"$M\"",
                    &format!("\"target\":{}", json!(method)),
                )
                .replace(
                    "\"action\":\"$A\"",
                    &format!("\"action\":{}", json!(action)),
                )
                .replace("not permitted: $A", &format!("not permitted: {action}"));
            let mut expected: Value = serde_json::from_str(&outcome_text).unwrap();
            // The recorded member order of every audit detail, beside its values.
            expected["audit"] = order::tagged(&outcome_text, &["audit"], expected.get("audit"));
            let principal = resolver.get("principal").map(Js::from_value);
            let resolved = match (resolver.get("kind").and_then(Value::as_str), &principal) {
                (None | Some("async"), Some(p)) => Resolved::Principal(p),
                (Some("null" | "undefined"), _) => Resolved::Nobody,
                (Some("throws" | "throws-denied"), _) => Resolved::Failed,
                (Some("throws-disabled"), _) => Resolved::Disabled("person is disabled"),
                other => panic!("resolver {other:?}"),
            };
            let facts = CallFacts {
                client: ctx.get("client") == Some(&json!(true)),
                api: match ctx.get("api").and_then(Value::as_str) {
                    Some("service") => ApiContext::Service,
                    Some("principal") => ApiContext::Principal,
                    _ => ApiContext::NotApi,
                },
            };
            let decision = guard(
                method,
                &resolved,
                params_of(&params[refs[1]]).as_ref(),
                &facts,
                now,
                host,
            )
            .expect("a guarded method");
            let audit: Vec<Value> = decision.audit.iter().map(event_json).collect();
            let service = RPC_RULES
                .iter()
                .any(|r| r.method == method && r.caller == Caller::Service);
            let actual = match &decision.outcome {
                Ok(()) => json!({ "ok": "handled", "authenticated": !service, "audit": audit }),
                Err(r) => {
                    json!({ "err": { "error": r.code, "message": r.message, "reason": r.reason }, "audit": audit })
                }
            };
            if actual != expected && wrong.len() < 12 {
                wrong.push(format!("{layer} {method} params {} resolver {resolver} ctx {ctx}: {actual} instead of {expected}", params[refs[1]]));
            } else if actual != expected {
                wrong.push(String::new());
            }
        }
    }
    assert!(total >= 15_000, "{total} cases");
    assert!(
        wrong.is_empty(),
        "{} of {total} decisions differ:\n{}",
        wrong.len(),
        wrong[..wrong.len().min(12)].join("\n")
    );
}

#[test]
fn a_typed_principal_gets_the_decision_of_its_javascript_form_and_an_unguarded_method_no_decision()
{
    let mut p = Principal::new("u-member", Role::Member);
    p.kind = Some(PrincipalKind::Person);
    p.agent_rights = Some(vec![("a1".to_owned(), AgentRight::Use)]);
    p.token_scopes = Some(vec!["mcp:call".to_owned()]);
    let js = principal_js(&p, Some("a1"));
    assert_eq!(
        js.to_value(),
        json!({ "userId": "u-member", "kind": "person", "role": "member", "agentRights": { "a1": "use" },
        "tokenScopes": ["mcp:call"], "binding": { "agentId": "a1" } })
    );
    // The fallback: an MCP token may start a turn on an agent its person may use, although its scopes do not name `agent.use`.
    let facts = CallFacts::default();
    let run = |params: Value| {
        guard(
            "external.turn.start",
            &Resolved::Principal(&js),
            Some(&params),
            &facts,
            1,
            "h",
        )
        .unwrap()
        .outcome
    };
    assert_eq!(run(json!({ "agentId": "a1" })), Ok(()));
    assert_eq!(
        run(json!({ "agentId": "a2" })).unwrap_err().reason,
        "token-scope"
    );
    // Parameters that name no agent are refused by the rule's own resource before any scope is looked at, so the bound
    // agent of the token is never reached (as in TypeScript: layer `fallback` with empty parameters records it).
    assert_eq!(run(json!({})).unwrap_err().reason, "resource-mismatch");
    assert!(guard(
        "system.ping",
        &Resolved::Nobody,
        None,
        &CallFacts::default(),
        1,
        "h"
    )
    .is_none());
    // A sink that fails does not change a refusal.
    let d = guard(
        "chat.list",
        &Resolved::Nobody,
        None,
        &CallFacts::default(),
        1,
        "h",
    )
    .unwrap();
    let mut failing = |_: &AuditEvent| Err("down".to_owned());
    record(&d, &mut failing);
    assert_eq!(d.outcome.unwrap_err().code, "E_UNAUTHORIZED");
}

fn principal_of(v: &Value) -> Principal {
    let mut p = Principal::new(
        v["userId"].as_str().unwrap(),
        Role::parse(v["role"].as_str().unwrap()).unwrap(),
    );
    p.kind = v
        .get("kind")
        .map(|k| PrincipalKind::parse(k.as_str().unwrap()).unwrap());
    p.token_scopes = v.get("tokenScopes").map(|s| {
        s.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_owned())
            .collect()
    });
    p.break_glass = v.get("breakGlass").map(|list| {
        list.as_array()
            .unwrap()
            .iter()
            .map(|g| BreakGlassGrant {
                id: g["id"].as_str().unwrap().to_owned(),
                holder_user_id: g["holderUserId"].as_str().unwrap().to_owned(),
                target_user_id: g["targetUserId"].as_str().unwrap().to_owned(),
                reason: g["reason"].as_str().unwrap().to_owned(),
                issued_at: g["issuedAt"].as_f64().unwrap(),
                expires_at: g["expiresAt"].as_f64().unwrap(),
                revoked_at: None,
            })
            .collect()
    });
    p
}

fn resource_of(v: &Value) -> Resource {
    match (
        v["kind"].as_str().unwrap(),
        v.get("scope").and_then(Value::as_str),
    ) {
        ("system", _) => Resource::System,
        ("memory", Some("user")) => Resource::MemoryUser {
            owner_user_id: v["ownerUserId"].as_str().unwrap().to_owned(),
        },
        ("memory", Some("workspace")) => Resource::MemoryAgent {
            scope: MemoryAgentScope::Workspace,
            agent_id: v["agentId"].as_str().unwrap().to_owned(),
        },
        other => panic!("resource {other:?}"),
    }
}

fn grant_json(g: &BreakGlassGrant) -> Value {
    json!({ "id": g.id, "holderUserId": g.holder_user_id, "targetUserId": g.target_user_id, "reason": g.reason,
        "issuedAt": g.issued_at as i64, "expiresAt": g.expires_at as i64 })
}

fn decision_json(d: &Decision) -> Value {
    match d {
        Decision::Allow {
            reason,
            break_glass_id,
        } => {
            let mut out = json!({ "effect": "allow", "reason": reason.as_str() });
            if let Some(id) = break_glass_id {
                out["breakGlassId"] = json!(id);
            }
            out
        }
        Decision::Deny { reason } => json!({ "effect": "deny", "reason": reason.as_str() }),
    }
}

#[test]
fn every_recorded_break_glass_sequence_replays_step_for_step() {
    let fixture = load("break-glass");
    let scenarios = fixture["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 6);
    let (mut steps, mut failures) = (0usize, Vec::new());
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let clock = Rc::new(Cell::new(0i64));
        let events: Rc<RefCell<Vec<Value>>> = Rc::default();
        let notices: Rc<RefCell<Vec<Value>>> = Rc::default();
        let (sink_down, notify_down) = (Rc::new(Cell::new(false)), Rc::new(Cell::new(false)));
        let mut registry: Option<BreakGlass> = None;
        for (index, line) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let text = line.as_str().unwrap();
            let step: Value = serde_json::from_str(text).unwrap();
            let (op, a) = (step["op"].as_str().unwrap(), &step["args"]);
            steps += 1;
            if op == "create" {
                let (c, e, n, sd, nd) = (
                    clock.clone(),
                    events.clone(),
                    notices.clone(),
                    sink_down.clone(),
                    notify_down.clone(),
                );
                let mut counter = 0;
                let limits = a.get("limits").map(|l| BreakGlassLimits {
                    reason_min_chars: l["reasonMinChars"].as_i64().unwrap(),
                    reason_max_chars: l["reasonMaxChars"].as_i64().unwrap(),
                    max_window_minutes: l["maxWindowMinutes"].as_i64().unwrap(),
                });
                registry = Some(BreakGlass::new(BreakGlassOptions {
                    audit: Box::new(move |ev: &AuditEvent| {
                        if sd.get() {
                            return Err("sink down".to_owned());
                        }
                        e.borrow_mut().push(order::tag(ev.to_json(), &ev.detail));
                        Ok(())
                    }),
                    limits: limits
                        .map(|l| Box::new(move || l) as Box<dyn Fn() -> BreakGlassLimits>),
                    notify: Box::new(move |notice: &BreakGlassNotice| {
                        if nd.get() {
                            return Err("notice store unavailable".to_owned());
                        }
                        n.borrow_mut().push(notice.to_json());
                        Ok(())
                    }),
                    require_notification: a.get("requireNotification") == Some(&json!(true)),
                    clock: Box::new(move || c.get()),
                    id_gen: Box::new(move || {
                        counter += 1;
                        format!("grant-{counter}")
                    }),
                    host: a.get("host").map(|h| h.as_str().unwrap().to_owned()),
                }));
                continue;
            }
            clock.set(step["at"].as_i64().unwrap());
            events.borrow_mut().clear();
            notices.borrow_mut().clear();
            let bg = registry.as_mut().unwrap();
            let out = match op {
                "request" => {
                    let req = &a["req"];
                    // The typed request cannot carry a target or reason that is not a string (TypeScript reads those as
                    // "") or a lifetime that is not a number (never an integer).
                    let request = BreakGlassRequest {
                        target_user_id: req["targetUserId"].as_str().unwrap_or("").to_owned(),
                        reason: req["reason"].as_str().unwrap_or("").to_owned(),
                        ttl_ms: req.get("ttlMs").map(|t| t.as_f64().unwrap_or(f64::NAN)),
                    };
                    bg.request(&principal_of(&a["holder"]), &request)
                        .map(|g| grant_json(&g))
                }
                "revoke" => bg
                    .revoke(&principal_of(&a["actor"]), a["grantId"].as_str().unwrap())
                    .map(|()| Value::Null),
                "sweep" => Ok(json!(bg.sweep())),
                "active" => Ok(Value::Array(
                    bg.active(a["holderUserId"].as_str().unwrap())
                        .iter()
                        .map(grant_json)
                        .collect(),
                )),
                "authorize" => {
                    let principal =
                        (!a["principal"].is_null()).then(|| principal_of(&a["principal"]));
                    Ok(decision_json(&bg.authorize(
                        principal.as_ref(),
                        a["action"].as_str().unwrap(),
                        &resource_of(&a["resource"]),
                    )))
                }
                "sink" => {
                    sink_down.set(a["down"].as_bool().unwrap());
                    Ok(Value::Null)
                }
                "notify" => {
                    notify_down.set(a["down"].as_bool().unwrap());
                    Ok(Value::Null)
                }
                other => panic!("unknown op {other}"),
            };
            let out = match out {
                Ok(v) => json!({ "ok": v }),
                Err(e) => json!({ "err": { "code": e.code.as_str(), "message": e.message } }),
            };
            let mut wrong = Vec::new();
            if out != step["out"] {
                wrong.push(format!("out {out} instead of {}", step["out"]));
            }
            for (what, seen) in [("audit", &events), ("notices", &notices)] {
                let seen = Value::Array(seen.borrow().clone());
                let recorded = match what {
                    "audit" => order::tagged(text, &["audit"], step.get("audit")),
                    _ => step.get(what).cloned().unwrap_or_else(|| json!([])),
                };
                if seen != recorded {
                    wrong.push(format!("{what} {seen} instead of {recorded}"));
                }
            }
            if !wrong.is_empty() {
                failures.push(format!(
                    "{name} step {index} ({op} {a}): {}",
                    wrong.join("; ")
                ));
                break;
            }
        }
    }
    assert!(steps >= 90, "{steps} steps");
    assert!(
        failures.is_empty(),
        "{} sequences differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// The detail of a recorded event as the producer wrote it: `keys` is the member order of the JavaScript object.
fn detail_of(case: &Value) -> Vec<(String, Value)> {
    case["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| {
            (
                k.as_str().unwrap().to_owned(),
                case["event"]["detail"][k.as_str().unwrap()].clone(),
            )
        })
        .collect()
}

fn rbac_event(case: &Value) -> AuditEvent {
    let e = &case["event"];
    AuditEvent {
        at: e["at"].as_i64().unwrap(),
        user: e["actor"]["user"].as_str().unwrap().to_owned(),
        host: e["actor"]["host"].as_str().unwrap().to_owned(),
        action: e["action"].as_str().unwrap().to_owned(),
        target: e["target"].as_str().unwrap().to_owned(),
        detail: detail_of(case),
    }
}

#[test]
fn the_audit_lines_are_the_bytes_typescript_writes() {
    let audit = load("audit");
    let redactor = detail_redactor().unwrap();
    let cases = audit["rbac"].as_array().unwrap();
    assert!(cases.len() >= 6);
    for case in cases {
        let e = rbac_event(case);
        let line = format!(
            "{}\n",
            audit_line(e.at, &e.user, &e.host, &e.action, &e.target, &e.detail, &redactor)
        );
        assert_eq!(json!(line), case["line"], "{}", case["event"]);
    }
    // JavaScript lists integer-like keys first, in numeric order, whatever order they were written in: the last recorded
    // event, with its members in the order the TypeScript literal has them.
    let integers = cases
        .iter()
        .find(|c| c["event"]["detail"].get("10").is_some())
        .unwrap();
    let written: Vec<(String, Value)> = ["z", "a", "10", "2"]
        .iter()
        .map(|k| ((*k).to_owned(), integers["event"]["detail"][*k].clone()))
        .collect();
    let e = rbac_event(integers);
    assert_eq!(
        json!(format!(
            "{}\n",
            audit_line(e.at, &e.user, &e.host, &e.action, &e.target, &written, &redactor)
        )),
        integers["line"]
    );

    // Through the sinks, into files: one line per event, appended.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("logs").join("audit.log");
    let mut sink = JsonlAuditSink::new(file.clone(), None).unwrap();
    sink.append(&rbac_event(&cases[0])).unwrap();
    sink.append(&rbac_event(&cases[1])).unwrap();
    assert_eq!(
        json!(std::fs::read_to_string(&file).unwrap()),
        audit["rbac-two"]
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        sink.append(&rbac_event(&cases[0])).unwrap();
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600,
            "an existing looser file is tightened"
        );
    }

    let identity = audit["identity"].as_array().unwrap();
    assert!(identity.len() >= 3);
    let file = dir.path().join("identity").join("audit.log");
    let secured = Rc::new(Cell::new(0));
    let seen = secured.clone();
    let mut writer = AuditWriter::new(
        file.clone(),
        Box::new(move |_| seen.set(seen.get() + 1)),
        Box::new(|| 1_760_000_000_007),
    )
    .unwrap();
    let mut expected = String::new();
    for case in identity {
        let e = &case["event"];
        let event = IdentityEvent {
            action: e["action"].as_str().unwrap().to_owned(),
            target: e["target"].as_str().unwrap().to_owned(),
            detail: detail_of(case),
            actor: e.get("actor").map(|a| AuditActor {
                user: a["user"].as_str().unwrap().to_owned(),
                host: a["host"].as_str().unwrap().to_owned(),
            }),
        };
        writer.emit(&event).unwrap();
        expected.push_str(case["line"].as_str().unwrap());
    }
    assert_eq!(std::fs::read_to_string(&file).unwrap(), expected);
    assert_eq!(secured.get(), 1, "the host's port is asked once per writer");
}

/// The registry is a `Map` keyed by the grant id: an id handed out twice replaces the earlier grant.
#[test]
fn a_repeated_grant_id_replaces_the_grant() {
    let mut registry = BreakGlass::new(BreakGlassOptions {
        audit: Box::new(|_: &AuditEvent| Ok(())),
        limits: None,
        notify: Box::new(|_: &BreakGlassNotice| Ok(())),
        require_notification: false,
        clock: Box::new(|| 1_000),
        id_gen: Box::new(|| "same".to_owned()),
        host: None,
    });
    let owner = Principal::new("owner", Role::Owner);
    for target in ["first", "second"] {
        registry
            .request(
                &owner,
                &BreakGlassRequest {
                    target_user_id: target.to_owned(),
                    reason: "a reason that is long enough".to_owned(),
                    ttl_ms: None,
                },
            )
            .unwrap();
    }
    let live = registry.active("owner");
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].target_user_id, "second");
}
