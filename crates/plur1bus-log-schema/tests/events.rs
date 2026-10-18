//! Every event the catalogue registers, written as the line a logger would write and validated against the published schemas,
//! with the same record mutated at each place a rule looks; and the redaction data that `tests/parity.rs` does not reach.
//!
//! The crate has no logger and no redactor ("data only", `src/lib.rs`), so what is tested is the catalogue, the two record
//! schemas, the validators and the redaction data. A key-name check in this file applies the `key` rule's two regular expressions
//! the way the data's own description says to; it is a test of the data, not a second redactor.
use plur1bus_log_schema::{
    attrs_schema_for, audit_key_order, catalogue, key_order, limits, lookup_event, redaction,
    validate_audit_line, validate_line, Code, Entry, Level,
};
use serde_json::{json, Value};

const SEED: u64 = 0x6c6f_6773_6368_656d;

/// Hard timeout for every test (the work is milliseconds; a hang fails with a name).
fn within<F: FnOnce() + Send + 'static>(f: F) {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        f();
        let _ = tx.send(());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(120)) {
        Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            handle.join().expect("test body panicked")
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => panic!("test exceeded 120 s"),
    }
}

/// The line as written: keys in the schema's `x-key-order` (serde_json's `Value` would sort them, which the validator refuses).
fn written(v: &Value, audit: bool) -> String {
    let order = if audit {
        audit_key_order()
    } else {
        key_order()
    };
    let o = v.as_object().unwrap();
    let parts: Vec<String> = order
        .iter()
        .filter_map(|k| o.get(*k).map(|x| format!("{}:{}", json!(k), x)))
        .collect();
    format!("{{{}}}", parts.join(","))
}

fn check(v: &Value, audit: bool) -> Result<&'static Entry, plur1bus_log_schema::Invalid> {
    let line = written(v, audit);
    if audit {
        validate_audit_line(&line)
    } else {
        validate_line(&line)
    }
}

fn verdict(v: &Value, audit: bool) -> &'static str {
    match check(v, audit) {
        Ok(_) => "ok",
        Err(e) => e.code.as_str(),
    }
}

/// Every example of every catalogue event, with the entry it belongs to.
fn examples() -> Vec<(&'static Entry, Value)> {
    catalogue()
        .events
        .iter()
        .flat_map(|e| e.examples.iter().map(move |x| (e, x.clone())))
        .collect()
}

