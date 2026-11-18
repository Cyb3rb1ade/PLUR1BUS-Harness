//! The TypeScript tests of `packages/core/test/policy/` that are about the library, ported where the vectors do not already
//! hold the case: the precedence of the rules, the floors no grant or override lowers, and the syntax and fold rules the
//! path layer stands on. The attack/benign table of `permission-eval` is replayed whole by the vectors.
// The builders take their JSON by value so a test reads as one literal per argument.
#![allow(clippy::needless_pass_by_value)]

use super::decide::{decide, path_covered, Clock, Decision, DenyReason, GrantSource, Via};
use super::headless::{headless_gate, HEADLESS_RULE};
use super::paths::{check_syntax, match_deny, DenyEntry, DenyMatch, LatinNfc, SyntaxOptions};
use serde_json::{json, Value};

const NOW: f64 = 1_791_288_000_000.0; // Date.UTC(2026, 9, 6, 12)
const HOUR: f64 = 3_600_000.0;

struct Grants(Vec<Value>);

impl GrantSource for Grants {
    fn list(&self, person: &str, agent: &str, capability: &str) -> Vec<Value> {
        self.0
            .iter()
            .filter(|g| {
                g["person"] == person && g["agent"] == agent && g["capability"] == capability
            })
            .cloned()
            .collect()
    }
    fn get(&self, id: &str) -> Option<Value> {
        self.0.iter().find(|g| g["id"] == id).cloned()
    }
}

struct At(f64);

impl Clock for At {
    fn now(&self) -> f64 {
        self.0
    }
}

fn call(extra: Value) -> Value {
    let mut c = json!({ "capability": "fs.read", "tool": "fs.read", "flags": { "outsideRoots": false, "denyListHit": false },
        "targets": ["/work/proj/a.txt"], "access": "read", "actionHash": "h1" });
    for (k, v) in extra.as_object().unwrap() {
        c[k] = v.clone();
    }
    c
}

fn ctx(extra: Value) -> Value {
    let mut c = json!({ "principal": { "person": "christian" }, "subject": { "kind": "agent", "agentId": "bernd" }, "surface": 3,
        "sessionId": "s1", "taskId": "t1" });
    for (k, v) in extra.as_object().unwrap() {
        c[k] = v.clone();
    }
    c
}

fn grant(capability: &str, scope: &str, extra: Value) -> Value {
    let mut g = json!({ "id": "g1", "capability": capability, "person": "christian", "agent": "bernd", "scope": scope,
        "match": { "kind": "capability" }, "createdAt": NOW - HOUR, "surface": 3, "taskId": "t1", "sessionId": "s1" });
    for (k, v) in extra.as_object().unwrap() {
        g[k] = v.clone();
    }
    g
}

fn run(c: Value, x: Value, grants: Vec<Value>) -> Decision {
    decide(&c, &x, &Grants(grants), &At(NOW))
}

fn rule(d: &Decision) -> &'static str {
    match d {
        Decision::Deny { rule, .. } => rule,
        Decision::Allow { .. } => "allow",
        Decision::Ask { .. } => "ask",
    }
}

#[test]
fn the_deny_list_wins_over_every_grant() {
    let c = call(json!({ "flags": { "outsideRoots": true, "denyListHit": true } }));
    let g = grant(
        "fs.read",
        "always",
        json!({ "match": { "kind": "path", "path": "/home/c", "access": "read", "recursive": true } }),
    );
    let d = run(c, ctx(json!({})), vec![g]);
    assert_eq!(
        d,
        Decision::Deny {
            reason: DenyReason::DenyList,
            rule: "deny-list"
        }
    );
}

#[test]
fn never_and_unknown_capabilities_are_refused() {
    assert_eq!(
        rule(&run(
            call(json!({ "capability": "harness.admin" })),
            ctx(json!({})),
            vec![]
        )),
        "never"
    );
    assert_eq!(
        rule(&run(
            call(json!({ "capability": "fs.reed" })),
            ctx(json!({})),
            vec![]
        )),
        "unknown-capability"
    );
    assert_eq!(
        rule(&run(
            call(json!({ "capability": "secrets.use" })),
            ctx(json!({})),
            vec![]
        )),
        "never:secret-slot"
    );
    assert_eq!(
        rule(&run(
            call(json!({ "flags": { "denyListHit": false } })),
            ctx(json!({})),
            vec![]
        )),
        "invalid-call"
    );
}

