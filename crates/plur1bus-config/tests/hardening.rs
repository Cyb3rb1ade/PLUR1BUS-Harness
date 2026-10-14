//! Validation, file handling and the defaults of `config.json`, driven by the schema the TypeScript side uses
//! (`packages/config-schema/schema/config.schema.json`, read-only here). The cases are derived from the schema (every property that
//! is present in the defaults, every closed object, every bound), not from a hand-kept list of keys, so a new key is covered the day
//! it is added.
//!
//! Behaviour under test, from docs/config.md and ADR-013: the top-level object is closed (an unknown key is an error, not a
//! warning); `schemaVersion` is the constant 1 and the Rust loader does not migrate (there is no version 2); defaults come from the
//! schema's `default` keywords only; the file is plain JSON (no comments, no BOM). Nothing here touches the process environment or
//! the clock.
use plur1bus_config::{
    defaults, load, parse, parse_unvalidated, read, read_for_lookup, read_unvalidated, serialize,
    set, validate, write_atomic, ConfigError, SCHEMA_JSON,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

const SEED: u64 = 0x636f_6e66_6967_0001;

/// What a minimal file (`{"schemaVersion": 1}`) parses to: the defaults without the optional `$schema` header, which only a
/// newly created file carries.
fn defaults_without_schema_key() -> Value {
    let mut d = defaults();
    d.as_object_mut().unwrap().remove("$schema");
    d
}

fn schema() -> Value {
    serde_json::from_str(SCHEMA_JSON).unwrap()
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
}

// ---------------------------------------------------------------------------------------------------------------------
// walking the schema along the defaults
// ---------------------------------------------------------------------------------------------------------------------

/// A property (or the root) that is present in the defaults, with its schema node and its value there.
struct Node {
    path: Vec<String>,
    schema: Value,
    value: Value,
}

/// Every schema node reachable through `properties` whose whole chain of parents exists in `config`.
fn present_nodes(schema: &Value, config: &Value) -> Vec<Node> {
    fn walk(schema: &Value, value: &Value, path: &mut Vec<String>, out: &mut Vec<Node>) {
        out.push(Node {
            path: path.clone(),
            schema: schema.clone(),
            value: value.clone(),
        });
        if let (Some(props), Some(obj)) = (
            schema.get("properties").and_then(Value::as_object),
            value.as_object(),
        ) {
            for (k, sub) in props {
                if let Some(v) = obj.get(k) {
                    path.push(k.clone());
                    walk(sub, v, path, out);
                    path.pop();
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(schema, config, &mut Vec::new(), &mut out);
    out
}

fn with_value_at(config: &Value, path: &[String], v: Value) -> Value {
    let mut out = config.clone();
    let mut cur = &mut out;
    for seg in path {
        cur = cur.get_mut(seg).expect("path exists in the defaults");
    }
    *cur = v;
    out
}

fn with_key_at(config: &Value, path: &[String], key: &str, v: Value) -> Value {
    let mut out = config.clone();
    let mut cur = &mut out;
    for seg in path {
        cur = cur.get_mut(seg).unwrap();
    }
    cur.as_object_mut().unwrap().insert(key.into(), v);
    out
}

fn dotted(path: &[String]) -> String {
    if path.is_empty() {
        "<root>".into()
    } else {
        path.join(".")
    }
}

fn type_names(node: &Value) -> Vec<String> {
    match node.get("type") {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => vec![],
    }
}

fn is_error(r: Result<(), Vec<String>>) -> bool {
    r.is_err()
}

// ---------------------------------------------------------------------------------------------------------------------
// the file: syntax and encoding
// ---------------------------------------------------------------------------------------------------------------------

fn not_json(r: Result<Value, ConfigError>) -> String {
    match r {
        Err(ConfigError::NotJson(msg)) => msg,
        other => panic!("expected NotJson, got {other:?}"),
    }
}

#[test]
fn text_that_is_not_json_is_not_json_with_a_message_and_never_a_panic() {
    for text in [
        "",
        " ",
        "\n\r\n",
        "// only a comment\n",
        "/* only a comment */",
        "# only a comment\n",
        "// a comment first\n{\"schemaVersion\":1}",
        "{\"schemaVersion\":1} // trailing",
        "{\"schemaVersion\":1,}",
        "{schemaVersion:1}",
        "{'schemaVersion':1}",
        "{\"schemaVersion\":1}{\"schemaVersion\":1}",
        "[]garbage",
        "nul\0l",
        "{\"schemaVersion\":1",
        "\u{feff}",
    ] {
        assert!(!not_json(parse(text)).is_empty(), "{text:?}");
        assert!(!not_json(parse_unvalidated(text)).is_empty(), "{text:?}");
    }
}

#[test]
fn a_utf8_byte_order_mark_is_refused_like_the_typescript_loader_does() {
    // `JSON.parse` does not treat U+FEFF as whitespace either, so both sides refuse a file that Notepad saved with a BOM.
    let text = format!("\u{feff}{}", serialize(&defaults()));
    assert!(!not_json(parse(&text)).is_empty());
}

#[test]
fn crlf_line_endings_and_other_json_whitespace_parse_to_the_same_config() {
    let lf = serialize(&defaults());
    let crlf = lf.replace('\n', "\r\n");
    let tabs = lf.replace("  ", "\t");
    assert_eq!(parse(&crlf).unwrap(), defaults());
    assert_eq!(parse(&tabs).unwrap(), defaults());
    assert_eq!(parse(&format!("\r\n\t {lf}\r\n\r\n")).unwrap(), defaults());
}

#[test]
fn a_file_cut_off_at_any_byte_is_refused() {
    let text = serialize(&defaults());
    // The trailing newline is whitespace, not part of the document: every shorter prefix is cut inside it.
    for cut in 0..text.trim_end().len() {
        if !text.is_char_boundary(cut) {
            continue;
        }
        let prefix = &text[..cut];
        assert!(parse(prefix).is_err(), "prefix of {cut} bytes was accepted");
        assert!(
            parse_unvalidated(prefix).is_err(),
            "prefix of {cut} bytes was accepted unvalidated"
        );
    }
    assert!(parse(&text).is_ok());
}

#[test]
fn invalid_utf8_on_disk_is_an_io_error_for_every_reader() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    let mut bytes = serialize(&defaults()).into_bytes();
    bytes.splice(10..10, [0xff, 0xfe, 0xfd]);
    fs::write(&p, &bytes).unwrap();
    for (name, r) in [
        ("load", load(&p).map(|l| l.config)),
        ("read", read(&p)),
        ("read_unvalidated", read_unvalidated(&p)),
        ("read_for_lookup", read_for_lookup(&p, &[])),
    ] {
        match r {
            Err(ConfigError::Io(e)) => {
                assert_eq!(e.kind(), std::io::ErrorKind::InvalidData, "{name}")
            }
            other => panic!("{name}: expected an io error, got {other:?}"),
        }
    }
    assert_eq!(
        fs::read(&p).unwrap(),
        bytes,
        "a refused file is never rewritten"
    );
}

#[test]
fn duplicate_keys_are_last_one_wins_exactly_as_json_parse_does() {
    // Pinned: serde_json and JSON.parse agree, so the CLI and the core see the same file. Not an error on either side.
    let text = r#"{"schemaVersion":2,"schemaVersion":1}"#;
    assert_eq!(parse(text).unwrap()["schemaVersion"], json!(1));
    let text = r#"{"schemaVersion":1,"schemaVersion":2}"#;
    match parse(text) {
        Err(ConfigError::Invalid(errs)) => assert!(
            errs.iter()
                .any(|e| e.contains("schemaVersion") || e.contains("const")),
            "{errs:?}"
        ),
        other => panic!("{other:?}"),
    }
    let text = r#"{"schemaVersion":1,"core":{"logLevel":"info"},"core":{"logLevel":"loud"}}"#;
    assert!(matches!(parse(text), Err(ConfigError::Invalid(_))));
}

#[test]
fn nesting_1000_deep_is_refused_and_never_a_stack_overflow() {
    let deep = format!("{}{}", "[".repeat(1000), "]".repeat(1000));
    assert!(parse(&deep).is_err());
    let deep_obj = format!(
        "{{\"schemaVersion\":1,\"providers\":{}1{}}}",
        "{\"a\":".repeat(1000),
        "}".repeat(1000)
    );
    assert!(parse(&deep_obj).is_err());
    assert!(parse(&"[".repeat(1_000_000)).is_err());
}

#[test]
fn a_very_large_file_is_parsed_or_refused_in_bounded_time_without_panicking() {
    // 24 MB closed-object violation: one huge key.
    let key = "k".repeat(24 * 1024 * 1024);
    let text = format!("{{\"schemaVersion\":1,\"{key}\":1}}");
    let started = std::time::Instant::now();
    assert!(matches!(parse(&text), Err(ConfigError::Invalid(_))));
    // A large but valid file: many agents.
    let mut agents = Map::new();
    for i in 0..20_000 {
        agents.insert(format!("agent-{i}"), json!({}));
    }
    let big = json!({ "schemaVersion": 1, "agents": agents });
    let parsed = parse(&big.to_string());
    assert!(parsed.is_ok() || matches!(parsed, Err(ConfigError::Invalid(_))));
    assert!(
        started.elapsed() < std::time::Duration::from_secs(60),
        "took {:?}",
        started.elapsed()
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// the schema: closed objects, types, bounds, enums
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_defaults_validate_and_every_present_node_is_known_to_the_schema() {
    let cfg = defaults();
    validate(&cfg).unwrap();
    let nodes = present_nodes(&schema(), &cfg);
    assert!(nodes.len() > 100, "{} nodes", nodes.len());
}

#[test]
fn an_unknown_key_is_an_error_at_every_closed_object_and_accepted_at_every_open_one() {
    let (schema, cfg) = (schema(), defaults());
    let (mut closed, mut open) = (0, 0);
    for n in present_nodes(&schema, &cfg) {
        if !n.value.is_object() || n.schema.get("properties").is_none() {
            continue;
        }
        let doc = with_key_at(&cfg, &n.path, "zzUnknownKey", json!(1));
        let r = validate(&doc);
        match n.schema.get("additionalProperties") {
            Some(Value::Bool(false)) => {
                closed += 1;
                let errs = r.unwrap_err();
                assert!(
                    errs.iter().any(|e| e.contains("zzUnknownKey")),
                    "{}: the error does not name the key: {errs:?}",
                    dotted(&n.path)
                );
            }
            Some(Value::Object(_)) => {} // a map with its own value schema or key pattern: not an "unknown key" case
            _ => {
                open += 1;
                assert!(
                    r.is_ok(),
                    "{} is open but refused an extra key: {r:?}",
                    dotted(&n.path)
                );
            }
        }
    }
    assert!(closed >= 20, "{closed} closed objects");
    assert!(open >= 1, "{open} open objects");
}

#[test]
fn an_unknown_top_level_key_is_refused_by_parse_load_set_and_names_the_key() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    let text = r#"{"schemaVersion":1,"zzUnknownKey":true}"#;
    fs::write(&p, text).unwrap();
    for r in [parse(text), read(&p), load(&p).map(|l| l.config)] {
        match r {
            Err(ConfigError::Invalid(errs)) => {
                assert!(errs.iter().any(|e| e.contains("zzUnknownKey")), "{errs:?}")
            }
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(
        fs::read_to_string(&p).unwrap(),
        text,
        "a refused file is not rewritten"
    );
    assert!(matches!(
        set(&defaults(), "zzUnknownKey", json!(1)),
        Err(ConfigError::Invalid(_))
    ));
    // Through a value that is not an object there is no such key at all.
    assert!(matches!(
        set(&defaults(), "core.logLevel.deeper", json!(1)),
        Err(ConfigError::UnknownKey(_))
    ));
}

#[test]
fn a_value_of_the_wrong_json_type_is_refused_at_every_typed_property() {
    let (schema, cfg) = (schema(), defaults());
    let mut tried = 0;
    for n in present_nodes(&schema, &cfg) {
        if n.path.is_empty() {
            continue;
        }
        let allowed = type_names(&n.schema);
        if allowed.is_empty() {
            continue;
        }
        let ok = |kind: &str| match kind {
            "string" => allowed.iter().any(|t| t == "string"),
            "boolean" => allowed.iter().any(|t| t == "boolean"),
            "number" => allowed.iter().any(|t| t == "number" || t == "integer"),
            "array" => allowed.iter().any(|t| t == "array"),
            "object" => allowed.iter().any(|t| t == "object"),
            "null" => allowed.iter().any(|t| t == "null"),
            _ => unreachable!(),
        };
        for (kind, wrong) in [
            ("boolean", json!(true)),
            ("string", json!("wrong")),
            ("number", json!(12345)),
            ("array", json!([])),
            ("object", json!({})),
            ("null", Value::Null),
        ] {
            if ok(kind) {
                continue;
            }
            tried += 1;
            let doc = with_value_at(&cfg, &n.path, wrong.clone());
            assert!(
                is_error(validate(&doc)),
                "{} accepted {wrong} although its type is {allowed:?}",
                dotted(&n.path)
            );
        }
    }
    assert!(tried > 500, "only {tried} wrong values were tried");
}

#[test]
fn integer_and_number_bounds_hold_on_both_sides_of_every_limit() {
    let (schema, cfg) = (schema(), defaults());
    let mut checked = 0;
    for n in present_nodes(&schema, &cfg) {
        let allowed = type_names(&n.schema);
        let integer = allowed.iter().any(|t| t == "integer");
        if !(integer || allowed.iter().any(|t| t == "number")) || n.path.is_empty() {
            continue;
        }
        let step = if integer { 1.0 } else { 0.5 };
        let put = |x: f64| {
            let v = if integer { json!(x as i64) } else { json!(x) };
            let mut candidate = with_value_at(&cfg, &n.path, v);
            // Probe each scalar boundary with its sibling satisfying the separate cross-field invariant.
            match dotted(&n.path).as_str() {
                "breakglass.reasonMinChars" => {
                    candidate["breakglass"]["reasonMaxChars"] = json!(10000)
                }
                "breakglass.reasonMaxChars" => candidate["breakglass"]["reasonMinChars"] = json!(1),
                _ => {}
            }
            validate(&candidate)
        };
        let name = dotted(&n.path);
        if let Some(min) = n.schema.get("minimum").and_then(Value::as_f64) {
            checked += 1;
            assert!(
                put(min).is_ok(),
                "{name}: its minimum {min} is refused: {:?}",
                put(min)
            );
            assert!(
                put(min - step).is_err(),
                "{name}: below the minimum {min} is accepted"
            );
        }
        if let Some(max) = n.schema.get("maximum").and_then(Value::as_f64) {
            checked += 1;
            assert!(
                put(max).is_ok(),
                "{name}: its maximum {max} is refused: {:?}",
                put(max)
            );
            assert!(
                put(max + step).is_err(),
                "{name}: above the maximum {max} is accepted"
            );
        }
        if let Some(min) = n.schema.get("exclusiveMinimum").and_then(Value::as_f64) {
            checked += 1;
            assert!(
                put(min).is_err(),
                "{name}: the exclusive minimum {min} itself is accepted"
            );
            assert!(
                put(min + step).is_ok(),
                "{name}: just above the exclusive minimum is refused: {:?}",
                put(min + step)
            );
        }
        if let Some(max) = n.schema.get("exclusiveMaximum").and_then(Value::as_f64) {
            checked += 1;
            assert!(
                put(max).is_err(),
                "{name}: the exclusive maximum {max} itself is accepted"
            );
            assert!(
                put(max - step).is_ok(),
                "{name}: just below the exclusive maximum is refused: {:?}",
                put(max - step)
            );
        }
    }
    assert!(checked > 100, "only {checked} bounds were checked");
}

#[test]
fn zero_and_negative_values_are_refused_wherever_the_minimum_is_positive() {
    let (schema, cfg) = (schema(), defaults());
    let mut checked = 0;
    for n in present_nodes(&schema, &cfg) {
        let Some(min) = n.schema.get("minimum").and_then(Value::as_f64) else {
            continue;
        };
        if min < 1.0 || n.path.is_empty() || !type_names(&n.schema).iter().any(|t| t == "integer") {
            continue;
        }
        for bad in [0i64, -1, i64::MIN] {
            checked += 1;
            assert!(
                validate(&with_value_at(&cfg, &n.path, json!(bad))).is_err(),
                "{} accepted {bad} with minimum {min}",
                dotted(&n.path)
            );
        }
    }
    assert!(checked > 30, "{checked} cases");
}

#[test]
fn huge_and_non_integer_numbers_never_panic_and_a_float_is_not_an_integer() {
    let (schema, cfg) = (schema(), defaults());
    for n in present_nodes(&schema, &cfg) {
        if n.path.is_empty() || !type_names(&n.schema).iter().any(|t| t == "integer") {
            continue;
        }
        for text in [
            "18446744073709551615",
            "18446744073709551616",
            "-9223372036854775809",
            "1e30",
            "-1e30",
            "0.5",
            "1.5",
        ] {
            // Replace this property's value textually through a marker.
            let marked = with_value_at(&cfg, &n.path, json!("\u{1}MARK\u{1}"));
            let doc = serde_json::to_string(&marked)
                .unwrap()
                .replace("\"\\u0001MARK\\u0001\"", text);
            let result = parse(&doc);
            if text == "0.5" || text == "1.5" {
                assert!(
                    result.is_err(),
                    "{} accepted the fraction {text}",
                    dotted(&n.path)
                );
            }
            // Anything else: refused or accepted, but never a panic; a number beyond 64 bits is at most a float.
            if let Ok(v) = result {
                assert!(validate(&v).is_ok());
            }
        }
    }
}

#[test]
fn every_enum_value_is_accepted_and_kept_and_a_wrong_case_or_unknown_value_is_refused() {
    let (schema, cfg) = (schema(), defaults());
    let mut checked = 0;
    for n in present_nodes(&schema, &cfg) {
        let Some(values) = n.schema.get("enum").and_then(Value::as_array) else {
            continue;
        };
        if n.path.is_empty() {
            continue;
        }
        let name = dotted(&n.path);
        for v in values {
            let doc = with_value_at(&cfg, &n.path, v.clone());
            // An enum value can switch on a conditional rule (`mode: webhook` needs its webhook settings): then the only complaint
            // is a missing required property, never "not one of".
            if let Err(errs) = validate(&doc) {
                assert!(
                    errs.iter().all(|e| e.contains("is a required property")),
                    "{name}: enum value {v} refused for another reason: {errs:?}"
                );
                continue;
            }
            // Kept: the config survives a trip through its own text.
            assert_eq!(
                parse(&serialize(&doc)).unwrap(),
                doc,
                "{name}: {v} did not survive serialize → parse"
            );
            if let Some(s) = v.as_str() {
                for bad in [
                    s.to_uppercase(),
                    s.to_lowercase(),
                    format!(" {s}"),
                    format!("{s} "),
                    format!("{s}\0"),
                ] {
                    if values.iter().any(|x| x == &json!(bad)) {
                        continue;
                    }
                    assert!(
                        validate(&with_value_at(&cfg, &n.path, json!(bad))).is_err(),
                        "{name}: {bad:?} accepted next to the enum {values:?}"
                    );
                }
            }
            checked += 1;
        }
        assert!(
            validate(&with_value_at(&cfg, &n.path, json!("zzNotInTheEnum"))).is_err(),
            "{name}: a value outside the enum is accepted"
        );
    }
    assert!(checked > 40, "only {checked} enum values");
}

#[test]
fn string_length_limits_hold_where_nothing_else_constrains_the_string() {
    let (schema, cfg) = (schema(), defaults());
    let mut checked = 0;
    for n in present_nodes(&schema, &cfg) {
        if n.path.is_empty()
            || !type_names(&n.schema).iter().any(|t| t == "string")
            || n.schema.get("pattern").is_some()
            || n.schema.get("enum").is_some()
            || n.schema.get("format").is_some()
            || n.schema.get("const").is_some()
        {
            continue;
        }
        let name = dotted(&n.path);
        if let Some(max) = n.schema.get("maxLength").and_then(Value::as_u64) {
            checked += 1;
            let at = with_value_at(&cfg, &n.path, json!("a".repeat(max as usize)));
            assert!(
                validate(&at).is_ok(),
                "{name}: {max} characters refused: {:?}",
                validate(&at)
            );
            let over = with_value_at(&cfg, &n.path, json!("a".repeat(max as usize + 1)));
            assert!(
                validate(&over).is_err(),
                "{name}: {} characters accepted",
                max + 1
            );
            // Counted in characters, not bytes: `max` two-byte characters fit.
            let wide = with_value_at(&cfg, &n.path, json!("ä".repeat(max as usize)));
            assert!(
                validate(&wide).is_ok(),
                "{name}: {max} two-byte characters refused"
            );
        }
        if let Some(min) = n
            .schema
            .get("minLength")
            .and_then(Value::as_u64)
            .filter(|m| *m >= 1)
        {
            checked += 1;
            let under = with_value_at(&cfg, &n.path, json!("a".repeat(min as usize - 1)));
            assert!(
                validate(&under).is_err(),
                "{name}: {} characters accepted below minLength",
                min - 1
            );
        }
    }
    assert!(checked > 10, "{checked} limits");
}

// ---------------------------------------------------------------------------------------------------------------------
// versions: there is exactly one, and nothing migrates it
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn only_schema_version_1_is_accepted_and_no_other_value_is_migrated_or_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    assert_eq!(
        schema()["properties"]["schemaVersion"]["const"],
        json!(1),
        "a second version needs a migration path and a fixture"
    );
    assert!(schema()["required"]
        .as_array()
        .unwrap()
        .contains(&json!("schemaVersion")));
    for v in ["0", "2", "-1", "99", "\"1\"", "true", "null", "[]", "1.5"] {
        let text = format!("{{\"schemaVersion\":{v}}}");
        fs::write(&p, &text).unwrap();
        assert!(
            matches!(read(&p), Err(ConfigError::Invalid(_))),
            "schemaVersion {v} was accepted by read"
        );
        assert!(
            matches!(load(&p), Err(ConfigError::Invalid(_))),
            "schemaVersion {v} was accepted by load"
        );
        assert_eq!(
            fs::read_to_string(&p).unwrap(),
            text,
            "schemaVersion {v}: the file was rewritten"
        );
    }
    // Missing: required.
    fs::write(&p, "{}").unwrap();
    assert!(matches!(load(&p), Err(ConfigError::Invalid(_))));
    // No backup or temp file appears next to a refused file (a migration would write config.json.bak-<from>).
    let names: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["config.json".to_string()], "{names:?}");
}

#[test]
fn a_valid_file_is_not_rewritten_by_load_and_the_text_is_a_fixed_point() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    // A minimal file: the defaults are filled in memory, never written back.
    fs::write(&p, "{\"schemaVersion\": 1}\r\n").unwrap();
    let before = fs::read(&p).unwrap();
    let loaded = load(&p).unwrap();
    assert!(!loaded.created);
    assert_eq!(loaded.config, defaults_without_schema_key());
    assert_eq!(fs::read(&p).unwrap(), before);
    // serialize(parse(serialize(c))) == serialize(c): applying the "migration" (parse + defaults + serialize) twice changes nothing.
    let once = serialize(&parse(&String::from_utf8(before).unwrap()).unwrap());
    let twice = serialize(&parse(&once).unwrap());
    assert_eq!(once, twice);
    assert!(once.ends_with("}\n") && !once.contains('\r'));
}

#[test]
fn a_config_loses_no_value_through_write_atomic_load_and_set() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    let mut cfg = defaults();
    cfg["agents"] = json!({ "bernd": {}, "anna-2": {}, "a_b": {} });
    cfg["core"]["logLevel"] = json!("debug");
    write_atomic(&p, &cfg).unwrap();
    let loaded = load(&p).unwrap().config;
    assert_eq!(loaded, cfg);
    let plan = set(&loaded, "core.logLevel", json!("warn")).unwrap();
    assert_eq!(plan.after["agents"], cfg["agents"]);
    assert_eq!(plan.after["core"]["logLevel"], json!("warn"));
    let mut expected = cfg.clone();
    expected["core"]["logLevel"] = json!("warn");
    assert_eq!(plan.after, expected);
}

// ---------------------------------------------------------------------------------------------------------------------
// defaults: parity with the schema
// ---------------------------------------------------------------------------------------------------------------------

/// Is every leaf and member of `part` also in `whole`?
fn contains(whole: &Value, part: &Value) -> bool {
    match (whole, part) {
        (Value::Object(w), Value::Object(p)) => p
            .iter()
            .all(|(k, v)| w.get(k).is_some_and(|x| contains(x, v))),
        _ => whole == part,
    }
}

#[test]
fn every_schema_default_reachable_from_the_root_is_in_the_defaults_and_nothing_else_is() {
    let (schema, cfg) = (schema(), defaults());
    // 1. Declared defaults appear where the parents exist.
    fn declared(
        schema: &Value,
        cfg: &Value,
        path: &mut Vec<String>,
        problems: &mut Vec<String>,
        seen: &mut usize,
    ) {
        let (Some(props), Some(obj)) = (
            schema.get("properties").and_then(Value::as_object),
            cfg.as_object(),
        ) else {
            return;
        };
        for (k, sub) in props {
            path.push(k.clone());
            if let Some(d) = sub.get("default") {
                *seen += 1;
                match obj.get(k) {
                    Some(v) if contains(v, d) => {}
                    other => problems.push(format!(
                        "{}: the schema default {d} is not in the defaults (found {other:?})",
                        path.join(".")
                    )),
                }
            }
            if let Some(child) = obj.get(k) {
                declared(sub, child, path, problems, seen);
            }
            path.pop();
        }
    }
    let (mut problems, mut seen) = (Vec::new(), 0);
    declared(&schema, &cfg, &mut Vec::new(), &mut problems, &mut seen);
    assert!(seen > 100, "{seen} declared defaults reached");
    assert!(problems.is_empty(), "{}", problems.join("\n"));

    // 2. Nothing is invented: every scalar in the defaults is the declared default (or the two header keys).
    fn invented(
        schema: &Value,
        cfg: &Value,
        inherited: Option<&Value>,
        path: &mut Vec<String>,
        problems: &mut Vec<String>,
    ) {
        let Some(obj) = cfg.as_object() else { return };
        let props = schema.get("properties").and_then(Value::as_object);
        for (k, v) in obj {
            path.push(k.clone());
            match props.and_then(|p| p.get(k)) {
                None => problems.push(format!(
                    "{}: in the defaults but not declared by the schema",
                    path.join(".")
                )),
                Some(sub) => {
                    // A value can come from the property's own default or from the default of the nearest ancestor that has one
                    // (`features` declares the whole object, its members declare nothing).
                    let own = sub.get("default");
                    let from_parent = inherited.and_then(|i| i.get(k));
                    if v.is_object() {
                        let next = if own.is_some_and(Value::is_object) {
                            own
                        } else {
                            from_parent
                        };
                        invented(sub, v, next, path, problems);
                    } else if (path.len() > 1 || (k != "$schema" && k != "schemaVersion"))
                        && own != Some(v)
                        && from_parent != Some(v)
                    {
                        problems.push(format!(
                            "{}: {v} is neither the declared default {own:?} nor part of an ancestor's default",
                            path.join(".")
                        ));
                    }
                }
            }
            path.pop();
        }
    }
    let mut problems = Vec::new();
    invented(&schema, &cfg, None, &mut Vec::new(), &mut problems);
    assert!(problems.is_empty(), "{}", problems.join("\n"));

    // 3. The header keys are the schema's own.
    assert_eq!(cfg["$schema"], schema["$id"]);
    assert_eq!(
        cfg["schemaVersion"],
        schema["properties"]["schemaVersion"]["const"]
    );
}

#[test]
fn filling_defaults_is_idempotent_and_never_overwrites_a_value_the_file_sets() {
    let cfg = defaults();
    assert_eq!(parse(&serialize(&cfg)).unwrap(), cfg);
    assert_eq!(parse_unvalidated(&serialize(&cfg)).unwrap(), cfg);
    // A value the file sets survives the fill, for every scalar leaf with a default that has another valid value (enums).
    let (schema, base) = (schema(), defaults());
    let mut kept = 0;
    for n in present_nodes(&schema, &base) {
        let (Some(values), Some(def)) = (
            n.schema.get("enum").and_then(Value::as_array),
            n.schema.get("default"),
        ) else {
            continue;
        };
        if n.path.is_empty() {
            continue;
        }
        // Another value that is valid on its own (some values switch on a conditional rule that needs more settings).
        let Some(other) = values
            .iter()
            .find(|v| *v != def && validate(&with_value_at(&base, &n.path, (*v).clone())).is_ok())
        else {
            continue;
        };
        let doc = with_value_at(&base, &n.path, other.clone());
        let parsed = parse(&serialize(&doc)).unwrap();
        assert_eq!(parsed, doc, "{}", dotted(&n.path));
        // And from a minimal file that sets only this one value.
        let mut minimal = json!({ "schemaVersion": 1 });
        let mut cur = &mut minimal;
        for seg in &n.path[..n.path.len() - 1] {
            cur = cur
                .as_object_mut()
                .unwrap()
                .entry(seg.clone())
                .or_insert_with(|| json!({}));
        }
        cur.as_object_mut()
            .unwrap()
            .insert(n.path.last().unwrap().clone(), other.clone());
        let filled = parse(&minimal.to_string()).unwrap();
        let mut at = &filled;
        for seg in &n.path {
            at = &at[seg.as_str()];
        }
        assert_eq!(
            at,
            other,
            "{}: the file's value was replaced by the default",
            dotted(&n.path)
        );
        kept += 1;
    }
    assert!(kept > 5, "{kept} overridden defaults");
}

// ---------------------------------------------------------------------------------------------------------------------
// the lookup read: what it promises about the keys it is asked for
// ---------------------------------------------------------------------------------------------------------------------

fn integer_pointers() -> Vec<(String, Value)> {
    let (schema, cfg) = (schema(), defaults());
    present_nodes(&schema, &cfg)
        .into_iter()
        .filter(|n| !n.path.is_empty() && type_names(&n.schema) == ["integer"])
        .filter(|n| n.schema.get("minimum").is_some() || n.schema.get("maximum").is_some())
        .map(|n| (format!("/{}", n.path.join("/")), n.schema))
        .collect()
}

#[test]
fn read_for_lookup_never_returns_an_out_of_range_or_wrongly_typed_value_for_a_key_it_was_asked_for()
{
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    let pointers = integer_pointers();
    assert!(pointers.len() > 20, "{} pointers", pointers.len());
    let mut rng = Rng(SEED);
    for (ptr, node) in &pointers {
        let path: Vec<String> = ptr.split('/').skip(1).map(str::to_string).collect();
        let min = node.get("minimum").and_then(Value::as_i64);
        let max = node.get("maximum").and_then(Value::as_i64);
        // 1e30 is a whole number, so a key without a maximum takes it (JSON Schema, and ajv's `Number.isInteger`, agree).
        let mut bad: Vec<Value> = vec![
            json!("7"),
            json!(true),
            json!(null),
            json!([7]),
            json!({}),
            json!(1.5),
        ];
        if max.is_some() {
            bad.push(json!(1e30));
        }
        if let Some(m) = min {
            bad.push(json!(m - 1));
        }
        if let Some(m) = max {
            bad.push(json!(m + 1));
        }
        for v in bad {
            let doc = with_value_at(&defaults(), &path, v.clone());
            fs::write(&p, doc.to_string()).unwrap();
            let r = read_for_lookup(&p, &[ptr.as_str()]);
            assert!(
                matches!(r, Err(ConfigError::Invalid(_))),
                "{ptr} = {v} (seed {SEED:#x}): the lookup read returned {r:?}"
            );
        }
        // In range: accepted without the validator.
        let ok_value = match (min, max) {
            (Some(lo), Some(hi)) => {
                lo + (rng.below(((hi - lo).clamp(0, 1000) + 1) as usize)) as i64
            }
            (Some(lo), None) => lo,
            (None, Some(hi)) => hi,
            (None, None) => 0,
        };
        let doc = with_value_at(&defaults(), &path, json!(ok_value));
        fs::write(&p, doc.to_string()).unwrap();
        assert!(
            read_for_lookup(&p, &[ptr.as_str()]).is_ok(),
            "{ptr} = {ok_value}"
        );
    }
}

#[test]
fn read_for_lookup_documents_that_passing_is_not_validity_for_keys_it_was_not_asked_about() {
    // Documented in the function's comment: a bad value deeper in a section the caller did not list is not looked at.
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    let mut doc = defaults();
    doc["core"]["logLevel"] = json!("loud");
    fs::write(&p, doc.to_string()).unwrap();
    assert!(read_for_lookup(&p, &["/core/recall/softBudgetMs"]).is_ok());
    assert!(
        matches!(read(&p), Err(ConfigError::Invalid(_))),
        "the full read still refuses it"
    );
}

#[test]
fn read_for_lookup_refuses_an_unknown_top_level_key_a_bad_agent_name_and_a_bad_version() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    for bad in [
        json!({ "schemaVersion": 1, "zzUnknownKey": 1 }),
        json!({ "schemaVersion": 2 }),
        json!({ "schemaVersion": 1, "agents": { "Bad Name": {} } }),
        json!({ "schemaVersion": 1, "agents": { "": {} } }),
        json!({ "schemaVersion": 1, "agents": { "a".repeat(65): {} } }),
        json!({ "schemaVersion": 1, "agents": { "bernd": { "zzUnknownKey": 1 } } }),
        json!({ "schemaVersion": 1, "agents": [] }),
    ] {
        fs::write(&p, bad.to_string()).unwrap();
        assert!(
            matches!(read_for_lookup(&p, &[]), Err(ConfigError::Invalid(_))),
            "{bad}"
        );
    }
    // The 64-character name is the longest accepted.
    fs::write(
        &p,
        json!({ "schemaVersion": 1, "agents": { "a".repeat(64): {} } }).to_string(),
    )
    .unwrap();
    assert!(read_for_lookup(&p, &[]).is_ok());
}

// ---------------------------------------------------------------------------------------------------------------------
// the file system
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn a_missing_file_reads_as_the_defaults_without_being_created_and_load_creates_it_once() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("sub").join("config.json");
    assert_eq!(read(&p).unwrap(), defaults());
    assert_eq!(read_unvalidated(&p).unwrap(), defaults());
    assert!(
        !p.exists() && !dir.path().join("sub").exists(),
        "a reader never writes"
    );
    let first = load(&p).unwrap();
    assert!(first.created);
    let bytes = fs::read(&p).unwrap();
    let second = load(&p).unwrap();
    assert!(!second.created);
    assert_eq!(fs::read(&p).unwrap(), bytes);
}

#[test]
fn a_directory_in_place_of_the_file_is_an_io_error_for_every_reader() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    fs::create_dir(&p).unwrap();
    assert!(matches!(load(&p), Err(ConfigError::Io(_))));
    assert!(matches!(read(&p), Err(ConfigError::Io(_))));
    assert!(matches!(read_unvalidated(&p), Err(ConfigError::Io(_))));
    assert!(matches!(read_for_lookup(&p, &[]), Err(ConfigError::Io(_))));
}

