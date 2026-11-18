//! Replays `fixtures/parity/policy/*.json` (mode V, `scripts/parity/export-policy.ts`) against the Rust port. The path
//! vectors hold darwin, linux and win32 answers, and every one of them runs here on every operating system.
//!
//! Folding: [`LatinNfc`] declines text at or above U+0300. Where it declines, the replay accepts only the fail-closed answer
//! (a deny match, a system tree) and counts those cases; everything else must equal the TypeScript answer.
use super::capabilities::{
    never_capabilities, GrantScope, Risk, CAPABILITIES, GRANT_SCOPES, RISKS,
};
use super::decide::{
    decide, grant_expiry, grant_review_due, max_scope_for, path_covered, required_surface, risk_of,
    surface_may_decide, Clock, Flags, GrantSource,
};
use super::effects::{
    from_extension_effect, from_mcp, from_side_effects, is_effect, max_effect, Effect, EFFECTS,
};
use super::headless::headless_gate;
use super::paths::{
    check_syntax, contains_exact, fold_for_deny, grant_reaches_system_tree, invalid_deny_entry,
    is_forbidden_root, is_reserved_device_name, is_system_tree_path, match_deny, DenyEntry,
    DenyMatch, LatinNfc, SyntaxOptions, TreeOptions,
};
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let text = match name {
        "tables" => include_str!("../../../../fixtures/parity/policy/tables.json"),
        "effects" => include_str!("../../../../fixtures/parity/policy/effects.json"),
        "helpers" => include_str!("../../../../fixtures/parity/policy/helpers.json"),
        "decide" => include_str!("../../../../fixtures/parity/policy/decide.json"),
        "paths" => include_str!("../../../../fixtures/parity/policy/paths.json"),
        "audit" => include_str!("../../../../fixtures/parity/policy/audit.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

fn num(v: &Value) -> f64 {
    match v.as_str() {
        Some("NaN") => f64::NAN,
        Some("Infinity") => f64::INFINITY,
        Some("-Infinity") => f64::NEG_INFINITY,
        Some(other) => panic!("unknown number tag {other}"),
        None => v.as_f64().expect("number"),
    }
}

fn same_num(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a == b
}

fn effect(v: &Value) -> Effect {
    Effect::parse(v.as_str().unwrap()).unwrap()
}

#[test]
fn table_vectors_replay() {
    let f = fixture("tables");
    let ours: Vec<Value> = CAPABILITIES.iter().map(|d| d.json()).collect();
    assert_eq!(Value::from(ours), f["capabilities"]);
    assert_eq!(json!(never_capabilities()), f["never"]);
    assert_eq!(json!(GRANT_SCOPES.map(GrantScope::as_str)), f["scopes"]);
    assert_eq!(json!(RISKS.map(Risk::as_str)), f["risks"]);
    assert_eq!(json!(EFFECTS.map(Effect::as_str)), f["effects"]);
    let d = &f["defaults"];
    assert_eq!(d["lifetimes"]["onceUnusedMs"], json!(600_000));
    assert_eq!(
        d["batchTargetsOver"],
        json!(super::capabilities::BATCH_TARGETS_OVER)
    );
    assert_eq!(
        d["maxPromptsPerTaskPerHour"].as_f64(),
        Some(super::capabilities::MAX_PROMPTS_PER_TASK_PER_HOUR)
    );
    assert_eq!(
        d["reviewNudgeAgeMs"].as_f64(),
        Some(super::capabilities::REVIEW_NUDGE_AGE_MS)
    );
    assert_eq!(
        d["lifetimes"]["taskMs"].as_f64(),
        Some(super::capabilities::TASK_MS)
    );
    assert_eq!(
        d["lifetimes"]["sessionIdleMs"].as_f64(),
        Some(super::capabilities::SESSION_IDLE_MS)
    );
    assert_eq!(
        d["lifetimes"]["alwaysUnusedMs"].as_f64(),
        Some(super::capabilities::ALWAYS_UNUSED_MS)
    );
    for r in RISKS {
        assert_eq!(d["surfaceByRisk"][r.as_str()], json!(r.surface()));
    }
}

#[test]
fn effect_vectors_replay() {
    let f = fixture("effects");
    for p in f["pairs"].as_array().unwrap() {
        assert_eq!(
            max_effect(effect(&p["a"]), effect(&p["b"])).as_str(),
            p["max"],
            "{p}"
        );
    }
    for r in f["ranks"].as_array().unwrap() {
        assert_eq!(
            u64::from(effect(&r["effect"]).rank()),
            r["rank"].as_u64().unwrap()
        );
    }
    for r in f["is"].as_array().unwrap() {
        assert_eq!(Value::Bool(is_effect(&r["value"])), r["isEffect"], "{r}");
    }
    for r in f["side"].as_array().unwrap() {
        let e = from_side_effects(
            r["side"].as_str().unwrap(),
            r["irreversible"].as_bool().unwrap(),
        );
        assert_eq!(e.as_str(), r["effect"], "{r}");
    }
    for r in f["ext"].as_array().unwrap() {
        let e = from_extension_effect(r["effect"].as_str().unwrap(), r["network"].as_str());
        assert_eq!(e.as_str(), r["result"], "{r}");
    }
    for r in f["mcp"].as_array().unwrap() {
        let declared = if r["declaredAbsent"] == true {
            None
        } else {
            Some(&r["declared"])
        };
        assert_eq!(
            from_mcp(declared, &r["annotations"]).as_str(),
            r["effect"],
            "{r}"
        );
    }
}

#[test]
fn helper_vectors_replay() {
    let f = fixture("helpers");
    for r in f["rows"].as_array().unwrap() {
        let def = super::capabilities::capability(r["capability"].as_str().unwrap()).unwrap();
        let flags = Flags::of(&r["flags"]);
        assert_eq!(max_scope_for(def, flags).as_str(), r["maxScope"], "{r}");
        let risk = risk_of(def, flags);
        assert_eq!(risk.as_str(), r["risk"], "{r}");
        for (i, s) in GRANT_SCOPES.iter().enumerate() {
            assert_eq!(
                json!(required_surface(def, *s, flags)),
                r["surfaces"][i],
                "{r}"
            );
            for surface in 0..4u8 {
                let got = surface_may_decide(def.id, risk, flags, surface, *s);
                assert_eq!(
                    Value::Bool(got),
                    r["mayDecide"][i][surface as usize],
                    "{} {s:?} {surface}",
                    def.id
                );
            }
        }
    }
    for r in f["odd"].as_array().unwrap() {
        let risk = RISKS.into_iter().find(|x| x.as_str() == r["risk"]).unwrap();
        for (i, s) in GRANT_SCOPES.iter().enumerate() {
            for surface in 0..4u8 {
                let got = surface_may_decide(
                    r["capability"].as_str().unwrap(),
                    risk,
                    Flags::default(),
                    surface,
                    *s,
                );
                assert_eq!(Value::Bool(got), r["mayDecide"][i][surface as usize], "{r}");
            }
        }
    }
    for r in f["expiry"].as_array().unwrap() {
        let days = if r["maxGrantDays"].is_null() {
            90.0
        } else {
            num(&r["maxGrantDays"])
        };
        assert!(
            same_num(grant_expiry(&r["grant"], days), num(&r["expiry"])),
            "{r}"
        );
    }
    for r in f["review"].as_array().unwrap() {
        assert_eq!(
            Value::Bool(grant_review_due(&r["grant"], num(&r["now"]))),
            r["due"],
            "{r}"
        );
    }
    let paths: Vec<&str> = f["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    for r in f["covered"].as_array().unwrap() {
        let g = r["grant"].as_str().unwrap();
        let rec = r["recursive"].as_bool().unwrap();
        for (t, want) in paths.iter().zip(r["targets"].as_array().unwrap()) {
            assert_eq!(Value::Bool(path_covered(g, rec, t)), *want, "{g} {rec} {t}");
        }
    }
}

struct Source {
    grants: Vec<Value>,
    max_days: Option<f64>,
}

impl GrantSource for Source {
    fn max_grant_days(&self) -> Option<f64> {
        self.max_days
    }
    fn list(&self, person: &str, agent: &str, capability: &str) -> Vec<Value> {
        // `MemoryGrants` of the TypeScript tests: exact person, agent and capability.
        self.grants
            .iter()
            .filter(|g| {
                g["person"] == person && g["agent"] == agent && g["capability"] == capability
            })
            .cloned()
            .collect()
    }
    fn get(&self, id: &str) -> Option<Value> {
        self.grants.iter().find(|g| g["id"] == id).cloned()
    }
}

struct Fixed(f64);

impl Clock for Fixed {
    fn now(&self) -> f64 {
        self.0
    }
}

#[test]
fn decide_vectors_replay() {
    let f = fixture("decide");
    let cases = f.as_array().unwrap();
    for c in cases {
        assert!(
            c.get("threw").is_none(),
            "the evaluator never throws: {}",
            c["name"]
        );
        let source = Source {
            grants: c["grants"].as_array().unwrap().clone(),
            max_days: c.get("maxGrantDays").map(num),
        };
        let d = decide(&c["call"], &c["ctx"], &source, &Fixed(num(&c["now"])));
        assert_eq!(d.json(), c["decision"], "{}", c["name"]);
        assert_eq!(
            headless_gate(d, &c["ctx"]).json(),
            c["headless"],
            "{} headless",
            c["name"]
        );
    }
    assert!(cases.len() > 2000);
}

/// A path or name the fold declines (it holds a code point at or above U+0300 before or after case mapping).
fn needs_nfc(s: &str) -> bool {
    fold_for_deny(s, &LatinNfc).is_none()
        || s.split(['/', '\\'])
            .any(|seg| fold_for_deny(seg, &LatinNfc).is_none())
}

#[test]
fn path_vectors_replay() {
    let f = fixture("paths");
    let platforms = f["platforms"].as_array().unwrap();
    for case in f["syntax"].as_array().unwrap() {
        for (o, want) in platforms.iter().zip(case["results"].as_array().unwrap()) {
            let opts = SyntaxOptions {
                platform: o["platform"].as_str().unwrap(),
                windows_rules: o.get("windowsRules").and_then(Value::as_bool),
                allow_unc: o.get("allowUnc") == Some(&Value::Bool(true)),
            };
            let got = match check_syntax(&case["input"], opts) {
                Ok(ok) => ok.json(),
                Err(r) => r.json(),
            };
            assert_eq!(&got, want, "{} {o}", case["input"]);
        }
    }
    for r in f["reserved"].as_array().unwrap() {
        assert_eq!(
            Value::Bool(is_reserved_device_name(r["segment"].as_str().unwrap())),
            r["reserved"],
            "{r}"
        );
    }
    let mut declined = 0;
    for r in f["fold"].as_array().unwrap() {
        match fold_for_deny(r["input"].as_str().unwrap(), &LatinNfc) {
            Some(s) => assert_eq!(s, r["folded"], "{r}"),
            None => declined += 1,
        }
    }
    assert!(declined > 0 && declined < 40, "declined {declined}");
    let deny_paths: Vec<&str> = f["denyPaths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    let mut unknown = 0;
    for r in f["deny"].as_array().unwrap() {
        let list: Vec<DenyEntry> = r["deny"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| DenyEntry::of(e).unwrap())
            .collect();
        for (p, want) in deny_paths.iter().zip(r["matches"].as_array().unwrap()) {
            match match_deny(p, &list, &LatinNfc) {
                DenyMatch::Hit(i) => assert_eq!(&list[i].json(), want, "{p} {list:?}"),
                DenyMatch::Miss => {
                    assert!(want.is_null(), "{p} {list:?}: TypeScript matched {want}")
                }
                DenyMatch::Unknown(i) => {
                    // Fail closed: counted as a hit; only text the fold declines may get here.
                    let entry = match &list[i] {
                        DenyEntry::Name(n) | DenyEntry::Path(n) => n.as_str(),
                    };
                    assert!(needs_nfc(p) || needs_nfc(entry), "{p} {list:?}");
                    unknown += 1;
                }
            }
        }
    }
    assert!(unknown > 0, "the declined folds are exercised");
    for r in f["invalid"].as_array().unwrap() {
        let deny = if r["absent"] == true {
            None
        } else {
            Some(&r["deny"])
        };
        assert_eq!(json!(invalid_deny_entry(deny)), r["result"], "{r}");
    }
    for r in f["contains"].as_array().unwrap() {
        let got = contains_exact(
            r["root"].as_str().unwrap(),
            r["path"].as_str().unwrap(),
            r["sep"].as_str().unwrap(),
        );
        assert_eq!(Value::Bool(got), r["contains"], "{r}");
    }
    for r in f["forbidden"].as_array().unwrap() {
        let got = is_forbidden_root(
            r["real"].as_str().unwrap(),
            r["windows"].as_bool().unwrap(),
            r["home"].as_str().unwrap(),
        );
        assert_eq!(Value::Bool(got), r["forbidden"], "{r}");
    }
    let mut closed = 0;
    let mut tree_check = |got: bool, want: &Value, texts: &[&str], r: &Value| {
        if Value::Bool(got) == *want {
            return;
        }
        assert!(got && texts.iter().any(|t| needs_nfc(t)), "{r}");
        closed += 1;
    };
    for r in f["tree"].as_array().unwrap() {
        let homes: Vec<String> = r["homes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h.as_str().unwrap().to_owned())
            .collect();
        let o = TreeOptions {
            windows: r["windows"].as_bool().unwrap(),
            homes: &homes,
        };
        let p = r["path"].as_str().unwrap();
        let mut texts: Vec<&str> = homes.iter().map(String::as_str).collect();
        texts.push(p);
        tree_check(is_system_tree_path(p, o, &LatinNfc), &r["tree"], &texts, r);
    }
    for r in f["reach"].as_array().unwrap() {
        let homes: Vec<String> = r["homes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h.as_str().unwrap().to_owned())
            .collect();
        let o = TreeOptions {
            windows: r["windows"].as_bool().unwrap(),
            homes: &homes,
        };
        let p = r["path"].as_str().unwrap();
        let mut texts: Vec<&str> = homes.iter().map(String::as_str).collect();
        texts.push(p);
        let got = grant_reaches_system_tree(p, r["recursive"].as_bool().unwrap(), o, &LatinNfc);
        tree_check(got, &r["reaches"], &texts, r);
    }
    assert!(closed > 0, "the declined folds are exercised");
}

/// `{ "parts": [...] }` joined, at any depth (credential-shaped values are stored in fragments).
fn joined(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(joined).collect()),
        Value::Object(o) if o.len() == 1 && o.get("parts").is_some_and(Value::is_array) => {
            Value::String(
                o["parts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p.as_str().unwrap())
                    .collect(),
            )
        }
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), joined(x))).collect()),
        other => other.clone(),
    }
}

#[test]
fn policy_audit_vectors_replay() {
    use super::audit::{hash_and_size, PolicyAudit};
    use crate::rbac::audit::{detail_redactor, AuditEvent};
    let f = fixture("audit");
    let redactor = detail_redactor().unwrap();
    let clock = || 1_791_288_000_000i64;
    for c in f["cases"].as_array().unwrap() {
        let mut seen: Vec<AuditEvent> = Vec::new();
        let mut sink = |e: &AuditEvent| -> Result<(), String> {
            seen.push(e.clone());
            Ok(())
        };
        let mut audit = PolicyAudit::new(&mut sink, &clock, "h1", &redactor);
        audit
            .record(c["action"].as_str().unwrap(), &joined(&c["fields"]))
            .unwrap();
        let e = &seen[0];
        assert_eq!(e.to_json(), c["event"], "{}", c["fields"]);
        let keys: Vec<&str> = e.detail.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(json!(keys), c["detailKeys"], "{}", c["fields"]);
    }
    for h in f["hashes"].as_array().unwrap() {
        let (hash, bytes) = hash_and_size(h["text"].as_str().unwrap());
        assert_eq!(
            (json!(hash), json!(bytes)),
            (h["hash"].clone(), h["bytes"].clone())
        );
    }
}