#[test]
fn an_override_never_lifts_the_approval_outside_the_roots() {
    let x = ctx(json!({ "overrides": { "fs.write": "allowed" } }));
    let inside = call(
        json!({ "capability": "fs.write", "access": "write", "flags": { "outsideRoots": false, "denyListHit": false } }),
    );
    assert_eq!(rule(&run(inside, x.clone(), vec![])), "allow");
    let outside = call(
        json!({ "capability": "fs.write", "access": "write", "flags": { "outsideRoots": true, "denyListHit": false } }),
    );
    assert_eq!(rule(&run(outside, x, vec![])), "ask");
    let shell = call(
        json!({ "capability": "shell.exec", "tool": "shell.exec", "flags": { "outsideRoots": false, "denyListHit": false } }),
    );
    let d = run(
        shell,
        ctx(json!({ "overrides": { "Shell.Exec": "allowed", "shell.exec": "approval" } })),
        vec![],
    );
    assert_eq!(rule(&d), "ask", "the stricter of duplicate spellings wins");
}

#[test]
fn shell_grants_need_a_sandbox_or_an_acknowledgement() {
    let c = |sandboxed: bool| {
        call(
            json!({ "capability": "shell.exec", "tool": "shell.exec", "flags": { "outsideRoots": false, "denyListHit": false, "sandboxed": sandboxed } }),
        )
    };
    assert_eq!(
        rule(&run(
            c(false),
            ctx(json!({})),
            vec![grant("shell.exec", "always", json!({}))]
        )),
        "ask"
    );
    assert_eq!(
        rule(&run(
            c(true),
            ctx(json!({})),
            vec![grant("shell.exec", "always", json!({}))]
        )),
        "allow"
    );
    let ack = grant(
        "shell.exec",
        "always",
        json!({ "acknowledgedUnsandboxed": true }),
    );
    assert_eq!(rule(&run(c(false), ctx(json!({})), vec![ack])), "allow");
}

#[test]
fn a_once_grant_is_bound_to_its_action_hash_and_unused() {
    let del = call(json!({ "capability": "fs.delete", "effect": "local-destructive" }));
    let once = |extra: Value| {
        let mut g = grant(
            "fs.delete",
            "once",
            json!({ "actionHash": "h1", "match": { "kind": "action" }, "createdAt": NOW - 60_000.0 }),
        );
        for (k, v) in extra.as_object().unwrap() {
            g[k] = v.clone();
        }
        g
    };
    assert_eq!(
        rule(&run(del.clone(), ctx(json!({})), vec![once(json!({}))])),
        "allow"
    );
    assert_eq!(
        rule(&run(
            del.clone(),
            ctx(json!({})),
            vec![once(json!({ "actionHash": "h2" }))]
        )),
        "ask"
    );
    assert_eq!(
        rule(&run(
            del.clone(),
            ctx(json!({})),
            vec![once(json!({ "consumedAt": NOW }))]
        )),
        "ask"
    );
    assert_eq!(
        rule(&run(
            del,
            ctx(json!({})),
            vec![once(json!({ "createdAt": NOW - 11.0 * 60_000.0 }))]
        )),
        "ask"
    );
}

#[test]
fn a_grant_from_the_future_or_revoked_in_any_spelling_never_applies() {
    let del = call(json!({ "capability": "fs.delete", "effect": "local-destructive" }));
    for extra in [
        json!({ "createdAt": NOW + 1.0 }),
        json!({ "revoked": 1 }),
        json!({ "revoked": null }),
        json!({ "lastUsedAt": NOW + 1.0 }),
    ] {
        let d = run(
            del.clone(),
            ctx(json!({})),
            vec![grant("fs.delete", "task", extra.clone())],
        );
        assert_eq!(rule(&d), "ask", "{extra}");
    }
    let d = run(
        del,
        ctx(json!({})),
        vec![grant("fs.delete", "task", json!({ "revoked": false }))],
    );
    assert!(matches!(
        d,
        Decision::Allow {
            via: Via::Grant,
            ..
        }
    ));
}

