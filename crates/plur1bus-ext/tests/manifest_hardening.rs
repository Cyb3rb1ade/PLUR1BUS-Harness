//! Generative and matrix hardening of the `.p1x` manifest and of what a package may ask for.
//!
//! `tests/manifest.rs`, `tests/kinds.rs`, `tests/zipaudit.rs`, `tests/verify.rs` and `tests/fuzz.rs` already cover the closed schema,
//! the naming rules, the per-kind rules and the archive audit (zip-slip, symlink, bomb, size, names). This file adds what they do not:
//! every required property at every level removed in turn (driven by the schema), the spelling and duplicate matrix for the rights,
//! the rule that `hostBridge` and `mcpApps` exist only when the manifest says so, whether an upgrade that asks for a new right
//! changes the hash a person's consent is tied to, a SemVer matrix, a seeded mutation run that must never panic, and the
//! boundaries (limit − 1, limit, limit + 1) of the archive caps with archives written by `zip::ZipWriter`.
use plur1bus_ext::compat::{acknowledgment_hash, capability_hash};
use plur1bus_ext::manifest::{
    parse_manifest, valid_name, valid_publisher, P1xManifest, MAX_MANIFEST_BYTES, P1X_SCHEMA_JSON,
};
use plur1bus_ext::refusal::reason;
use plur1bus_ext::rights::{declared_rights, Risk};
use plur1bus_ext::zipaudit::{audit_zip, Limits};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::io::{Cursor, Write};

const SEED: u64 = 0x7031_785f_6861_7264;
const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn base() -> Value {
    json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": "demo/hardening",
        "name": "hardening",
        "version": "1.2.0",
        "kind": "skill",
        "title": { "en": "Hardening" },
        "summary": { "en": "A manifest to mutate." },
        "publisher": { "id": "demo", "name": "Demo" },
        "licence": "MIT",
        "compat": { "harness": ">=0.2.0 <1.0.0" },
        "requires": { "runtime": { "type": "none" } },
        "capabilities": {
            "network": { "mode": "none" },
            "filesystem": [],
            "processes": { "spawn": false },
            "harness": { "authority": "none" }
        },
        "scripts": [],
        "files": { "payload/SKILL.md": { "sha256": SHA, "size": 12 } }
    })
}

fn raw(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap()
}
fn parse(v: &Value) -> Result<P1xManifest, plur1bus_ext::refusal::Refusal> {
    parse_manifest(&raw(v), &[])
}
fn caps(v: &Value) -> P1xManifest {
    parse(v).unwrap_or_else(|e| panic!("{e}\n{v}"))
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, num: u64, den: u64) -> bool {
        self.next() % den < num
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// required properties
// ---------------------------------------------------------------------------------------------------------------------

/// Every `required` entry of every object schema on the way through `properties` that the example manifest actually has: the path
/// of the property and its name.
fn required_paths(
    schema: &Value,
    value: &Value,
    path: &mut Vec<String>,
    out: &mut Vec<Vec<String>>,
) {
    let (Some(props), Some(obj)) = (
        schema.get("properties").and_then(Value::as_object),
        value.as_object(),
    ) else {
        return;
    };
    for r in schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if obj.contains_key(r) {
            let mut p = path.clone();
            p.push(r.to_string());
            out.push(p);
        }
    }
    // The conditional `then.required` (allowlist needs hosts, scoped needs rpc, path needs path) is covered by the explicit cases.
    for (k, sub) in props {
        if let Some(child) = obj.get(k) {
            path.push(k.clone());
            required_paths(sub, child, path, out);
            path.pop();
        }
    }
}

fn without(v: &Value, path: &[String]) -> Value {
    let mut out = v.clone();
    let mut cur = &mut out;
    for seg in &path[..path.len() - 1] {
        cur = cur.get_mut(seg).unwrap();
    }
    cur.as_object_mut().unwrap().remove(path.last().unwrap());
    out
}

#[test]
fn a_manifest_missing_any_required_property_at_any_level_is_refused_and_names_it() {
    let schema: Value = serde_json::from_str(P1X_SCHEMA_JSON).unwrap();
    // A manifest that exercises as many nested objects as possible, so the walk reaches their `required` lists.
    let mut v = base();
    v["capabilities"] = json!({
        "network": { "mode": "allowlist", "hosts": ["example.org"] },
        "filesystem": [ { "scope": "path", "access": "read", "path": "/srv/x" } ],
        "processes": { "spawn": true, "commands": ["git"] },
        "secrets": [ { "slot": "apiKey", "label": { "en": "Key" }, "required": true } ],
        "hostBridge": ["keychain"],
        "harness": { "authority": "scoped", "rpc": ["memory.recall"] },
        "tools": [ { "name": "run", "effect": "read" } ],
        "mcpApps": true
    });
    v["publisher"] = json!({ "id": "demo", "name": "Demo", "url": "https://example.org" });
    caps(&v);
    let mut paths = Vec::new();
    required_paths(&schema, &v, &mut Vec::new(), &mut paths);
    assert!(
        paths.len() >= 18,
        "{} required properties reached: {paths:?}",
        paths.len()
    );
    for p in &paths {
        let doc = without(&v, p);
        let e = parse(&doc).expect_err(&format!("accepted without {p:?}"));
        assert_eq!(e.reason, reason::PACKAGE_INVALID, "{p:?}: {e}");
        assert_eq!(e.code, "E_INVALID_PARAMS");
        assert!(
            e.detail.contains(p.last().unwrap()),
            "{p:?}: the detail does not name the property: {}",
            e.detail
        );
    }
    // The properties inside arrays: a missing member of a filesystem entry, a secret and a tool.
    for (arr, member) in [
        ("filesystem", "scope"),
        ("filesystem", "access"),
        ("filesystem", "path"),
        ("secrets", "slot"),
        ("secrets", "label"),
        ("secrets", "required"),
        ("tools", "name"),
        ("tools", "effect"),
    ] {
        let mut doc = v.clone();
        doc["capabilities"][arr][0]
            .as_object_mut()
            .unwrap()
            .remove(member);
        assert!(
            parse(&doc).is_err(),
            "{arr}[0] without {member} was accepted"
        );
    }
    // The conditional requirements.
    for (path, key) in [
        (vec!["capabilities", "network"], "hosts"),
        (vec!["capabilities", "harness"], "rpc"),
    ] {
        let mut doc = v.clone();
        doc[path[0]][path[1]].as_object_mut().unwrap().remove(key);
        assert!(parse(&doc).is_err(), "{path:?} without {key} was accepted");
    }
}

