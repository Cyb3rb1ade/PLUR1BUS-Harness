//! Replay of the parity vectors recorded from the TypeScript RBAC decision (`scripts/parity/export-rbac.ts`,
//! `fixtures/parity/rbac/*.json`). Vectors are recorded, never edited by hand. Every case compares the complete outcome:
//! effect, reason and break-glass id of a decision, the allowed indices of `canSee`, or the throw.
use super::authorize::{authorize, authorize_js, can_see, can_see_js};
use super::loose::{Js, Throw};
use super::policy::{policy, policy_for, spec_to_json};
use super::surface::{
    connection_surface_js, surface_satisfies_js, surface_trust_js, STEP_UP_WINDOW_MS,
    UNATTESTED_LOCAL_SURFACE,
};
use super::types::{
    AgentRight, AuthorizeContext, BreakGlassGrant, Decision, DenyReason, Principal, PrincipalKind,
    Resource, Role, ROLES,
};
use serde_json::{json, Value};
use std::fs;

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/rbac/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap()
}

/// The cases of a packed decision file as `{name, input (JSON text of the arguments), expected}`. A file is
/// `{fields, tables, cases}`: a case line is `name TAB in TAB expected`, `in` one table index per field joined by "."
/// ("-" for an absent argument), `expected` `allow/<reason>[/<id>]`, `deny/<reason>`, `throws/<name>` or JSON text.
fn cases(name: &str) -> Vec<Value> {
    let file = load(name);
    let fields: Vec<&str> = file["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect();
    file["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|line| {
            let mut parts = line.as_str().unwrap().splitn(3, '\t');
            let (case_name, refs, expected) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
            let mut input = serde_json::Map::new();
            for (field, r) in fields.iter().zip(refs.split('.')) {
                if r == "-" {
                    continue;
                }
                let text = file["tables"][field][r.parse::<usize>().unwrap()].as_str().unwrap();
                input.insert((*field).to_owned(), serde_json::from_str(text).unwrap());
            }
            let expected = if let Some(rest) = expected.strip_prefix("allow/") {
                match rest.split_once('/') {
                    Some((reason, id)) => json!({"effect": "allow", "reason": reason, "breakGlassId": id}),
                    None => json!({"effect": "allow", "reason": rest}),
                }
            } else if let Some(reason) = expected.strip_prefix("deny/") {
                json!({"effect": "deny", "reason": reason})
            } else if let Some(name) = expected.strip_prefix("throws/") {
                json!({"throws": name})
            } else {
                serde_json::from_str(expected).unwrap()
            };
            json!({"name": case_name, "input": serde_json::to_string(&Value::Object(input)).unwrap(), "expected": expected})
        })
        .collect()
}

/// The decoded call arguments of a case; absent members are `undefined`.
fn args(case: &Value) -> Js {
    let text = case["input"].as_str().unwrap();
    Js::from_value(&serde_json::from_str::<Value>(text).unwrap())
}

/// Both sides through the same encoder, so `7` and `7.0` compare equal.
fn norm(v: &Value) -> Value {
    Js::from_value(v).to_value()
}

fn throws() -> Value {
    json!({"throws": Throw::NAME})
}

/// Fails with the number of mismatches and the names of the first few: a mutation of the policy shows up as a list of cases.
fn expect_none(file: &str, fails: &[String]) {
    assert!(
        fails.is_empty(),
        "{file}: {} case(s) differ from the TypeScript outcome, e.g. {:?}",
        fails.len(),
        &fails[..fails.len().min(5)]
    );
}

/// Replays the cases of a decision file; returns the number replayed.
fn replay_authorize(file: &str) -> usize {
    let list = cases(file);
    let mut fails = Vec::new();
    for case in &list {
        let a = args(case);
        let got = match authorize_js(
            a.get("principal"),
            a.get("action"),
            a.get("resource"),
            a.get("ctx"),
        ) {
            Ok(d) => d.to_value(),
            Err(Throw) => throws(),
        };
        if norm(&got) != norm(&case["expected"]) {
            fails.push(format!("{} => {got}", case["name"].as_str().unwrap()));
        }
    }
    expect_none(file, &fails);
    list.len()
}

#[test]
fn decision_grid_vectors() {
    let mut n = 0;
    for file in [
        "grid-system",
        "grid-agent",
        "grid-project",
        "grid-user",
        "grid-memory-agent",
    ] {
        n += replay_authorize(file);
    }
    assert!(n >= 8000, "{n}");
}

#[test]
fn token_scope_vectors() {
    let n = replay_authorize("scopes-system") + replay_authorize("scopes-object");
    assert!(n >= 5000, "{n}");
}

#[test]
fn break_glass_vectors() {
    assert!(replay_authorize("break-glass") >= 4000);
}

#[test]
fn odd_input_vectors() {
    assert!(replay_authorize("odd-authorize") >= 600);
}

