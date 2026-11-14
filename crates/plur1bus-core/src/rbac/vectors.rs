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

fn cases(name: &str) -> Vec<Value> {
    load(name).as_array().unwrap().clone()
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

/// Replays the cases of a decision file; returns the number replayed.
fn replay_authorize(file: &str) -> usize {
    let list = cases(file);
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
        assert_eq!(
            norm(&got),
            norm(&case["expected"]),
            "{file}: {}",
            case["name"]
        );
    }
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
    assert!(n >= 9000, "{n}");
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
        assert_eq!(norm(&got), norm(&case["expected"]), "{}", case["name"]);
    }
    assert!(list.len() >= 600);
}

#[test]
fn policy_table_vectors() {
    let v = load("policy");
    let rust: Vec<Value> = policy().iter().map(spec_to_json).collect();
    let ts = v["rows"].as_array().unwrap();
    assert_eq!(rust.len(), ts.len(), "row count");
    for (r, t) in rust.iter().zip(ts) {
        assert_eq!(r, t, "policy row {}", t["action"]);
    }
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

#[test]
fn surface_vectors() {
    let list = cases("surface-trust");
    for case in &list {
        let a = args(case);
        assert_eq!(
            u64::from(surface_trust_js(a.get("facts")).as_u8()),
            case["expected"].as_u64().unwrap(),
            "{}",
            case["name"]
        );
    }
    assert!(list.len() >= 2000);
    let list = cases("surface-satisfies");
    for case in &list {
        let a = args(case);
        assert_eq!(
            surface_satisfies_js(a.get("have"), a.get("required")),
            case["expected"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
    assert!(list.len() >= 250);
    let list = cases("connection-surface");
    for case in &list {
        let a = args(case);
        assert_eq!(
            u64::from(connection_surface_js(a.get("facts")).as_u8()),
            case["expected"].as_u64().unwrap(),
            "{}",
            case["name"]
        );
    }
    assert!(list.len() >= 300);
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
