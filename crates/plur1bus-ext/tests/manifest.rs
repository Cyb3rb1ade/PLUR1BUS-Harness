//! The `.p1x` manifest: schema, parsing, naming rules and compatibility (spec 2026-09-27 §5.2, §8.4 step 5).
use plur1bus_ext::compat::{capability_hash, check_compat, harness_req, HostFacts};
use plur1bus_ext::manifest::{parse_manifest, valid_name, valid_publisher, Kind, P1X_SCHEMA_JSON};
use plur1bus_ext::refusal::reason;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

/// The §5.2 example with real hashes over real bytes.
fn example() -> Value {
    let skill = b"---\nname: zabbix-triage\n---\nTriage.\n";
    let script = b"print('triage')\n";
    let licence = b"MIT\n";
    json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": "plur1bus/zabbix-triage",
        "name": "zabbix-triage",
        "version": "1.2.0",
        "kind": "skill",
        "title": { "en": "Zabbix triage", "de": "Zabbix-Triage" },
        "summary": { "en": "Triage Zabbix problems.", "de": "Zabbix-Probleme sichten." },
        "publisher": { "id": "plur1bus", "name": "PLUR1BUS", "url": "https://plur1bus.app" },
        "licence": "MIT",
        "homepage": "https://plur1bus.app/ext/zabbix-triage",
        "repository": "https://github.com/plur1bus/zabbix-triage",
        "compat": {
            "harness": ">=0.2.0 <1.0.0",
            "moduleApi": ["1"],
            "rpc": "^1.4",
            "platforms": ["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64", "win32-arm64"],
            "container": true
        },
        "requires": { "runtime": { "type": "python", "range": ">=3.12", "via": "uv", "lock": "payload/uv.lock" } },
        "dependencies": [ { "id": "plur1bus/markitdown", "range": "^1.0" } ],
        "capabilities": {
            "network": { "mode": "allowlist", "hosts": ["zabbix.example.org"] },
            "filesystem": [ { "scope": "extension-data", "access": "read-write" } ],
            "processes": { "spawn": false },
            "secrets": [ { "slot": "apiKey", "label": { "en": "API key", "de": "API-Schlüssel" }, "required": true } ],
            "hostBridge": [],
            "harness": { "authority": "none" },
            "tools": [ { "name": "run_query", "effect": "read" } ],
            "mcpApps": false
        },
        "remote": null,
        "members": null,
        "upstream": null,
        "defaultEnabled": false,
        "scripts": ["payload/scripts/triage.py"],
        "files": {
            "payload/SKILL.md": { "sha256": hex(skill), "size": skill.len() },
            "payload/scripts/triage.py": { "sha256": hex(script), "size": script.len(), "exec": true },
            "payload/LICENSE": { "sha256": hex(licence), "size": licence.len() }
        },
        "notes": { "en": "First release." },
        "created": "2026-10-01T12:00:00Z"
    })
}

fn raw(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap()
}

fn refused(v: &Value, reserved: &[&str]) -> plur1bus_ext::refusal::Refusal {
    parse_manifest(&raw(v), reserved).expect_err("must be refused")
}

#[test]
fn parses_the_spec_example_manifest() {
    assert!(P1X_SCHEMA_JSON.contains("plur1bus.app/schema/p1x/1/p1x.schema.json"));
    let m = parse_manifest(&raw(&example()), &["core"]).expect("the spec example parses");
    assert_eq!(m.id, "plur1bus/zabbix-triage");
    assert_eq!(m.kind, Kind::Skill);
    assert_eq!(m.files.len(), 3);
    assert!(m.files["payload/scripts/triage.py"].exec);
    assert!(!m.files["payload/LICENSE"].exec);
    assert_eq!(m.title["de"], "Zabbix-Triage");
    assert!(!m.default_enabled);
    assert_eq!(m.rest["created"], "2026-10-01T12:00:00Z");
    assert!(m.rest.contains_key("homepage"));
    assert_eq!(m.dependencies.len(), 1);
    // The lenient shapes the brief allows: nullable extras and optional bits.
    let mut min = example();
    let o = min.as_object_mut().unwrap();
    for k in [
        "dependencies",
        "defaultEnabled",
        "homepage",
        "repository",
        "remote",
        "members",
        "upstream",
        "notes",
        "created",
        "$schema",
    ] {
        o.remove(k);
    }
    parse_manifest(&raw(&min), &[]).expect("optional keys may be absent");
}