#[test]
fn path_grants_cover_whole_segments_of_their_own_spelling() {
    assert!(path_covered("/work/proj", true, "/work/proj/x/y"));
    assert!(!path_covered("/work/proj", true, "/work/proj-evil/x"));
    assert!(!path_covered("/work/proj", false, "/work/proj/x/y"));
    assert!(path_covered("/work/proj", false, "/work/proj/x"));
    assert!(!path_covered("/Work/Proj", true, "/work/proj/x"));
    assert!(
        !path_covered("/", true, "/etc/passwd"),
        "a grant on / covers nothing"
    );
    assert!(!path_covered("/work", true, "C:\\work\\x"));
    assert!(!path_covered("/work/proj", true, "/work/proj/../../etc"));
}

#[test]
fn a_headless_ask_is_refused_at_once() {
    let x = ctx(json!({ "headless": { "jobId": "j1" } }));
    let shell = call(
        json!({ "capability": "shell.exec", "tool": "shell.exec", "flags": { "outsideRoots": false, "denyListHit": false, "sandboxed": true } }),
    );
    let d = run(
        shell.clone(),
        x.clone(),
        vec![grant("shell.exec", "session", json!({}))],
    );
    assert!(matches!(d, Decision::Ask { park: true, .. }));
    assert_eq!(
        headless_gate(d, &x),
        Decision::Deny {
            reason: DenyReason::PolicyNever,
            rule: HEADLESS_RULE
        }
    );
    let job = grant("shell.exec", "always", json!({ "jobId": "j1" }));
    assert_eq!(
        rule(&headless_gate(run(shell, x.clone(), vec![job]), &x)),
        "allow"
    );
}

fn syntax(input: &str, platform: &str) -> Result<Vec<String>, &'static str> {
    let o = SyntaxOptions {
        platform,
        windows_rules: None,
        allow_unc: false,
    };
    check_syntax(&json!(input), o)
        .map(|s| s.segments)
        .map_err(|r| r.reason)
}

#[test]
fn the_syntax_rules_hold_on_every_platform() {
    assert_eq!(
        syntax("/a/./b//c/", "linux"),
        Ok(vec!["a".into(), "b".into(), "c".into()])
    );
    assert_eq!(syntax("/a/../b", "darwin"), Err("dot-dot"));
    assert_eq!(syntax("/a\\b", "linux"), Err("backslash"));
    assert_eq!(syntax("C:foo", "win32"), Err("drive-relative"));
    assert_eq!(syntax("\\\\?\\C:\\x", "win32"), Err("device-path"));
    assert_eq!(syntax("\\\\srv\\share", "win32"), Err("unc-not-allowed"));
    assert_eq!(
        syntax("C:\\a\\CON.txt", "win32"),
        Err("reserved-device-name")
    );
    assert_eq!(syntax("C:\\PROGRA~1", "win32"), Err("short-name"));
    assert_eq!(syntax("C:\\a\\b:stream", "win32"), Err("alternate-stream"));
    assert_eq!(syntax("C:\\a\\b.", "win32"), Err("trailing-dot-space"));
    assert_eq!(syntax("/a\u{202e}b", "linux"), Err("bidi-control"));
    assert_eq!(syntax("/a\u{85}b", "linux"), Err("control-char"));
}

#[test]
fn the_deny_matcher_folds_case_and_fails_closed_where_it_cannot_fold() {
    let deny = [
        DenyEntry::Name(".env".into()),
        DenyEntry::Path("/home/c/.aws".into()),
    ];
    assert_eq!(
        match_deny("/home/c/.ENV", &deny, &LatinNfc),
        DenyMatch::Hit(0)
    );
    assert_eq!(
        match_deny("/HOME/C/.AWS/creds", &deny, &LatinNfc),
        DenyMatch::Hit(1)
    );
    assert_eq!(
        match_deny("/home/c/.envrc", &deny, &LatinNfc),
        DenyMatch::Miss
    );
    assert_eq!(
        match_deny("/x/STRASSE", &[DenyEntry::Name("Straße".into())], &LatinNfc),
        DenyMatch::Hit(0)
    );
    assert!(matches!(
        match_deny("/x/cafe\u{301}", &deny, &LatinNfc),
        DenyMatch::Unknown(0)
    ));
}