#[test]
fn a_required_property_of_the_wrong_type_or_null_is_refused_at_the_top_level() {
    let strings = ["id", "name", "version", "kind", "licence"];
    let objects = [
        "title",
        "summary",
        "publisher",
        "compat",
        "requires",
        "capabilities",
        "files",
    ];
    for key in [
        "format",
        "id",
        "name",
        "version",
        "kind",
        "title",
        "summary",
        "publisher",
        "licence",
        "compat",
        "requires",
        "capabilities",
        "scripts",
        "files",
    ] {
        let wrong: Vec<Value> = if strings.contains(&key) {
            vec![Value::Null, json!(true), json!(12345), json!([]), json!({})]
        } else if objects.contains(&key) {
            vec![
                Value::Null,
                json!(true),
                json!(12345),
                json!("wrong"),
                json!([]),
            ]
        } else if key == "scripts" {
            vec![
                Value::Null,
                json!(true),
                json!(12345),
                json!("wrong"),
                json!({}),
            ]
        } else {
            vec![
                Value::Null,
                json!(true),
                json!("wrong"),
                json!([]),
                json!({}),
                json!(2),
                json!(0),
                json!(1.5),
            ]
        };
        for w in wrong {
            let mut v = base();
            v[key] = w.clone();
            assert!(parse(&v).is_err(), "{key} = {w} was accepted");
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// rights: spelling, unknown names, duplicates, and "only when explicit"
// ---------------------------------------------------------------------------------------------------------------------

fn with_caps(f: impl FnOnce(&mut Map<String, Value>)) -> Value {
    let mut v = base();
    f(v["capabilities"].as_object_mut().unwrap());
    v
}

#[test]
fn unknown_and_misspelled_capability_names_are_refused() {
    for key in [
        "hostbridge",
        "HostBridge",
        "host_bridge",
        "host-bridge",
        "hostBridge ",
        " hostBridge",
        "mcpapps",
        "McpApps",
        "mcp-apps",
        "mcp_apps",
        "MCPAPPS",
        "network2",
        "Network",
        "FileSystem",
        "process",
        "secret",
        "tool",
        "authority",
        "x",
        "",
    ] {
        let v = with_caps(|c| {
            c.insert(key.to_string(), json!(true));
        });
        let e = parse(&v).expect_err(&format!("capability {key:?} was accepted"));
        assert_eq!(e.reason, reason::PACKAGE_INVALID);
    }
    // A right at the top level of the manifest is not a right: the manifest is closed there too.
    for key in [
        "hostBridge",
        "mcpApps",
        "capabilities2",
        "rights",
        "permissions",
    ] {
        let mut v = base();
        v[key] = json!(["keychain"]);
        assert!(parse(&v).is_err(), "top-level {key} was accepted");
    }
}

#[test]
fn host_bridge_entries_must_be_exact_known_names_without_duplicates() {
    for ok in ["computer-use", "notifications", "file-pick", "keychain"] {
        caps(&with_caps(|c| {
            c.insert("hostBridge".into(), json!([ok]));
        }));
    }
    caps(&with_caps(|c| {
        c.insert(
            "hostBridge".into(),
            json!(["computer-use", "notifications", "file-pick", "keychain"]),
        );
    }));
    for bad in [
        json!(["Computer-Use"]),
        json!(["COMPUTER-USE"]),
        json!(["computer_use"]),
        json!(["computeruse"]),
        json!(["computer-use "]),
        json!([" keychain"]),
        json!(["keychain\n"]),
        json!(["key\u{0}chain"]),
        json!(["keychains"]),
        json!(["clipboard"]),
        json!(["*"]),
        json!([""]),
        json!([null]),
        json!([1]),
        json!([true]),
        json!([["keychain"]]),
        json!([{"name": "keychain"}]),
        json!("keychain"),
        json!(true),
        json!(1),
        json!({}),
        json!(null),
        json!(["keychain", "keychain"]),
        json!(["keychain", "notifications", "keychain"]),
    ] {
        let v = with_caps(|c| {
            c.insert("hostBridge".into(), bad.clone());
        });
        assert!(parse(&v).is_err(), "hostBridge {bad} was accepted");
    }
}

#[test]
fn mcp_apps_is_a_boolean_and_nothing_else() {
    for v in [json!(true), json!(false)] {
        caps(&with_caps(|c| {
            c.insert("mcpApps".into(), v);
        }));
    }
    for bad in [
        json!("true"),
        json!("false"),
        json!("yes"),
        json!(1),
        json!(0),
        json!(null),
        json!([]),
        json!({}),
        json!([true]),
    ] {
        let v = with_caps(|c| {
            c.insert("mcpApps".into(), bad.clone());
        });
        assert!(parse(&v).is_err(), "mcpApps {bad} was accepted");
    }
}

fn ids(m: &P1xManifest) -> Vec<String> {
    declared_rights(m).into_iter().map(|r| r.id).collect()
}

#[test]
fn host_bridge_and_mcp_apps_are_declared_only_when_the_manifest_says_so() {
    // Not there, empty or false: no right.
    assert!(ids(&caps(&base())).is_empty());
    for set in [
        with_caps(|c| {
            c.insert("hostBridge".into(), json!([]));
        }),
        with_caps(|c| {
            c.insert("mcpApps".into(), json!(false));
        }),
        with_caps(|c| {
            c.insert("hostBridge".into(), json!([]));
            c.insert("mcpApps".into(), json!(false));
        }),
    ] {
        let rights = ids(&caps(&set));
        assert!(
            rights
                .iter()
                .all(|r| !r.starts_with("hostbridge:") && r != "mcpapps"),
            "{rights:?}"
        );
    }
    // Asking for everything else does not hand out these two.
    let wide = with_caps(|c| {
        c.insert("network".into(), json!({ "mode": "any" }));
        c.insert(
            "filesystem".into(),
            json!([{ "scope": "home", "access": "read-write" }]),
        );
        c.insert(
            "processes".into(),
            json!({ "spawn": true, "commands": ["sh"] }),
        );
        c.insert(
            "secrets".into(),
            json!([{ "slot": "k", "label": { "en": "K" }, "required": true }]),
        );
        c.insert("harness".into(), json!({ "authority": "full" }));
        c.insert(
            "tools".into(),
            json!([{ "name": "t", "effect": "destructive" }]),
        );
    });
    let rights = ids(&caps(&wide));
    assert!(rights.len() >= 6, "{rights:?}");
    assert!(
        rights
            .iter()
            .all(|r| !r.starts_with("hostbridge:") && r != "mcpapps"),
        "{rights:?}"
    );
    // Named: exactly that right, at high risk (mcpApps at medium).
    for name in ["computer-use", "notifications", "file-pick", "keychain"] {
        let m = caps(&with_caps(|c| {
            c.insert("hostBridge".into(), json!([name]));
        }));
        let rights = declared_rights(&m);
        assert_eq!(rights.len(), 1, "{rights:?}");
        assert_eq!(
            (rights[0].id.as_str(), rights[0].risk),
            (format!("hostbridge:{name}").as_str(), Risk::High)
        );
    }
    let m = caps(&with_caps(|c| {
        c.insert("mcpApps".into(), json!(true));
    }));
    let rights = declared_rights(&m);
    assert_eq!(
        (rights.len(), rights[0].id.as_str(), rights[0].risk),
        (1, "mcpapps", Risk::Medium)
    );
    // The list is sorted and duplicate-free whatever the manifest order.
    let all = caps(&with_caps(|c| {
        c.insert(
            "hostBridge".into(),
            json!(["keychain", "computer-use", "notifications", "file-pick"]),
        );
        c.insert("mcpApps".into(), json!(true));
    }));
    let listed = ids(&all);
    let mut sorted = listed.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(listed, sorted);
    assert_eq!(listed.len(), 5);
}

#[test]
fn the_filesystem_path_right_is_disclosed_verbatim_and_never_normalised_away() {
    // The manifest layer discloses, it does not sandbox (docs/extensions.md "What is not protected"): a path that looks like an
    // escape must show up in the right as written, so that a person reading the list sees it.
    for path in [
        "../../etc",
        "/etc",
        "C:\\Windows",
        "\\\\server\\share\\x",
        "~/.ssh",
        "a/../b",
        "//host/x",
        "ä/ö",
    ] {
        let m = caps(&with_caps(|c| {
            c.insert(
                "filesystem".into(),
                json!([{ "scope": "path", "access": "read-write", "path": path }]),
            );
        }));
        let rights = declared_rights(&m);
        assert_eq!(rights.len(), 1);
        assert_eq!(rights[0].id, format!("fs:path:{path}:read-write"));
        assert_eq!(rights[0].risk, Risk::High, "{path}");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// an upgrade that asks for a new right
// ---------------------------------------------------------------------------------------------------------------------

/// Right-bearing fragments a generated manifest can pick from. Each adds at least one declared right.
fn random_capabilities(rng: &mut Rng) -> Value {
    let mut c = json!({
        "network": { "mode": "none" },
        "filesystem": [],
        "processes": { "spawn": false },
        "harness": { "authority": "none" }
    });
    match rng.below(3) {
        1 => c["network"] = json!({ "mode": "allowlist", "hosts": ["example.org"] }),
        2 => c["network"] = json!({ "mode": "any" }),
        _ => {}
    }
    if rng.chance(1, 2) {
        c["network"] = if rng.chance(1, 2) {
            json!({ "mode": "allowlist", "hosts": ["example.org", "api.example.org"] })
        } else {
            c["network"].clone()
        };
    }
    for (scope, access) in [
        ("agent-workspace", "read"),
        ("extension-data", "read-write"),
        ("home", "read"),
        ("home", "read-write"),
    ] {
        if rng.chance(1, 4) {
            c["filesystem"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "scope": scope, "access": access }));
        }
    }
    if rng.chance(1, 4) {
        c["processes"] = json!({ "spawn": true, "commands": ["git"] });
    }
    if rng.chance(1, 4) {
        c["secrets"] =
            json!([{ "slot": "apiKey", "label": { "en": "Key" }, "required": rng.chance(1, 2) }]);
    }
    let bridges = ["computer-use", "notifications", "file-pick", "keychain"];
    let picked: Vec<&str> = bridges
        .iter()
        .copied()
        .filter(|_| rng.chance(1, 4))
        .collect();
    if !picked.is_empty() || rng.chance(1, 4) {
        c["hostBridge"] = json!(picked);
    }
    match rng.below(4) {
        1 => c["harness"] = json!({ "authority": "full" }),
        2 => c["harness"] = json!({ "authority": "scoped", "rpc": ["memory.recall"] }),
        _ => {}
    }
    if rng.chance(1, 4) {
        let effect = ["read", "write", "destructive"][rng.below(3)];
        c["tools"] = json!([{ "name": "run", "effect": effect }]);
    }
    if rng.chance(1, 3) {
        c["mcpApps"] = json!(rng.chance(1, 2));
    }
    c
}

#[test]
fn an_upgrade_that_asks_for_a_new_right_changes_the_hash_the_consent_is_tied_to() {
    let mut rng = Rng(SEED);
    let mut widened = 0;
    for case in 0..600 {
        let (mut old, mut new) = (base(), base());
        old["capabilities"] = random_capabilities(&mut rng);
        new["capabilities"] = random_capabilities(&mut rng);
        new["version"] = json!("1.3.0");
        let (a, b) = (caps(&old), caps(&new));
        let before: BTreeSet<String> = ids(&a).into_iter().collect();
        let after: BTreeSet<String> = ids(&b).into_iter().collect();
        let gained: Vec<_> = after.difference(&before).collect();
        let (ha, hb) = (
            capability_hash(&a.capabilities),
            capability_hash(&b.capabilities),
        );
        if !gained.is_empty() {
            widened += 1;
            assert_ne!(ha, hb, "seed {SEED:#x} case {case}: the upgrade gains {gained:?} but the capability hash is unchanged\nold {}\nnew {}", old["capabilities"], new["capabilities"]);
        }
        // The same capabilities, written again, hash the same.
        assert_eq!(
            ha,
            capability_hash(&caps(&old).capabilities),
            "seed {SEED:#x} case {case}"
        );
    }
    assert!(widened > 100, "{widened} widening pairs");
}

#[test]
fn adding_host_bridge_or_mcp_apps_in_an_upgrade_always_changes_the_hash() {
    let old = caps(&base());
    for (what, edit) in [
        ("hostBridge keychain", json!({ "hostBridge": ["keychain"] })),
        (
            "hostBridge computer-use",
            json!({ "hostBridge": ["computer-use"] }),
        ),
        (
            "hostBridge all",
            json!({ "hostBridge": ["computer-use", "notifications", "file-pick", "keychain"] }),
        ),
        ("mcpApps true", json!({ "mcpApps": true })),
    ] {
        let mut v = base();
        for (k, x) in edit.as_object().unwrap() {
            v["capabilities"][k] = x.clone();
        }
        let new = caps(&v);
        assert_ne!(
            capability_hash(&old.capabilities),
            capability_hash(&new.capabilities),
            "{what}"
        );
        assert!(ids(&new).len() > ids(&old).len(), "{what}");
    }
    // Spelling out "nothing" is a different document, but not a new right: it is allowed to ask again, never to ask for less.
    let mut v = base();
    v["capabilities"]["hostBridge"] = json!([]);
    v["capabilities"]["mcpApps"] = json!(false);
    assert_eq!(ids(&caps(&v)), ids(&old));
}

/// SICHERHEIT. `declared_rights` also lists `remote:<url>` (an MCP server's endpoint) and `provider:<baseUrl>`; both come from
/// manifest properties OUTSIDE `capabilities` (`remote.url`, `provider.baseUrl`). The consent a person gave is tied to
/// `acknowledgment_hash(m)`, the hash of `acknowledged_capabilities(m)`: `m.capabilities` plus those endpoints
/// (`plur1bus::ext::commit::capabilities_hash(&record.capabilities)` hashes the same block, because the records store it). So an
/// upgrade that keeps `capabilities` and only changes the URL path on the already-allowed host no longer keeps the consent.
#[test]
fn an_upgrade_that_only_changes_the_remote_or_provider_url_asks_for_consent_again() {
    let remote = |url: &str| {
        let mut v = base();
        v["name"] = json!("crm");
        v["id"] = json!("demo/crm");
        v["kind"] = json!("mcp-server");
        v["remote"] = json!({ "url": url, "auth": "header" });
        v["capabilities"]["network"] = json!({ "mode": "allowlist", "hosts": ["mcp.example.org"] });
        v["capabilities"]["secrets"] =
            json!([{ "slot": "token", "label": { "en": "Token" }, "required": true }]);
        caps(&v)
    };
    let provider = |url: &str| {
        let mut v = base();
        v["name"] = json!("acme");
        v["id"] = json!("demo/acme");
        v["kind"] = json!("provider");
        v["provider"] = json!({ "api": "chat_completions", "baseUrl": url });
        v["capabilities"]["network"] =
            json!({ "mode": "allowlist", "hosts": ["api.acme.example"] });
        v["capabilities"]["secrets"] =
            json!([{ "slot": "apiKey", "label": { "en": "Key" }, "required": true }]);
        caps(&v)
    };
    let pairs = [
        (
            remote("https://mcp.example.org/v1"),
            remote("https://mcp.example.org/other-tenant"),
        ),
        (
            provider("https://api.acme.example/v1"),
            provider("https://api.acme.example/v2/other-account"),
        ),
    ];
    for (old, new) in pairs {
        let (before, after): (BTreeSet<_>, BTreeSet<_>) = (
            ids(&old).into_iter().collect(),
            ids(&new).into_iter().collect(),
        );
        assert!(
            after.difference(&before).count() > 0,
            "the upgrade declares a new right: {before:?} → {after:?}"
        );
        assert_ne!(
            acknowledgment_hash(&old),
            acknowledgment_hash(&new),
            "the new right {:?} is declared but the consent hash is the same",
            after.difference(&before).collect::<Vec<_>>()
        );
    }
}

/// The counterpart: what stays the same keeps its consent. The same endpoint (a new version, new files) hashes the same, and a
/// manifest without `remote` or `provider` hashes exactly as `capability_hash(capabilities)` did, so no recorded acknowledgment is
/// invalidated by this change.
#[test]
fn an_unchanged_endpoint_or_no_endpoint_keeps_the_consent_hash() {
    let remote = |url: &str, version: &str| {
        let mut v = base();
        v["name"] = json!("crm");
        v["id"] = json!("demo/crm");
        v["kind"] = json!("mcp-server");
        v["version"] = json!(version);
        v["remote"] = json!({ "url": url, "auth": "none" });
        v["capabilities"]["network"] = json!({ "mode": "allowlist", "hosts": ["mcp.example.org"] });
        caps(&v)
    };
    let (a, b) = (
        remote("https://mcp.example.org/v1", "1.0.0"),
        remote("https://mcp.example.org/v1", "1.1.0"),
    );
    assert_eq!(acknowledgment_hash(&a), acknowledgment_hash(&b));
    // The endpoint is part of what is hashed; `capabilities` alone no longer is the whole consent.
    assert_ne!(acknowledgment_hash(&a), capability_hash(&a.capabilities));

    // `remote` and `provider` are the only extra inputs. `null` (the schema allows `remote: null`) adds nothing.
    let mut v = base();
    v["capabilities"]["network"] = json!({ "mode": "allowlist", "hosts": ["mcp.example.org"] });
    let plain = caps(&v);
    assert_eq!(
        acknowledgment_hash(&plain),
        capability_hash(&plain.capabilities)
    );
    assert_eq!(
        plur1bus_ext::compat::acknowledged_capabilities(&plain),
        plain.capabilities
    );
    let mut with_null = v.clone();
    with_null["remote"] = Value::Null;
    let nulled = caps(&with_null);
    assert_eq!(
        acknowledgment_hash(&nulled),
        capability_hash(&nulled.capabilities)
    );

    // A skill's matrix of capabilities is unaffected, too.
    let mut rng = Rng(SEED ^ 0x55);
    for _ in 0..50 {
        let mut v = base();
        v["capabilities"] = random_capabilities(&mut rng);
        let m = caps(&v);
        assert_eq!(acknowledgment_hash(&m), capability_hash(&m.capabilities));
    }
}

/// Whatever the endpoint and the capabilities do, a new declared right (capability or URL) never keeps the consent hash.
#[test]
fn a_new_declared_right_of_any_origin_changes_the_consent_hash() {
    let mut rng = Rng(SEED ^ 0xE0);
    let urls = [
        "https://mcp.example.org/v1",
        "https://mcp.example.org/v2",
        "https://mcp.example.org/v1?tenant=b",
        "https://mcp.example.org/",
    ];
    let make = |rng: &mut Rng| {
        let mut v = base();
        v["name"] = json!("crm");
        v["id"] = json!("demo/crm");
        v["kind"] = json!("mcp-server");
        v["remote"] = json!({ "url": urls[rng.below(urls.len())], "auth": "none" });
        v["capabilities"] = random_capabilities(rng);
        v["capabilities"]["network"] = json!({ "mode": "allowlist", "hosts": ["mcp.example.org"] });
        caps(&v)
    };
    let mut gained_url = 0;
    for case in 0..300 {
        let (old, new) = (make(&mut rng), make(&mut rng));
        let before: BTreeSet<String> = ids(&old).into_iter().collect();
        let after: BTreeSet<String> = ids(&new).into_iter().collect();
        if after.difference(&before).any(|r| r.starts_with("remote:")) {
            gained_url += 1;
        }
        if after.difference(&before).next().is_some() {
            assert_ne!(
                acknowledgment_hash(&old),
                acknowledgment_hash(&new),
                "seed {SEED:#x} case {case}: {before:?} → {after:?}"
            );
        }
    }
    assert!(
        gained_url > 30,
        "{gained_url} upgrades changed only the URL"
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn versions_outside_semver_are_refused_and_valid_ones_survive() {
    for good in [
        "0.0.0",
        "1.2.3",
        "10.20.30",
        "1.2.3-alpha",
        "1.2.3-alpha.1",
        "1.2.3-0.3.7",
        "1.2.3+build.5",
        "1.2.3-rc.1+build.5",
        "1.0.0-x-y-z.--",
    ] {
        let mut v = base();
        v["version"] = json!(good);
        assert_eq!(caps(&v).version, good);
    }
    for bad in [
        "",
        "1",
        "1.0",
        "1.0.0.0",
        "v1.0.0",
        "V1.0.0",
        "01.0.0",
        "1.00.0",
        "1.0.00",
        "-1.0.0",
        "1.-1.0",
        "1.0.0-",
        "1.0.0+",
        "1.0.0-+x",
        "1.0.0-01",
        "1.0.0-alpha..1",
        "1.0.0-alpha.",
        "1.0.0 ",
        " 1.0.0",
        "1.0.0\n",
        "1.0.0\0",
        "1,0,0",
        "1.0.0-α",
        "1.0.0+β",
        "١.٠.٠",
        "1.0.0 beta",
        "latest",
        "^1.0.0",
        ">=1.0.0",
        "1.x.0",
        "1.0.*",
        "1e3.0.0",
        "0x1.0.0",
        "18446744073709551616.0.0",
        "1.0.0-alpha_1",
    ] {
        let mut v = base();
        v["version"] = json!(bad);
        let e = parse(&v).expect_err(&format!("version {bad:?} was accepted"));
        assert_eq!(e.reason, reason::PACKAGE_INVALID, "{bad:?}");
    }
    // Over the 64-character cap, even when the shape is right.
    let mut v = base();
    v["version"] = json!(format!("1.0.0-{}", "a".repeat(58)));
    assert!(parse(&v).is_ok(), "64 characters");
    v["version"] = json!(format!("1.0.0-{}", "a".repeat(59)));
    assert!(parse(&v).is_err(), "65 characters");
    for not_a_string in [
        json!(1),
        json!(1.0),
        json!(null),
        json!(true),
        json!(["1.0.0"]),
    ] {
        let mut v = base();
        v["version"] = not_a_string.clone();
        assert!(parse(&v).is_err(), "{not_a_string}");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// path-like keys in the manifest
// ---------------------------------------------------------------------------------------------------------------------

const HOSTILE_PATHS: &[&str] = &[
    "payload/../p1x.json",
    "payload/../../etc/passwd",
    "payload/a/../../b",
    "payload//a",
    "payload/./a",
    "payload/C:/Windows/x.dll",
    "payload/c:evil",
    "payload/\\\\server\\share\\x",
    "payload/a\\b",
    "payload/CON",
    "payload/a.",
    "payload/a ",
    "payload/a\u{0}b",
    "payload/a\u{202e}b",
];

#[test]
fn the_manifest_schema_is_not_the_path_safety_layer_but_keys_outside_payload_never_pass() {
    // Pinned: the schema only requires the `payload/` prefix; names with `..`, drive letters, UNC or backslashes parse. The archive
    // audit refuses an entry of such a name (next test, and `tests/zipaudit.rs`), so nothing can be staged under them.
    for p in HOSTILE_PATHS {
        let mut v = base();
        v["files"] = json!({ (*p): { "sha256": SHA, "size": 1 } });
        let accepted = parse(&v).is_ok();
        assert!(
            accepted || p.contains('\0'),
            "{p:?} is refused at the manifest layer; update the doc comment above"
        );
    }
    for p in [
        "../payload/x",
        "/payload/x",
        "payload",
        "payload/",
        "p1x.json",
        "payloads/x",
        "PAYLOAD/x",
        "./payload/x",
        "C:/payload/x",
        "\\payload\\x",
        "",
    ] {
        let mut v = base();
        v["files"] = json!({ (p): { "sha256": SHA, "size": 1 } });
        assert!(parse(&v).is_err(), "files key {p:?} was accepted");
        let mut v = base();
        v["scripts"] = json!([p]);
        assert!(parse(&v).is_err(), "scripts entry {p:?} was accepted");
    }
}

fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, data) in entries {
        w.start_file(*name, opts).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

#[test]
fn an_archive_entry_with_any_of_those_names_is_refused_by_the_audit_and_a_plain_one_passes() {
    for p in HOSTILE_PATHS {
        let pkg = zip_with(&[("p1x.json", b"{}"), (p, b"x")]);
        match audit_zip(&mut Cursor::new(pkg), &Limits::default()) {
            Err(e) => assert!(
                e.reason == reason::UNSAFE_ENTRY || e.reason == reason::UNSUPPORTED,
                "{p:?}: {e}"
            ),
            Ok(_) => panic!("the audit accepted the entry {p:?}"),
        }
    }
    let ok = zip_with(&[("p1x.json", b"{}"), ("payload/a.md", b"x")]);
    assert!(audit_zip(&mut Cursor::new(ok), &Limits::default()).is_ok());
}

#[test]
fn a_symlink_entry_is_refused_whatever_it_points_at() {
    for target in [
        "../../etc/passwd",
        "/etc/passwd",
        "C:\\Windows",
        "\\\\server\\share",
        "payload/other",
        ".",
    ] {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("p1x.json", opts).unwrap();
        w.write_all(b"{}").unwrap();
        w.add_symlink("payload/link", target, opts).unwrap();
        let pkg = w.finish().unwrap().into_inner();
        let e = audit_zip(&mut Cursor::new(pkg), &Limits::default())
            .expect_err(&format!("symlink to {target:?} accepted"));
        assert_eq!(e.reason, reason::UNSAFE_ENTRY, "{target:?}: {e}");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// archive caps: both sides of every limit
// ---------------------------------------------------------------------------------------------------------------------

fn audit_with(
    entries: &[(&str, Vec<u8>)],
    limits: &Limits,
    deflate: bool,
) -> Result<(), plur1bus_ext::refusal::Refusal> {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let method = if deflate {
        zip::CompressionMethod::Deflated
    } else {
        zip::CompressionMethod::Stored
    };
    let opts = zip::write::SimpleFileOptions::default().compression_method(method);
    for (name, data) in entries {
        w.start_file(*name, opts).unwrap();
        w.write_all(data).unwrap();
    }
    let pkg = w.finish().unwrap().into_inner();
    audit_zip(&mut Cursor::new(pkg), limits).map(drop)
}

#[test]
fn the_entry_size_cap_holds_at_limit_minus_one_limit_and_limit_plus_one() {
    let limits = Limits {
        entry_bytes: 4096,
        ..Limits::default()
    };
    for (size, ok) in [(4095usize, true), (4096, true), (4097, false)] {
        let r = audit_with(
            &[("p1x.json", b"{}".to_vec()), ("payload/f", vec![7u8; size])],
            &limits,
            false,
        );
        match (r, ok) {
            (Ok(()), true) => {}
            (Err(e), false) => assert_eq!(e.reason, reason::TOO_LARGE, "{size}: {e}"),
            (other, _) => panic!("{size} bytes: {other:?}"),
        }
    }
}

#[test]
fn the_entry_count_cap_holds_at_limit_minus_one_limit_and_limit_plus_one() {
    let limits = Limits {
        max_entries: 10,
        ..Limits::default()
    };
    for (count, ok) in [(9usize, true), (10, true), (11, false)] {
        let mut entries: Vec<(String, Vec<u8>)> = vec![("p1x.json".into(), b"{}".to_vec())];
        entries.extend((0..count - 1).map(|i| (format!("payload/f{i}"), vec![1u8])));
        let borrowed: Vec<(&str, Vec<u8>)> = entries
            .iter()
            .map(|(n, d)| (n.as_str(), d.clone()))
            .collect();
        let r = audit_with(&borrowed, &limits, false);
        match (r, ok) {
            (Ok(()), true) => {}
            (Err(e), false) => assert_eq!(e.reason, reason::TOO_LARGE, "{count}: {e}"),
            (other, _) => panic!("{count} entries: {other:?}"),
        }
    }
}

#[test]
fn the_compression_ratio_cap_refuses_a_bomb_and_passes_ordinary_data() {
    // 4 MiB of zeros deflates to a few kilobytes: far above 100:1.
    let zeros = vec![0u8; 4 << 20];
    let e = audit_with(
        &[
            ("p1x.json", b"{}".to_vec()),
            ("payload/zeros", zeros.clone()),
        ],
        &Limits::default(),
        true,
    )
    .unwrap_err();
    assert_eq!(e.reason, reason::TOO_LARGE, "{e}");
    // The same bytes pass when the cap is lifted high enough, so the ratio is what refused them.
    assert!(audit_with(
        &[("p1x.json", b"{}".to_vec()), ("payload/zeros", zeros)],
        &Limits {
            max_ratio: 1_000_000,
            ..Limits::default()
        },
        true
    )
    .is_ok());
    // Seeded pseudo-random bytes do not compress: a normal ratio.
    let mut rng = Rng(SEED);
    let noise: Vec<u8> = (0..64 * 1024).map(|_| rng.next() as u8).collect();
    assert!(audit_with(
        &[("p1x.json", b"{}".to_vec()), ("payload/noise", noise)],
        &Limits::default(),
        true
    )
    .is_ok());
    // A nested archive is only bytes to the audit: a zip inside a zip is not opened.
    let inner = zip_with(&[("inner.txt", b"x")]);
    assert!(audit_with(
        &[("p1x.json", b"{}".to_vec()), ("payload/inner.zip", inner)],
        &Limits::default(),
        false
    )
    .is_ok());
}

#[test]
fn the_whole_package_cap_counts_the_sum_of_the_declared_sizes() {
    // Compressible data keeps the archive itself far below the cap, so only the sum of the declared uncompressed sizes can refuse.
    let limits = Limits {
        package_bytes: 10_000,
        entry_bytes: 10_000,
        max_ratio: 1_000_000,
        ..Limits::default()
    };
    let sizes = |a: usize, b: usize| {
        audit_with(
            &[
                ("p1x.json", b"{}".to_vec()),
                ("payload/a", vec![0u8; a]),
                ("payload/b", vec![0u8; b]),
            ],
            &limits,
            true,
        )
    };
    assert!(sizes(4000, 5000).is_ok());
    assert!(
        sizes(5000, 4998).is_ok(),
        "exactly at the cap with the manifest's two bytes"
    );
    let e = sizes(5000, 4999).unwrap_err();
    assert_eq!(e.reason, reason::TOO_LARGE, "{e}");
    assert!(e.detail.contains("in total"), "{e}");
    // The archive file itself is capped by the same number.
    let noise: Vec<u8> = {
        let mut rng = Rng(SEED);
        (0..12_000).map(|_| rng.next() as u8).collect()
    };
    let e = audit_with(
        &[("p1x.json", b"{}".to_vec()), ("payload/n", noise)],
        &limits,
        false,
    )
    .unwrap_err();
    assert_eq!(e.reason, reason::TOO_LARGE, "{e}");
}

// ---------------------------------------------------------------------------------------------------------------------
// oversized fields and a seeded mutation run
// ---------------------------------------------------------------------------------------------------------------------

type Setter = fn(&mut Value, usize);

fn set_title(v: &mut Value, n: usize) {
    v["title"]["en"] = json!("x".repeat(n));
}
fn set_summary(v: &mut Value, n: usize) {
    v["summary"]["en"] = json!("x".repeat(n));
}
fn set_licence(v: &mut Value, n: usize) {
    v["licence"] = json!("x".repeat(n));
}
fn set_publisher_name(v: &mut Value, n: usize) {
    v["publisher"]["name"] = json!("x".repeat(n));
}
fn set_secret_slot(v: &mut Value, n: usize) {
    v["capabilities"]["secrets"] =
        json!([{ "slot": format!("a{}", "b".repeat(n)), "label": {"en": "K"}, "required": true }]);
}
fn set_tool_name(v: &mut Value, n: usize) {
    v["capabilities"]["tools"] = json!([{ "name": "t".repeat(n), "effect": "read" }]);
}

#[test]
fn oversized_fields_are_refused_at_their_cap_plus_one_and_the_whole_manifest_at_one_mebibyte() {
    let cases: [(&str, Setter); 6] = [
        ("title.en", set_title),
        ("summary.en", set_summary),
        ("licence", set_licence),
        ("publisher.name", set_publisher_name),
        ("secret slot", set_secret_slot),
        ("tool name", set_tool_name),
    ];
    let mut capped = 0;
    for (what, set) in &cases {
        // Find the cap by bisection, then check both sides of it.
        let accepts = |n: usize| {
            let mut v = base();
            set(&mut v, n);
            parse(&v).is_ok()
        };
        assert!(accepts(1), "{what}: one character is refused");
        let (mut lo, mut hi) = (1usize, 100_000usize);
        if accepts(hi) {
            continue; // no cap below 100 000: nothing to check on this field
        }
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if accepts(mid) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        assert!(
            accepts(lo) && !accepts(lo + 1),
            "{what}: the cap {lo} is not sharp"
        );
        capped += 1;
    }
    assert!(capped >= 4, "only {capped} of the six fields have a cap");
    // The whole manifest: a legal-looking document padded to the byte.
    let mut v = base();
    v["notes"] = json!({ "en": "n" });
    let padded = |extra: usize| {
        let mut d = raw(&v);
        d.extend(std::iter::repeat_n(b' ', extra));
        d
    };
    let room = MAX_MANIFEST_BYTES - raw(&v).len();
    assert!(parse_manifest(&padded(room), &[]).is_ok(), "exactly 1 MiB");
    let e = parse_manifest(&padded(room + 1), &[]).unwrap_err();
    assert_eq!(e.reason, reason::TOO_LARGE, "{e}");
}

/// Replaces the JSON value at a random place with one of a small set of troublesome values.
fn mutate(rng: &mut Rng, v: &mut Value) {
    fn places(v: &Value, path: &mut Vec<String>, out: &mut Vec<Vec<String>>) {
        out.push(path.clone());
        match v {
            Value::Object(m) => {
                for (k, x) in m {
                    path.push(k.clone());
                    places(x, path, out);
                    path.pop();
                }
            }
            Value::Array(a) => {
                for (i, x) in a.iter().enumerate() {
                    path.push(i.to_string());
                    places(x, path, out);
                    path.pop();
                }
            }
            _ => {}
        }
    }
    let mut all = Vec::new();
    places(v, &mut Vec::new(), &mut all);
    let path = all[rng.below(all.len())].clone();
    let troublesome = [
        Value::Null,
        json!(true),
        json!(false),
        json!(0),
        json!(-1),
        json!(1.5),
        json!(u64::MAX),
        json!(""),
        json!(" "),
        json!("\u{0}"),
        json!("../.."),
        json!("payload/../x"),
        json!("É"),
        json!("a".repeat(300)),
        json!([]),
        json!({}),
        json!([[]]),
        json!({"": ""}),
        json!("demo/hardening"),
        json!("1.0.0"),
        json!("keychain"),
        json!("\u{202e}"),
    ];
    let new = troublesome[rng.below(troublesome.len())].clone();
    if path.is_empty() {
        *v = new;
        return;
    }
    let mut cur = &mut *v;
    for seg in &path[..path.len() - 1] {
        cur = match cur {
            Value::Object(m) => m.get_mut(seg).unwrap(),
            Value::Array(a) => a.get_mut(seg.parse::<usize>().unwrap()).unwrap(),
            _ => return,
        };
    }
    match (cur, path.last().unwrap()) {
        (Value::Object(m), k) => {
            if rng.chance(1, 5) {
                m.remove(k);
            } else {
                m.insert(k.clone(), new);
            }
        }
        (Value::Array(a), k) => {
            let i = k.parse::<usize>().unwrap();
            if rng.chance(1, 5) {
                a.remove(i);
            } else {
                a[i] = new;
            }
        }
        _ => {}
    }
}

#[test]
fn a_seeded_mutation_run_never_panics_and_every_accepted_manifest_keeps_its_invariants() {
    let mut rng = Rng(SEED ^ 0xa11);
    let mut template = base();
    template["capabilities"]["hostBridge"] = json!(["keychain"]);
    template["capabilities"]["mcpApps"] = json!(true);
    template["capabilities"]["secrets"] =
        json!([{ "slot": "apiKey", "label": { "en": "Key" }, "required": true }]);
    template["dependencies"] = json!([{ "id": "demo/other", "range": "^1.0" }]);
    caps(&template);
    let reserved = ["core", "memory"];
    let (mut accepted, mut refused) = (0, 0);
    for case in 0..4000 {
        let mut v = template.clone();
        for _ in 0..1 + rng.below(3) {
            mutate(&mut rng, &mut v);
        }
        let ctx = format!("seed {:#x} case {case}: {v}", SEED ^ 0xa11);
        match parse_manifest(&raw(&v), &reserved) {
            Err(e) => {
                refused += 1;
                assert!(
                    [reason::PACKAGE_INVALID, reason::TOO_LARGE, reason::RESERVED]
                        .contains(&e.reason)
                        && e.code == "E_INVALID_PARAMS",
                    "{ctx}: {e}"
                );
            }
            Ok(m) => {
                accepted += 1;
                assert!(
                    valid_name(&m.name) && !reserved.contains(&m.name.as_str()),
                    "{ctx}"
                );
                assert!(
                    valid_publisher(m.publisher["id"].as_str().unwrap()),
                    "{ctx}"
                );
                assert_eq!(
                    m.id,
                    format!("{}/{}", m.publisher["id"].as_str().unwrap(), m.name),
                    "{ctx}"
                );
                assert!(semver::Version::parse(&m.version).is_ok(), "{ctx}");
                assert!(
                    m.files.keys().all(|k| k.starts_with("payload/"))
                        && m.scripts.iter().all(|s| s.starts_with("payload/")),
                    "{ctx}"
                );
                // Every right it declares comes from the manifest: no hostbridge or mcpapps without the field.
                let rights = ids(&m);
                assert_eq!(
                    rights.iter().any(|r| r.starts_with("hostbridge:")),
                    m.capabilities["hostBridge"]
                        .as_array()
                        .is_some_and(|a| !a.is_empty()),
                    "{ctx}"
                );
                assert_eq!(
                    rights.iter().any(|r| r == "mcpapps"),
                    m.capabilities["mcpApps"] == json!(true),
                    "{ctx}"
                );
            }
        }
    }
    assert!(
        accepted > 100 && refused > 1000,
        "{accepted} accepted, {refused} refused"
    );
}