#[test]
fn refuses_a_bom_non_utf8_and_over_1_mib() {
    let mut bom = vec![0xEF, 0xBB, 0xBF];
    bom.extend(raw(&example()));
    assert_eq!(
        parse_manifest(&bom, &[]).unwrap_err().reason,
        reason::PACKAGE_INVALID
    );
    let mut bad = raw(&example());
    bad.insert(2, 0xFF);
    let e = parse_manifest(&bad, &[]).unwrap_err();
    assert_eq!(e.reason, reason::PACKAGE_INVALID);
    assert!(e.detail.contains("UTF-8"), "{}", e.detail);
    let mut big = example();
    big["notes"] = json!({ "en": "x" });
    let mut b = raw(&big);
    b.extend(std::iter::repeat_n(b' ', (1 << 20) + 1 - b.len()));
    assert_eq!(b.len(), (1 << 20) + 1);
    assert_eq!(
        parse_manifest(&b, &[]).unwrap_err().reason,
        reason::TOO_LARGE
    );
    // Exactly 1 MiB (padded with trailing whitespace) is fine.
    b.pop();
    parse_manifest(&b, &[]).expect("exactly 1 MiB is allowed");
    assert_eq!(
        parse_manifest(b"not json", &[]).unwrap_err().reason,
        reason::PACKAGE_INVALID
    );
    assert_eq!(
        parse_manifest(b"[]", &[]).unwrap_err().reason,
        reason::PACKAGE_INVALID
    );
}

#[test]
fn refuses_unknown_properties_at_every_level() {
    let paths: &[&[&str]] = &[
        &[],
        &["publisher"],
        &["compat"],
        &["requires"],
        &["requires", "runtime"],
        &["capabilities"],
        &["capabilities", "network"],
        &["capabilities", "processes"],
        &["capabilities", "harness"],
        &["files", "payload/SKILL.md"],
        &["dependencies", "0"],
        &["capabilities", "filesystem", "0"],
        &["capabilities", "secrets", "0"],
        &["capabilities", "tools", "0"],
    ];
    for p in paths {
        let mut v = example();
        let mut cur = &mut v;
        for k in *p {
            cur = match cur {
                Value::Array(a) => &mut a[k.parse::<usize>().unwrap()],
                _ => &mut cur[*k],
            };
        }
        cur["surprise"] = json!(1);
        let e = refused(&v, &[]);
        assert_eq!(e.reason, reason::PACKAGE_INVALID, "{p:?}");
        assert!(e.detail.contains("surprise"), "{p:?}: {}", e.detail);
    }
    // Files outside payload/ and malformed hashes are schema errors too.
    let mut v = example();
    v["files"]["p1x.json"] = json!({ "sha256": "0".repeat(64), "size": 1 });
    assert_eq!(refused(&v, &[]).reason, reason::PACKAGE_INVALID);
    let mut v = example();
    v["files"]["payload/LICENSE"]["sha256"] = json!("A".repeat(64));
    assert_eq!(refused(&v, &[]).reason, reason::PACKAGE_INVALID);
    let mut v = example();
    v["format"] = json!(2);
    assert_eq!(refused(&v, &[]).reason, reason::PACKAGE_INVALID);
}