#[test]
fn can_see_vectors() {
    let list = cases("cansee");
    let mut fails = Vec::new();
    for case in &list {
        let a = args(case);
        let got = match can_see_js(
            a.get("principal"),
            a.get("action"),
            a.get("resources"),
            a.get("ctx"),
        ) {
            Ok(v) => json!({"allowed": v}),
            Err(Throw) => throws(),
        };
        if norm(&got) != norm(&case["expected"]) {
            fails.push(format!("{} => {got}", case["name"].as_str().unwrap()));
        }
    }
    expect_none("cansee", &fails);
    assert!(list.len() >= 600);
}

#[test]
fn policy_table_vectors() {
    let v = load("policy");
    let rust: Vec<Value> = policy().iter().map(spec_to_json).collect();
    let ts = v["rows"].as_array().unwrap();
    assert_eq!(rust.len(), ts.len(), "row count");
    let fails: Vec<String> = rust
        .iter()
        .zip(ts)
        .filter(|(r, t)| r != t)
        .map(|(_, t)| format!("policy row {}", t["action"]))
        .collect();
    expect_none("policy", &fails);
    let actions: Vec<&str> = v["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap())
        .collect();
    assert_eq!(
        policy()
            .iter()
            .map(|s| s.action.as_str())
            .collect::<Vec<_>>(),
        actions,
        "row order"
    );
    assert_eq!(v["roles"], json!(ROLES.map(Role::as_str)));
    assert_eq!(v["principalKinds"], json!(["person", "agent"]));
    assert_eq!(v["stepUpWindowMs"].as_f64().unwrap(), STEP_UP_WINDOW_MS);
    assert_eq!(
        v["unattestedLocalSurface"].as_u64().unwrap(),
        u64::from(UNATTESTED_LOCAL_SURFACE.as_u8())
    );
    for case in v["policyFor"].as_array().unwrap() {
        let a = args(case);
        let got = match a.get("action").as_str().and_then(policy_for) {
            Some(s) => json!({"found": true, "spec": spec_to_json(s)}),
            None => json!({"found": false}),
        };
        assert_eq!(got, case["expected"], "{}", case["name"]);
    }
}

fn replay_levels(file: &str, key: &str, f: impl Fn(&Js) -> u8) -> usize {
    let list = cases(file);
    let mut fails = Vec::new();
    for case in &list {
        let a = args(case);
        if u64::from(f(a.get(key))) != case["expected"].as_u64().unwrap() {
            fails.push(case["name"].as_str().unwrap().to_owned());
        }
    }
    expect_none(file, &fails);
    list.len()
}

#[test]
fn surface_vectors() {
    assert!(replay_levels("surface-trust", "facts", |f| surface_trust_js(f).as_u8()) >= 2000);
    assert!(
        replay_levels("connection-surface", "facts", |f| connection_surface_js(f)
            .as_u8())
            >= 300
    );
    let list = cases("surface-satisfies");
    let mut fails = Vec::new();
    for case in &list {
        let a = args(case);
        if surface_satisfies_js(a.get("have"), a.get("required"))
            != case["expected"].as_bool().unwrap()
        {
            fails.push(case["name"].as_str().unwrap().to_owned());
        }
    }
    expect_none("surface-satisfies", &fails);
    assert!(list.len() >= 250);
}

#[test]
fn every_policy_row_is_covered_in_full_or_by_its_smoke_set() {
    let index = load("index");
    let rows: Vec<&str> = policy().iter().map(|s| s.action.as_str()).collect();
    let mut seen = Vec::new();
    for class in index["signatureClasses"].as_array().unwrap() {
        let members: Vec<&str> = class["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_str().unwrap())
            .collect();
        assert_eq!(
            class["full"].as_str().unwrap(),
            members[0],
            "the first row of a class runs the full product"
        );
        seen.extend(members);
    }
    seen.sort_unstable();
    let mut want = rows.clone();
    want.sort_unstable();
    assert_eq!(seen, want, "every row is in exactly one signature class");
    let names: Vec<String> = ["scopes-system", "scopes-object", "break-glass"]
        .iter()
        .flat_map(|f| cases(f))
        .map(|c| c["name"].as_str().unwrap().to_owned())
        .collect();
    for spec in policy() {
        for role in ROLES {
            let scope = format!("{} | {} | person | ", spec.action, role.as_str());
            assert!(
                names
                    .iter()
                    .any(|n| n.starts_with(&scope) && n.ends_with("scopes exact")),
                "{} x {} has no token-scope case",
                spec.action,
                role.as_str()
            );
            if matches!(spec.resource.as_str(), "user" | "memory-user") {
                assert!(
                    names
                        .iter()
                        .any(|n| n.starts_with(&scope) && n.ends_with("glass valid")),
                    "{} x {} has no break-glass case",
                    spec.action,
                    role.as_str()
                );
            }
        }
    }
}

#[test]
fn the_index_counts_what_the_files_hold() {
    let index = load("index");
    let mut total = 0;
    for (name, count) in index["files"].as_object().unwrap() {
        let c = count.as_u64().unwrap() as usize;
        let len = if name == "policy" {
            let p = load("policy");
            p["policyFor"].as_array().unwrap().len() + p["rows"].as_array().unwrap().len()
        } else {
            let l = cases(name).len();
            total += l;
            l
        };
        assert_eq!(len, c, "{name}");
    }
    assert_eq!(
        total as u64,
        index["totalDecisionAndSurfaceCases"].as_u64().unwrap()
    );
    assert_eq!(
        index["policyRows"].as_u64().unwrap() as usize,
        policy().len()
    );
}

// --- the typed entry points ---------------------------------------------------------------------------------------------

fn person(role: Role) -> Principal {
    let mut p = Principal::new("u-self", role);
    p.kind = Some(PrincipalKind::Person);
    p
}

fn decide(p: &Principal, action: &str, r: &Resource) -> Decision {
    authorize(Some(p), action, r, &AuthorizeContext::default())
}

#[test]
fn typed_entry_points_decide_like_the_vectors() {
    let sys = Resource::System;
    assert!(decide(&person(Role::Owner), "chat:read", &sys).is_allow());
    assert_eq!(
        decide(&person(Role::Viewer), "chat:write", &sys),
        Decision::Deny {
            reason: DenyReason::RoleDenied
        }
    );
    assert_eq!(
        authorize(None, "chat:read", &sys, &AuthorizeContext::default()),
        Decision::Deny {
            reason: DenyReason::Unauthenticated
        }
    );
    assert_eq!(
        decide(&Principal::new("", Role::Owner), "chat:read", &sys),
        Decision::Deny {
            reason: DenyReason::InvalidPrincipal
        }
    );
    assert_eq!(
        decide(&person(Role::Owner), "nope", &sys),
        Decision::Deny {
            reason: DenyReason::UnknownAction
        }
    );
    let mut agent = person(Role::Owner);
    agent.kind = Some(PrincipalKind::Agent);
    assert_eq!(
        decide(&agent, "inbox.read", &sys),
        Decision::Deny {
            reason: DenyReason::AgentPrincipal
        }
    );
    assert_eq!(
        decide(&person(Role::Owner), "my.read", &sys),
        Decision::Deny {
            reason: DenyReason::ResourceMismatch
        }
    );
    // Object right: the later entry for one id wins, as in an object literal.
    let mut m = person(Role::Member);
    m.agent_rights = Some(vec![
        ("a1".into(), AgentRight::Manage),
        ("a1".into(), AgentRight::Use),
    ]);
    let a1 = Resource::Agent {
        agent_id: "a1".into(),
    };
    assert!(decide(&m, "agent.use", &a1).is_allow());
    assert_eq!(
        decide(&m, "agent.manage", &a1),
        Decision::Deny {
            reason: DenyReason::ObjectRightRequired
        }
    );
    assert_eq!(
        decide(
            &m,
            "agent.use",
            &Resource::Agent {
                agent_id: "__proto__".into()
            }
        ),
        Decision::Deny {
            reason: DenyReason::ObjectRightRequired
        }
    );
}

#[test]
fn typed_break_glass_is_read_only_and_time_boxed() {
    let mut p = person(Role::Owner);
    p.break_glass = Some(vec![BreakGlassGrant {
        id: "bg-1".into(),
        holder_user_id: "u-self".into(),
        target_user_id: "u-t".into(),
        reason: "fixture reason".into(),
        issued_at: 10.0,
        expires_at: 20.0,
        revoked_at: None,
    }]);
    let target = Resource::MemoryUser {
        owner_user_id: "u-t".into(),
    };
    let at = |now: Option<f64>, action: &str| {
        authorize(Some(&p), action, &target, &AuthorizeContext { now })
    };
    assert_eq!(
        at(Some(10.0), "memory.user.read"),
        Decision::Allow {
            reason: super::types::AllowReason::BreakGlass,
            break_glass_id: Some("bg-1".into())
        }
    );
    assert_eq!(
        at(Some(20.0), "memory.user.read"),
        Decision::Deny {
            reason: DenyReason::BreakGlassRequired
        }
    );
    assert_eq!(
        at(None, "memory.user.read"),
        Decision::Deny {
            reason: DenyReason::BreakGlassRequired
        }
    );
    assert_eq!(
        at(Some(f64::NAN), "memory.user.read"),
        Decision::Deny {
            reason: DenyReason::BreakGlassRequired
        }
    );
    assert_eq!(
        at(Some(15.0), "memory.user.write"),
        Decision::Deny {
            reason: DenyReason::NotOwner
        }
    );
    let list = [
        Resource::MemoryUser {
            owner_user_id: "u-self".into(),
        },
        target.clone(),
        Resource::MemoryUser {
            owner_user_id: "u-x".into(),
        },
    ];
    let seen = can_see(
        Some(&p),
        "memory.user.read",
        &list,
        &AuthorizeContext { now: Some(15.0) },
    );
    assert_eq!(seen, vec![&list[0], &list[1]]);
}