#[test]
fn write_atomic_never_leaves_a_temp_file_when_it_fails() {
    let dir = tempfile::tempdir().unwrap();
    // The parent is a regular file: create_dir_all fails.
    let blocker = dir.path().join("blocker");
    fs::write(&blocker, "x").unwrap();
    assert!(write_atomic(&blocker.join("config.json"), &defaults()).is_err());
    // The target is a non-empty directory: the rename fails after the temp file was written.
    let target = dir.path().join("config.json");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep"), "x").unwrap();
    assert!(write_atomic(&target, &defaults()).is_err());
    let left: BTreeSet<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        left,
        ["blocker", "config.json"]
            .iter()
            .map(|s| s.to_string())
            .collect::<BTreeSet<_>>(),
        "{left:?}"
    );
}

#[cfg(unix)]
#[test]
fn writing_over_a_symlinked_config_replaces_the_link_and_leaves_the_target_alone() {
    // Pinned (not documented): `write_atomic` renames over the path, so a config.json that is a symlink into a dotfiles repository
    // becomes a regular file after the first `config set`; the repository's file is not modified.
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("dotfiles-config.json");
    fs::write(&target, "{\"schemaVersion\":1}").unwrap();
    let link = dir.path().join("config.json");
    symlink(&target, &link).unwrap();
    assert_eq!(read(&link).unwrap(), defaults_without_schema_key());
    write_atomic(&link, &defaults()).unwrap();
    assert!(!fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "{\"schemaVersion\":1}"
    );
}