#[test]
fn name_rule_is_the_d14_and_agent_skills_intersection() {
    for ok in ["a", "zabbix-triage", "a1", "a-1-b", &"a".repeat(62)] {
        assert!(valid_name(ok), "{ok}");
    }
    for bad in [
        "",
        "A",
        "-a",
        "a--b",
        "a-",
        "a_b",
        "1a",
        "a.b",
        &"a".repeat(63),
    ] {
        assert!(!valid_name(bad), "{bad}");
    }
    let mut v = example();
    v["name"] = json!("A");
    v["id"] = json!("plur1bus/A");
    assert_eq!(refused(&v, &[]).reason, reason::PACKAGE_INVALID);
    let mut v = example();
    let long = "a".repeat(63);
    v["name"] = json!(long);
    v["id"] = json!(format!("plur1bus/{long}"));
    assert_eq!(refused(&v, &[]).reason, reason::PACKAGE_INVALID);
}

#[test]
fn publisher_rule() {
    for ok in ["plur1bus", "io.github.jdoe", "com.example", "a", "a-b.c-d"] {
        assert!(valid_publisher(ok), "{ok}");
    }
    for bad in ["IO.x", "x.", ".x", "1x", "", "x..y", &"a".repeat(33), "x_y"] {
        assert!(!valid_publisher(bad), "{bad}");
    }
    let mut v = example();
    v["publisher"]["id"] = json!("IO.x");
    v["id"] = json!("IO.x/zabbix-triage");
    assert_eq!(refused(&v, &[]).reason, reason::PACKAGE_INVALID);
}

#[test]
fn id_must_match_name_and_publisher() {
    let mut v = example();
    v["id"] = json!("plur1bus/other-name");
    let e = refused(&v, &[]);
    assert_eq!(e.reason, reason::PACKAGE_INVALID);
    assert!(e.detail.contains("name"), "{}", e.detail);
    let mut v = example();
    v["id"] = json!("someone/zabbix-triage");
    let e = refused(&v, &[]);
    assert_eq!(e.reason, reason::PACKAGE_INVALID);
    assert!(e.detail.contains("publisher"), "{}", e.detail);
    let mut v = example();
    v["id"] = json!("zabbix-triage");
    assert_eq!(refused(&v, &[]).reason, reason::PACKAGE_INVALID);
    let mut v = example();
    v["id"] = json!("plur1bus/zabbix-triage/x");
    assert_eq!(refused(&v, &[]).reason, reason::PACKAGE_INVALID);
}

#[test]
fn reserved_names_are_refused() {
    for n in ["core", "con"] {
        let mut v = example();
        v["name"] = json!(n);
        v["id"] = json!(format!("plur1bus/{n}"));
        let e = refused(&v, &["core", "con"]);
        assert_eq!(e.reason, reason::RESERVED, "{n}");
        assert!(e.detail.contains(n));
        parse_manifest(&raw(&v), &[]).expect("not reserved when the caller reserves nothing");
    }
}

#[test]
fn harness_ranges_with_spaces_parse_and_or_ranges_are_refused() {
    let r = harness_req(">=0.2.0 <1.0.0").unwrap();
    assert!(r.matches(&semver::Version::new(0, 2, 0)));
    assert!(r.matches(&semver::Version::new(0, 9, 9)));
    assert!(!r.matches(&semver::Version::new(1, 0, 0)));
    assert!(!r.matches(&semver::Version::new(0, 1, 9)));
    assert!(harness_req("^1.4")
        .unwrap()
        .matches(&semver::Version::new(1, 4, 0)));
    assert!(harness_req("1.4.0")
        .unwrap()
        .matches(&semver::Version::new(1, 4, 0)));
    assert!(!harness_req("1.4.0")
        .unwrap()
        .matches(&semver::Version::new(1, 4, 1)));
    assert!(harness_req(">=0.2.0 || >=2.0.0").is_err());
    assert!(harness_req("").is_err());
    assert!(harness_req("latest").is_err());
    assert!(harness_req(">= 0.2.0").is_err());
    let mut v = example();
    v["compat"]["harness"] = json!(">=0.2.0 || >=2.0.0");
    let e = refused(&v, &[]);
    assert_eq!(e.reason, reason::PACKAGE_INVALID);
    assert!(e.detail.contains("/compat/harness"), "{}", e.detail);
    let mut v = example();
    v["compat"]["harness"] = json!(">=0.2.0   <1.0.0");
    assert_eq!(refused(&v, &[]).reason, reason::PACKAGE_INVALID);
}