/// The attribute object of a record: `attrs` for a diagnostic or payload record, `detail` for an audit one.
fn attrs_key(e: &Entry) -> &'static str {
    if e.is_audit() {
        "detail"
    } else {
        "attrs"
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// every event, as written
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn every_example_of_every_event_validates_as_the_line_a_logger_writes_and_the_line_is_byte_stable()
{
    within(|| {
        let all = examples();
        assert!(all.len() >= 135, "{} examples", all.len());
        for (e, ex) in &all {
            let audit = e.is_audit();
            let line = written(ex, audit);
            assert!(
                line.len() <= limits().line_bytes,
                "{}: {} bytes",
                e.event,
                line.len()
            );
            let found = if audit {
                validate_audit_line(&line)
            } else {
                validate_line(&line)
            };
            let found = found.unwrap_or_else(|err| panic!("{}: {err:?}\n{line}", e.event));
            assert_eq!(
                found.event, e.event,
                "{}: the line resolved to another entry",
                e.event
            );
            // Written again after parsing: the same bytes.
            let again = written(&serde_json::from_str::<Value>(&line).unwrap(), audit);
            assert_eq!(again, line, "{}", e.event);
        }
    });
}

#[test]
fn a_line_written_with_sorted_keys_is_refused_so_a_writer_must_not_go_through_a_value() {
    within(|| {
        let mut refused = 0;
        for (e, ex) in examples().into_iter().filter(|(e, _)| !e.is_audit()) {
            let sorted = serde_json::to_string(&ex).unwrap(); // serde_json's map sorts keys
            let order = key_order();
            let keys: Vec<&str> = ex.as_object().unwrap().keys().map(String::as_str).collect();
            let in_written_order = {
                let pos = |k: &&str| order.iter().position(|o| o == k).unwrap();
                keys.windows(2).all(|w| pos(&w[0]) < pos(&w[1]))
            };
            let r = validate_line(&sorted);
            if in_written_order {
                assert!(
                    r.is_ok(),
                    "{}: sorted order happens to be the written order",
                    e.event
                );
            } else {
                refused += 1;
                assert_eq!(r.unwrap_err().code, Code::KeyOrder, "{}", e.event);
            }
        }
        assert!(refused > 50, "{refused} sorted lines refused");
    });
}

#[test]
fn a_diagnostic_event_is_valid_at_each_level_it_allows_and_refused_at_every_other() {
    within(|| {
        let mut checked = 0;
        for (e, ex) in examples().into_iter().filter(|(e, _)| !e.is_audit()) {
            let Some(allowed) = e.levels.as_ref() else {
                continue;
            };
            for level in Level::ALL {
                let mut r = ex.clone();
                r["level"] = json!(level.as_str());
                checked += 1;
                let v = verdict(&r, false);
                if allowed.iter().any(|a| a == level.as_str()) {
                    assert_eq!(v, "ok", "{} at {}", e.event, level.as_str());
                } else {
                    assert_eq!(v, "level_not_allowed", "{} at {}", e.event, level.as_str());
                }
            }
        }
        assert!(checked > 500, "{checked}");
    });
}

#[test]
fn a_level_that_is_not_a_level_is_refused_for_every_event() {
    within(|| {
        for (e, ex) in examples().into_iter().filter(|(e, _)| !e.is_audit()) {
            for bad in [
                json!("INFO"),
                json!("Info"),
                json!("warning"),
                json!("verbose"),
                json!(""),
                json!(30),
                json!(null),
                json!(["info"]),
            ] {
                let mut r = ex.clone();
                r["level"] = bad.clone();
                let v = verdict(&r, false);
                assert_ne!(v, "ok", "{} accepted level {bad}", e.event);
            }
        }
    });
}

#[test]
fn a_record_on_the_other_stream_or_the_other_validator_is_refused_for_every_event() {
    within(|| {
        for (e, ex) in examples() {
            if e.is_audit() {
                // An audit line is not a diagnostic record.
                assert!(validate_line(&written(&ex, true)).is_err(), "{}", e.event);
                continue;
            }
            assert!(
                validate_audit_line(&written(&ex, false)).is_err(),
                "{}",
                e.event
            );
            let mut r = ex.clone();
            let other = if e.stream == "payload" {
                "diagnostic"
            } else {
                "payload"
            };
            r["stream"] = json!(other);
            assert_ne!(
                verdict(&r, false),
                "ok",
                "{} accepted on the {other} stream",
                e.event
            );
        }
    });
}

#[test]
fn an_event_name_with_the_wrong_case_or_a_neighbouring_name_is_not_registered() {
    within(|| {
        for (e, ex) in examples()
            .into_iter()
            .filter(|(e, _)| !e.is_audit() && !e.family)
        {
            for bad in [
                e.event.to_uppercase(),
                format!("{}.", e.event),
                format!(" {}", e.event),
                format!("{}x", e.event),
                e.event.replace('.', "_"),
            ] {
                if lookup_event(&bad).is_some() {
                    continue; // a family prefix can register it; the family test covers that
                }
                let mut r = ex.clone();
                r["event"] = json!(bad);
                assert_eq!(verdict(&r, false), "unknown_event", "{} → {bad:?}", e.event);
            }
        }
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// attrs, event by event
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn removing_any_required_attr_is_refused_for_every_event() {
    within(|| {
        let mut checked = 0;
        for (e, ex) in examples() {
            let key = attrs_key(e);
            for req in &e.required_attrs {
                let mut r = ex.clone();
                if r[key].as_object_mut().and_then(|o| o.remove(req)).is_none() {
                    continue; // a required attr that this example puts elsewhere (a common attr at the top level)
                }
                checked += 1;
                assert_ne!(
                    verdict(&r, e.is_audit()),
                    "ok",
                    "{} accepted without {req}",
                    e.event
                );
            }
        }
        assert!(checked > 100, "{checked}");
    });
}

#[test]
fn an_unknown_attr_is_refused_where_the_group_is_closed_and_kept_where_it_is_open() {
    within(|| {
        let (mut closed, mut open) = (0, 0);
        for (e, ex) in examples() {
            let key = attrs_key(e);
            let is_open = catalogue().attr_groups[&e.attrs].open;
            let mut r = ex.clone();
            r[key]
                .as_object_mut()
                .unwrap()
                .insert("zzUnknownAttr".into(), json!(1));
            let v = verdict(&r, e.is_audit());
            if is_open {
                open += 1;
                assert_eq!(v, "ok", "{}: an open group refused an extra attr", e.event);
            } else {
                closed += 1;
                assert_ne!(
                    v, "ok",
                    "{}: a closed group accepted an unknown attr",
                    e.event
                );
            }
        }
        assert!(closed > 100 && open >= 1, "{closed} closed, {open} open");
    });
}

#[test]
fn an_attr_of_the_wrong_json_type_is_refused_wherever_the_schema_names_a_type() {
    within(|| {
        let mut checked = 0;
        for (e, ex) in examples() {
            let key = attrs_key(e);
            let schema = attrs_schema_for(e);
            let props = schema["properties"].as_object().unwrap();
            for (name, value) in ex[key].as_object().unwrap().clone() {
                let Some(def) = props.get(&name) else {
                    continue;
                };
                let allowed: Vec<&str> = match &def["type"] {
                    Value::String(s) => vec![s.as_str()],
                    Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
                    _ => continue,
                };
                let _ = value;
                let ok = |kind: &str| match kind {
                    "string" => allowed.contains(&"string"),
                    "boolean" => allowed.contains(&"boolean"),
                    "number" => allowed.contains(&"number") || allowed.contains(&"integer"),
                    "array" => allowed.contains(&"array"),
                    "object" => allowed.contains(&"object"),
                    "null" => allowed.contains(&"null"),
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
                    let mut r = ex.clone();
                    r[key][&name] = wrong.clone();
                    checked += 1;
                    assert_ne!(
                        verdict(&r, e.is_audit()),
                        "ok",
                        "{}: {name} = {wrong} was accepted (type {allowed:?})",
                        e.event
                    );
                }
            }
        }
        assert!(checked > 1000, "{checked}");
    });
}

#[test]
fn attrs_over_the_byte_limit_and_a_msg_over_its_limit_are_refused() {
    within(|| {
        let lim = limits();
        for (e, ex) in examples()
            .into_iter()
            .filter(|(e, _)| !e.is_audit())
            .take(40)
        {
            let mut r = ex.clone();
            r["msg"] = json!("m".repeat(lim.msg_bytes + 1));
            assert_eq!(verdict(&r, false), "msg_too_long", "{}", e.event);
            let mut r = ex.clone();
            r["attrs"]["zzPad"] = json!("p".repeat(lim.attrs_bytes + 1));
            assert_ne!(verdict(&r, false), "ok", "{}", e.event);
        }
    });
}

#[test]
fn the_family_entries_register_every_name_under_their_prefix_and_no_other() {
    within(|| {
        let families: Vec<&Entry> = catalogue().events.iter().filter(|e| e.family).collect();
        assert!(!families.is_empty());
        for f in families {
            let prefix = f.event.trim_end_matches(".*");
            for tail in ["a", "run.permissions.fix", "x-y.z0", "d.e.f"] {
                let name = format!("{prefix}.{tail}");
                assert_eq!(
                    lookup_event(&name).map(|e| e.event.as_str()),
                    Some(f.event.as_str()),
                    "{name}"
                );
            }
            for bad in [
                prefix.to_string(),
                format!("{prefix}."),
                format!("{prefix}..a"),
                format!("{prefix}.A"),
                format!("{prefix}x.a"),
                format!("x{prefix}.a"),
                format!("{prefix}.a b"),
                // The name rule allows at most four segments in all.
                format!("{prefix}.a.b.c.d"),
                format!("{prefix}.a\n"),
            ] {
                let hit = lookup_event(&bad).map(|e| e.event.as_str());
                assert_ne!(
                    hit,
                    Some(f.event.as_str()),
                    "{bad:?} is registered by {}",
                    f.event
                );
            }
        }
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// redaction data: the key rule
// ---------------------------------------------------------------------------------------------------------------------

/// The `key` rule (§4 rule 2) as its description defines it: a name matches when a delimited segment is a listed word
/// (`pattern`, case-insensitive) or, for camelCase names, when it contains the word as a capitalised part (`camelPattern`).
fn key_is_sensitive(name: &str) -> bool {
    let rule = redaction()["rules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "key")
        .expect("the key rule");
    let plain = regex::Regex::new(&format!("(?i){}", rule["pattern"].as_str().unwrap()))
        .expect("key pattern");
    let camel =
        regex::Regex::new(rule["camelPattern"].as_str().unwrap()).expect("key camelPattern");
    plain.is_match(name) || camel.is_match(name)
}

#[test]
fn the_key_rule_matches_credential_names_in_every_common_spelling_and_not_token_counts() {
    for name in [
        "authorization",
        "Authorization",
        "AUTHORIZATION",
        "proxy-authorization",
        "cookie",
        "Set-Cookie",
        "token",
        "Token",
        "access_token",
        "accessToken",
        "id_token_hint",
        "refresh_token",
        "refreshToken",
        "refresh",
        "password",
        "passwd",
        "user.password",
        "api_key",
        "apiKey",
        "api-key",
        "x-api-key",
        "apikey",
        "client_secret",
        "clientSecret",
        "secret",
        "code_verifier",
        "ticket",
        "csrf",
        "private_key",
        "privateKey",
        "session_key",
        "sessionKey",
        "botTokenSecret",
        "passwordSecret",
        "x-csrf-token",
    ] {
        assert!(
            key_is_sensitive(name),
            "{name} should be redacted by key name"
        );
    }
    for name in [
        "input_tokens",
        "output_tokens",
        "outputTokens",
        "inputTokens",
        "max_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "tokens",
        "tokenizer",
        "secretary",
        "ttft_ms",
        "keyboard",
        "monkey",
        "agent",
        "session",
        "code",
        "bearer",
        "authors",
        "duration_ms",
        "trace_id",
        "span_id",
        "principal",
    ] {
        assert!(
            !key_is_sensitive(name),
            "{name} is not a credential and must not be redacted by key name"
        );
    }
}

#[test]
fn the_redaction_rules_run_in_the_documented_order_and_every_pattern_compiles() {
    let r = redaction();
    let order: Vec<&str> = r["order"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(order, ["secret", "key", "pattern", "url", "path", "pii"]);
    let ids: Vec<&str> = r["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, order, "the rules are listed in the order they apply");
    assert!(r["replacementTemplate"]
        .as_str()
        .unwrap()
        .contains("{rule}"));
    // The key rule's two expressions are not covered by `rule_patterns` (they are not in a `patterns` list).
    let _ = key_is_sensitive("x");
}

#[test]
fn nothing_the_catalogue_writes_under_a_credential_name_or_description_is_unclassified() {
    // A ratchet: an attr whose name the key rule matches would be redacted by name; an attr that merely *talks about* secrets or
    // tokens in its description must be one of the known non-credentials below. A new one fails until someone classifies it.
    const NOT_CREDENTIALS: &[(&str, &str)] = &[
        ("provider_request.input_tokens", "a token count"),
        ("provider_request.output_tokens", "a token count"),
        ("provider_request.cache_read_tokens", "a token count"),
        ("provider_request.cache_write_tokens", "a token count"),
        (
            "provider_request.ttft_ms",
            "time to first token, a duration",
        ),
        (
            "audit_ext_remove.secrets",
            "the slots a purge deleted (names), never values",
        ),
        (
            "audit_secret.name",
            "the secret's name, \"never the value\" (the group's own description)",
        ),
    ];
    let words = regex::Regex::new(r"(?i)secret|token|password|credential|api.?key|private.?key|cookie|authoriz|bearer|passphrase").unwrap();
    let c = catalogue();
    let mut found: Vec<String> = Vec::new();
    let mut scan = |prefix: &str, props: &serde_json::Map<String, Value>| {
        for (k, v) in props {
            let desc = v["description"].as_str().unwrap_or("");
            if key_is_sensitive(k) {
                found.push(format!("{prefix}{k} (redacted by key name)"));
            } else if words.is_match(k) || words.is_match(desc) {
                found.push(format!("{prefix}{k}"));
            }
        }
    };
    scan("common.", &c.common_attrs);
    for (g, grp) in &c.attr_groups {
        scan(&format!("{g}."), &grp.properties);
    }
    found.sort();
    let unknown: Vec<&String> = found
        .iter()
        .filter(|f| !NOT_CREDENTIALS.iter().any(|(n, _)| f.as_str() == *n))
        .collect();
    assert!(
        unknown.is_empty(),
        "attrs that mention credentials and are not classified: {unknown:?}"
    );
    for (n, why) in NOT_CREDENTIALS {
        assert!(
            found.iter().any(|f| f == n),
            "{n} ({why}) no longer exists or no longer matches; remove it from the list"
        );
    }
}

#[test]
fn a_marker_under_a_credential_name_is_found_by_the_key_rule_in_every_serialised_shape() {
    // A marker, not a token-shaped literal. The shapes a log line carries a named value in: a JSON member, key=value, a header.
    let marker = "redact-probe-alpha";
    let mut rng = Rng(SEED);
    let names = [
        "token",
        "apiKey",
        "api_key",
        "password",
        "client_secret",
        "Authorization",
        "cookie",
        "refresh_token",
        "x-api-key",
    ];
    for _ in 0..200 {
        let name = names[rng.below(names.len())];
        let shapes = [
            format!("{{\"{name}\":\"{marker}\"}}"),
            format!("{name}={marker}"),
            format!("{name}: {marker}"),
            format!("{{\"outer\":{{\"{name}\":\"{marker}\"}}}}"),
        ];
        for s in shapes {
            let names_in_text: Vec<&str> = s
                .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-'))
                .filter(|w| !w.is_empty() && *w != marker && *w != "outer")
                .collect();
            assert!(
                names_in_text.iter().any(|n| key_is_sensitive(n)),
                "seed {SEED:#x}: no sensitive key name found in {s}"
            );
        }
    }
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
// the harness config schema and the redaction the catalogue promises for its values
// ---------------------------------------------------------------------------------------------------------------------

/// Every property of `config.schema.json` (dotted path, node) whose name the key rule would redact.
fn credential_named_config_properties() -> Vec<(String, Value)> {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../packages/config-schema/schema/config.schema.json"
    ))
    .unwrap();
    fn walk(node: &Value, path: &str, out: &mut Vec<(String, Value)>) {
        if let Some(props) = node.get("properties").and_then(Value::as_object) {
            for (k, v) in props {
                let p = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                if key_is_sensitive(k) {
                    out.push((p.clone(), v.clone()));
                }
                walk(v, &p, out);
            }
        }
        for key in ["additionalProperties", "items", "then"] {
            if node[key].is_object() {
                walk(&node[key], &format!("{path}.*"), out);
            }
        }
        for key in ["allOf", "anyOf", "oneOf"] {
            for sub in node[key].as_array().into_iter().flatten() {
                walk(sub, path, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(&schema, "", &mut out);
    out
}

#[test]
fn the_config_properties_that_only_name_a_secret_say_so_and_the_one_that_holds_a_value_is_known() {
    // Eight properties are references ("Name of the secret holding …"): the value lives in the secret store, never in config.json.
    let found = credential_named_config_properties();
    let (refs, values): (Vec<_>, Vec<_>) = found.iter().partition(|(_, n)| {
        n["description"]
            .as_str()
            .unwrap_or("")
            .starts_with("Name of the secret")
    });
    assert_eq!(refs.len(), 8, "{refs:?}");
    let value_paths: Vec<&str> = values.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(
        value_paths,
        ["channels.telegram.webhook.secret"],
        "a new credential-named config property holds a value: classify it"
    );
}

/// KNOWN GAP (SICHERHEIT, latent): `audit.config.set` carries `old` and `new` as "any JSON, redacted when x-sensitive"
/// (`audit_config_set` in the catalogue), but `config.schema.json` has no `x-sensitive` annotation at all (the first-aid bundle
/// says so too, `firstaid_bundle/mod.rs`). `channels.telegram.webhook.secret` is a value kept in `config.json` itself, so a writer
/// that follows the catalogue has nothing to tell it to redact that value. No emitter of `audit.config.set` exists in the Rust
/// sources today, which is why this is latent. Adding the annotation changes the config schema, which this change does not touch.
#[test]
#[ignore = "KNOWN GAP (SICHERHEIT, latent): config.schema.json has no x-sensitive, so audit.config.set cannot redact channels.telegram.webhook.secret"]
fn every_config_property_that_holds_a_secret_value_is_marked_x_sensitive() {
    let unmarked: Vec<String> = credential_named_config_properties()
        .into_iter()
        .filter(|(_, n)| {
            !n["description"]
                .as_str()
                .unwrap_or("")
                .starts_with("Name of the secret")
        })
        .filter(|(_, n)| n["x-sensitive"] != json!(true))
        .map(|(p, _)| p)
        .collect();
    assert!(
        unmarked.is_empty(),
        "config properties that hold a secret value and are not x-sensitive: {unmarked:?}"
    );
}