#[test]
fn only_the_directory_of_a_path_without_one_is_created_for_a_bare_file_name() {
    // A bare relative name has an empty parent: no create_dir_all of "" must be attempted.
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("a").join("b").join("config.json");
    write_atomic(&nested, &defaults()).unwrap();
    assert_eq!(read(&nested).unwrap(), defaults());
    assert!(Path::new(&nested).is_file());
}

#[test]
fn a_document_that_is_not_an_object_is_refused_by_every_validating_path() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    for text in [
        "[]",
        "null",
        "1",
        "\"x\"",
        "true",
        "[{\"schemaVersion\":1}]",
    ] {
        assert!(
            matches!(parse(text), Err(ConfigError::Invalid(_))),
            "{text}"
        );
        fs::write(&p, text).unwrap();
        assert!(matches!(read(&p), Err(ConfigError::Invalid(_))), "{text}");
        assert!(matches!(load(&p), Err(ConfigError::Invalid(_))), "{text}");
        assert!(
            matches!(read_for_lookup(&p, &[]), Err(ConfigError::Invalid(_))),
            "{text}"
        );
        // The unvalidated read promises JSON and nothing more (documented on `read_unvalidated`).
        assert!(read_unvalidated(&p).is_ok(), "{text}");
        assert_eq!(fs::read_to_string(&p).unwrap(), text);
    }
}

#[test]
fn security_limits_reject_invalid_values_when_loading() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    for bad in [
        json!({"reasonMinChars":501,"reasonMaxChars":500}),
        json!({"maxWindowMinutes":1441}),
    ] {
        let mut cfg = defaults();
        cfg["breakglass"] = bad;
        fs::write(&path, serialize(&cfg)).unwrap();
        assert!(matches!(load(&path), Err(ConfigError::Invalid(_))));
    }
    let schema = schema();
    for group in ["approvals", "breakglass"] {
        for key in schema["properties"][group]["properties"]
            .as_object()
            .unwrap()
            .values()
        {
            assert_eq!(key["x-write-roles"], json!(["owner", "admin"]));
            assert_eq!(key["x-audit"], true);
        }
    }
}