fn host() -> HostFacts {
    HostFacts {
        harness_version: "0.3.0".into(),
        module_api_current: 1,
        rpc_version: "1.4.0".into(),
        platform: Some("linux-x64".into()),
        container: false,
    }
}

#[test]
fn compat_refuses_harness_module_api_rpc_platform_and_container_each_with_its_field_named() {
    let m = parse_manifest(&raw(&example()), &[]).unwrap();
    check_compat(&m, &host()).expect("compatible");
    type Mutate = Box<dyn Fn(&mut HostFacts)>;
    let cases: Vec<(&str, Mutate)> = vec![
        (
            "compat.harness",
            Box::new(|h| h.harness_version = "1.0.0".into()),
        ),
        ("compat.moduleApi", Box::new(|h| h.module_api_current = 2)),
        ("compat.rpc", Box::new(|h| h.rpc_version = "2.0.0".into())),
        (
            "compat.platforms",
            Box::new(|h| h.platform = Some("darwin-x64".into())),
        ),
    ];
    // (moduleApi is covered below for module/channel; the example is a skill.)
    for (field, mutate) in cases.into_iter().filter(|(f, _)| *f != "compat.moduleApi") {
        let mut h = host();
        mutate(&mut h);
        let e = check_compat(&m, &h).expect_err(field);
        assert_eq!(e.reason, reason::INCOMPATIBLE, "{field}");
        assert!(e.detail.contains(field), "{field}: {}", e.detail);
    }
    // A real host id (Target::id) against a manifest that lists only linux targets.
    let mut lin = example();
    lin["compat"]["platforms"] = json!(["linux-x64", "linux-arm64"]);
    let ml = parse_manifest(&raw(&lin), &[]).unwrap();
    let mut h = host();
    h.platform = Some("darwin-arm64".into());
    let e = check_compat(&ml, &h).unwrap_err();
    assert_eq!(e.reason, reason::INCOMPATIBLE);
    assert!(e.detail.contains("compat.platforms"), "{}", e.detail);
    h.platform = Some("linux-arm64".into());
    check_compat(&ml, &h).expect("listed platform");
    // moduleApi binds module and channel only; a skill's list is ignored.
    let mut h = host();
    h.module_api_current = 2;
    check_compat(&m, &h).expect("a skill ignores moduleApi");
    for kind in ["module", "channel"] {
        let mut mv = example();
        mv["kind"] = json!(kind);
        let mm = parse_manifest(&raw(&mv), &[]).unwrap();
        assert!(
            check_compat(&mm, &h)
                .unwrap_err()
                .detail
                .contains("compat.moduleApi"),
            "{kind}"
        );
    }
    let mut v = example();
    v["compat"]["container"] = json!(false);
    let m2 = parse_manifest(&raw(&v), &[]).unwrap();
    check_compat(&m2, &host()).expect("a host outside a container is fine");
    let mut h = host();
    h.container = true;
    let e = check_compat(&m2, &h).unwrap_err();
    assert_eq!(e.reason, reason::INCOMPATIBLE);
    assert!(e.detail.contains("compat.container"), "{}", e.detail);
    // Unknown platform: not checked. A dev build of the harness matches on its release triple.
    let mut h = host();
    h.platform = None;
    h.harness_version = "0.3.0-dev.4+abc".into();
    check_compat(&m, &h).expect("unknown platform and pre-release harness");
}

#[test]
fn win_platform_ids_map_to_win32() {
    let mut v = example();
    v["compat"]["platforms"] = json!(["win32-x64"]);
    let m = parse_manifest(&raw(&v), &[]).unwrap();
    let mut h = host();
    h.platform = Some("win-x64".into());
    check_compat(&m, &h).expect("win-x64 is win32-x64");
    h.platform = Some("win-arm64".into());
    assert_eq!(
        check_compat(&m, &h).unwrap_err().reason,
        reason::INCOMPATIBLE
    );
    v["compat"]["platforms"] = json!(["win32-arm64"]);
    let m = parse_manifest(&raw(&v), &[]).unwrap();
    check_compat(&m, &h).expect("win-arm64 is win32-arm64");
}

#[test]
fn capability_hash_ignores_key_order() {
    let a: Value = serde_json::from_str(
        r#"{"network":{"mode":"none","hosts":[]},"processes":{"spawn":false}}"#,
    )
    .unwrap();
    let b: Value = serde_json::from_str(
        r#"{"processes":{"spawn":false},"network":{"hosts":[],"mode":"none"}}"#,
    )
    .unwrap();
    assert_eq!(capability_hash(&a), capability_hash(&b));
    let h = capability_hash(&a);
    assert_eq!(h.len(), 64);
    assert!(h
        .bytes()
        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
    // Array order is significant; values matter.
    let c: Value = serde_json::from_str(
        r#"{"network":{"mode":"any","hosts":[]},"processes":{"spawn":false}}"#,
    )
    .unwrap();
    assert_ne!(capability_hash(&a), capability_hash(&c));
    assert_ne!(
        capability_hash(&json!([1, 2])),
        capability_hash(&json!([2, 1]))
    );
    // Pin the canonical form: compact, sorted keys.
    assert_eq!(
        capability_hash(&json!({"b": 1, "a": [true]})),
        hex(br#"{"a":[true],"b":1}"#)
    );
}

fn ok(v: &Value) -> bool {
    parse_manifest(&raw(v), &[]).is_ok()
}

#[test]
fn conditional_required_rules() {
    // allowlist needs hosts
    let mut v = example();
    v["capabilities"]["network"] = json!({ "mode": "allowlist" });
    assert!(!ok(&v));
    v["capabilities"]["network"] = json!({ "mode": "allowlist", "hosts": ["a.example"] });
    assert!(ok(&v));
    v["capabilities"]["network"] = json!({ "mode": "any" });
    assert!(ok(&v), "hosts are not needed outside allowlist");
    // scoped needs rpc
    let mut v = example();
    v["capabilities"]["harness"] = json!({ "authority": "scoped" });
    assert!(!ok(&v));
    v["capabilities"]["harness"] = json!({ "authority": "scoped", "rpc": ["ext.list"] });
    assert!(ok(&v));
    v["capabilities"]["harness"] = json!({ "authority": "full" });
    assert!(ok(&v));
    // scope path needs path
    let mut v = example();
    v["capabilities"]["filesystem"] = json!([{ "scope": "path", "access": "read" }]);
    assert!(!ok(&v));
    v["capabilities"]["filesystem"] =
        json!([{ "scope": "path", "access": "read", "path": "/srv/x" }]);
    assert!(ok(&v));
    v["capabilities"]["filesystem"] = json!([{ "scope": "home", "access": "read" }]);
    assert!(ok(&v));
}

#[test]
fn length_caps_hold_on_both_sides() {
    let cases: [(&str, usize); 4] = [
        ("summary", 280),
        ("notes", 1200),
        ("title", 120),
        ("licence", 200),
    ];
    for (field, max) in cases {
        let mk = |n: usize| {
            let mut v = example();
            let s = "x".repeat(n);
            v[field] = if field == "licence" {
                json!(s)
            } else {
                json!({ "en": s })
            };
            v
        };
        assert!(ok(&mk(max)), "{field} at {max}");
        assert!(!ok(&mk(max + 1)), "{field} at {}", max + 1);
    }
    // Characters, not bytes: 280 two-byte characters are within the summary cap.
    let mut v = example();
    v["summary"] = json!({ "en": "ä".repeat(280) });
    assert!(ok(&v));
}
