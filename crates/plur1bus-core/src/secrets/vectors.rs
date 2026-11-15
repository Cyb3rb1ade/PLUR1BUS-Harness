//! Replay of the parity vectors recorded from the TypeScript secret store (`scripts/parity/export-secrets.ts`,
//! `fixtures/parity/secrets/*.json`). Vectors are recorded, never edited by hand.
//!
//! An input string is a spec: a JSON string, `{"u16": [units]}`, `{"rep": [spec, n]}` or `{"cat": [spec, ...]}`; an absent input
//! is `{"undefined": true}`; any other JSON value is a non-string input. A result is `{"ok": ..}`, `{"err": {code, message,
//! detail}}` or `{"throw": "RangeError"}` (an invalid time value). A failing file reports how many cases differ and the first few.
use super::audit::{
    actor_user_units, detail_to_json, sanitize_detail, AuditAction, DetailValue, DETAIL_KEYS,
};
use super::backend::{compare_names, SecretBackend};
use super::error::{SecretError, SecretErrorCode};
use super::leases::{IssueOptions, LeaseTable, DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS};
use super::memory_backend::MemoryBackend;
use super::types::{
    backend_failure, check_description_units, check_name_units, check_value_units,
    is_secret_name_units, next_description, short_value_warning_units, utf8_len_units,
    BackendCause, BackendKind, SecretPrincipal, MAX_DESCRIPTION_CHARS, MAX_VALUE_BYTES,
    MIN_DESCRIPTION_VALUE_CHARS, MIN_REDACTED_VALUE_CHARS, MIN_SECRET_SURFACE,
};
use crate::identity::codes::RandomSource;
use crate::js::utf16;
use crate::rbac::surface::SurfaceTrustLevel;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/secrets/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The code units of a string spec; `None` when the value is not one.
fn spec_units(v: &Value) -> Option<Vec<u16>> {
    match v {
        Value::String(s) => Some(utf16(s)),
        Value::Object(o) if o.contains_key("u16") => Some(
            o["u16"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u16)
                .collect(),
        ),
        Value::Object(o) if o.contains_key("rep") => {
            let (piece, n) = (&o["rep"][0], o["rep"][1].as_u64().unwrap() as usize);
            Some(spec_units(piece).unwrap().repeat(n))
        }
        Value::Object(o) if o.contains_key("cat") => Some(
            o["cat"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|p| spec_units(p).unwrap())
                .collect(),
        ),
        _ => None,
    }
}

/// An input that may be absent or not a string.
enum In {
    Undef,
    Str(Vec<u16>),
    Other,
}

fn classify(v: &Value) -> In {
    match spec_units(v) {
        Some(units) => In::Str(units),
        None if v.get("undefined").is_some() => In::Undef,
        None => In::Other,
    }
}

/// A result string as the fixtures write it.
fn enc_units(units: &[u16]) -> Value {
    match String::from_utf16(units) {
        Ok(s) => Value::String(s),
        Err(_) => json!({ "u16": units }),
    }
}

fn ok(v: Value) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("ok".to_owned(), v);
    Value::Object(out)
}

fn result(r: Result<Value, SecretError>) -> Value {
    match r {
        Ok(v) => ok(v),
        Err(e) if e == SecretError::invalid_time() => json!({ "throw": "RangeError" }),
        Err(e) => json!({ "err": e.to_json() }),
    }
}

fn cases<'a>(file: &'a Value, section: &str) -> &'a Vec<Value> {
    file[section]["cases"].as_array().unwrap()
}

/// Reports every differing case of a section at once.
struct Report {
    file: String,
    total: usize,
    bad: Vec<String>,
}

impl Report {
    fn new(file: &str) -> Report {
        Report {
            file: file.to_owned(),
            total: 0,
            bad: Vec::new(),
        }
    }
    fn check(&mut self, what: impl FnOnce() -> String, got: &Value, want: &Value) {
        self.total += 1;
        if got != want {
            self.bad.push(format!("{}: got {got} want {want}", what()));
        }
    }
    fn finish(self, expected_cases: usize) {
        assert_eq!(self.total, expected_cases, "{}: cases replayed", self.file);
        assert!(
            self.bad.is_empty(),
            "{}: {} of {} cases differ, first: {:#?}",
            self.file,
            self.bad.len(),
            self.total,
            self.bad.iter().take(6).collect::<Vec<_>>()
        );
    }
}

fn shown(v: &Value) -> String {
    let text = v.to_string();
    text.chars().take(160).collect()
}

#[test]
fn constants_and_vocabularies() {
    let file = load("constants");
    let c = &file["constants"];
    assert_eq!(c["MAX_VALUE_BYTES"], MAX_VALUE_BYTES);
    assert_eq!(c["MAX_DESCRIPTION_CHARS"], MAX_DESCRIPTION_CHARS);
    assert_eq!(c["MIN_REDACTED_VALUE_CHARS"], MIN_REDACTED_VALUE_CHARS);
    assert_eq!(
        c["MIN_DESCRIPTION_VALUE_CHARS"],
        MIN_DESCRIPTION_VALUE_CHARS
    );
    assert_eq!(c["MIN_SECRET_SURFACE"], MIN_SECRET_SURFACE.as_u8());
    assert_eq!(c["DEFAULT_LEASE_TTL_MS"], DEFAULT_LEASE_TTL_MS);
    assert_eq!(c["MAX_LEASE_TTL_MS"], MAX_LEASE_TTL_MS);
    let names = |key: &str| -> Vec<String> {
        file[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    };
    let codes: Vec<String> = SecretErrorCode::ALL
        .iter()
        .map(|c| c.as_str().to_owned())
        .collect();
    assert_eq!(codes, names("errorCodes"));
    for code in SecretErrorCode::ALL {
        assert_eq!(SecretErrorCode::from_wire(code.as_str()), Some(code));
    }
    assert_eq!(SecretErrorCode::from_wire("other"), None);
    let actions: Vec<String> = AuditAction::ALL
        .iter()
        .map(|a| a.as_str().to_owned())
        .collect();
    assert_eq!(actions, names("auditActions"));
    for action in AuditAction::ALL {
        assert_eq!(AuditAction::from_wire(action.as_str()), Some(action));
    }
    assert_eq!(AuditAction::from_wire("secret.other"), None);
    let keys: Vec<String> = DETAIL_KEYS.iter().map(|k| (*k).to_owned()).collect();
    assert_eq!(keys, names("detailKeys"));
    let kinds: Vec<String> = [BackendKind::Keyring, BackendKind::File, BackendKind::Memory]
        .iter()
        .map(|k| k.as_str().to_owned())
        .collect();
    assert_eq!(kinds, names("backendKinds"));
}

#[test]
fn byte_length_counts_like_buffer_byte_length() {
    assert_eq!(
        utf8_len_units(&utf16("a\u{e9}\u{20ac}\u{1F600}")),
        1 + 2 + 3 + 4
    );
    assert_eq!(utf8_len_units(&[0xd800]), 3);
    assert_eq!(utf8_len_units(&[0xdc00, 0xd800]), 6);
    assert_eq!(utf8_len_units(&[0xd83d, 0xde00]), 4);
    assert_eq!(utf8_len_units(&[0xd83d, 0xd83d, 0xde00]), 3 + 4);
}

#[test]
fn name_rules() {
    let file = load("validation");
    let (mut is_name, mut check) = (Report::new("isName"), Report::new("checkName"));
    for row in cases(&file, "isName") {
        let got = match classify(&row[0]) {
            In::Str(u) => is_secret_name_units(&u),
            _ => false,
        };
        is_name.check(|| shown(&row[0]), &json!(got), &row[1]);
    }
    for row in cases(&file, "checkName") {
        let got = result(match classify(&row[0]) {
            In::Str(u) => check_name_units(&u).map(|n| enc_units(&utf16(&n))),
            _ => Err(SecretError::invalid_name()),
        });
        check.check(|| shown(&row[0]), &got, &row[1]);
    }
    is_name.finish(cases(&file, "isName").len());
    check.finish(cases(&file, "checkName").len());
    assert!(cases(&file, "checkName").len() >= 600);
}

#[test]
fn value_rules() {
    let file = load("validation");
    let mut r = Report::new("checkValue");
    for row in cases(&file, "checkValue") {
        let got = result(match classify(&row[0]) {
            In::Str(u) => check_value_units(&u).map(|()| json!(true)),
            _ => Err(SecretError::value_not_text()),
        });
        r.check(|| shown(&row[0]), &got, &row[1]);
    }
    r.finish(cases(&file, "checkValue").len());
    let mut short = Report::new("shortValue");
    for row in cases(&file, "shortValue") {
        let In::Str(u) = classify(&row[0]) else {
            panic!("not a string")
        };
        let got = short_value_warning_units(&u)
            .map_or_else(|| json!({ "undefined": true }), |warning| warning.to_json());
        short.check(|| shown(&row[0]), &got, &row[1]);
    }
    short.finish(cases(&file, "shortValue").len());
}

#[test]
fn description_rules() {
    let file = load("validation");
    let mut r = Report::new("checkDescription");
    for row in cases(&file, "checkDescription") {
        let value = match classify(&row[1]) {
            In::Str(u) => Some(u),
            _ => None,
        };
        let got = result(match classify(&row[0]) {
            In::Undef => check_description_units(None, value.as_deref())
                .map(|t| t.map_or_else(|| json!({ "undefined": true }), |t| enc_units(&t))),
            In::Str(u) => check_description_units(Some(&u), value.as_deref())
                .map(|t| t.map_or_else(|| json!({ "undefined": true }), |t| enc_units(&t))),
            In::Other => Err(SecretError::description_not_text()),
        });
        r.check(
            || format!("{} / {}", shown(&row[0]), shown(&row[1])),
            &got,
            &row[2],
        );
    }
    r.finish(cases(&file, "checkDescription").len());

    let mut next = Report::new("nextDescription");
    let text = |v: &Value| match classify(v) {
        In::Str(u) => Some(String::from_utf16(&u).unwrap()),
        _ => None,
    };
    for row in cases(&file, "nextDescription") {
        let got = next_description(text(&row[0]).as_deref(), text(&row[1]).as_deref())
            .map_or_else(|| json!({ "undefined": true }), Value::String);
        next.check(|| format!("{} / {}", row[0], row[1]), &got, &row[2]);
    }
    next.finish(cases(&file, "nextDescription").len());
}

#[test]
fn backend_failures() {
    let file = load("validation");
    let mut r = Report::new("backendFailure");
    for row in cases(&file, "backendFailure") {
        let cause = &row[0];
        let cause = match cause["kind"].as_str().unwrap() {
            "secret" => BackendCause::Secret(SecretError::with_detail(
                SecretErrorCode::from_wire(cause["code"].as_str().unwrap()).unwrap(),
                cause["message"].as_str().unwrap(),
                cause["detail"].clone(),
            )),
            "code" => BackendCause::Other {
                code: Some(cause["code"].as_str().unwrap().to_owned()),
            },
            _ => BackendCause::Other { code: None },
        };
        let got = result(Err(backend_failure(cause, row[1].as_str().unwrap())));
        r.check(|| shown(&row[0]), &got, &row[2]);
    }
    r.finish(cases(&file, "backendFailure").len());
}

#[test]
fn name_order_is_the_machines_locale_compare() {
    let file = load("name-order");
    let strings = |key: &str| -> Vec<String> {
        file[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    };
    let (input, sorted) = (strings("input"), strings("sorted"));
    assert!(sorted.len() >= 800 && input.len() == sorted.len());
    let mut got = input;
    got.sort_by(|a, b| compare_names(a, b));
    assert_eq!(got, sorted);
    let mut r = Report::new("name-order pairs");
    for row in file["pairs"]["cases"].as_array().unwrap() {
        let (a, b) = (row[0].as_str().unwrap(), row[1].as_str().unwrap());
        let sign = match compare_names(a, b) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        };
        r.check(|| format!("{a:?} {b:?}"), &json!(sign), &row[2]);
    }
    r.finish(file["pairs"]["cases"].as_array().unwrap().len());
}

/// A `Cell` that may cross threads: the lease table's clock and randomness are `Send`, so what a test shares with them is too.
struct Shared<T>(Mutex<T>);

impl<T: Copy> Shared<T> {
    fn new(value: T) -> Shared<T> {
        Shared(Mutex::new(value))
    }
    fn get(&self) -> T {
        *self.0.lock().unwrap()
    }
    fn set(&self, value: T) {
        *self.0.lock().unwrap() = value;
    }
}

/// 16 scripted bytes per draw, the ids the TypeScript run drew.
struct Scripted(Arc<Mutex<VecDeque<Vec<u8>>>>);

impl RandomSource for Scripted {
    fn random_int(&mut self, _max: u32) -> u32 {
        panic!("the lease table draws no integers")
    }
    fn fill_bytes(&mut self, out: &mut [u8]) {
        let next = self.0.lock().unwrap().pop_front().expect("a scripted id");
        assert_eq!(next.len(), out.len());
        out.copy_from_slice(&next);
    }
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn lease_scenarios() {
    let file = load("leases");
    let mut steps_replayed = 0;
    for scenario in file["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let ids: VecDeque<Vec<u8>> = scenario["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| unhex(v.as_str().unwrap()))
            .collect();
        let queue = Arc::new(Mutex::new(ids));
        let (now, calls) = (Arc::new(Shared::new(0_i64)), Arc::new(Shared::new(0_u32)));
        let clock = {
            let (now, calls) = (now.clone(), calls.clone());
            Box::new(move || {
                calls.set(calls.get() + 1);
                now.get()
            })
        };
        let mut table = LeaseTable::new(clock, Box::new(Scripted(queue.clone())));
        let mut report = Report::new(&format!("leases/{name}"));
        for step in scenario["steps"].as_array().unwrap() {
            now.set(step["now"].as_i64().unwrap());
            calls.set(0);
            let text = |key: &str| step[key].as_str().unwrap_or_default().to_owned();
            let lease_json = |l: &super::leases::Lease| {
                let shown = format!("{l:?}");
                assert!(
                    shown.contains("[redacted]") && !shown.contains(&l.value),
                    "{shown}"
                );
                json!({
                    "leaseId": l.lease_id, "name": l.name, "expiresAt": l.expires_at, "purpose": l.purpose,
                    "profileId": l.profile_id, "value": l.value, "json": l.to_json_string(),
                })
            };
            let mut want = step["out"].clone();
            if let Some(lease) = want.get_mut("ok").and_then(Value::as_object_mut) {
                // The `util.inspect` text and the freezing are JavaScript's own; the Debug form is checked to hide the value.
                lease.remove("inspect");
                lease.remove("frozen");
            }
            let got = match step["op"].as_str().unwrap() {
                "issue" => {
                    let ttl_ms = step["ttl"].as_str().map(|t| t.parse::<f64>().unwrap());
                    let options = IssueOptions {
                        purpose: &text("purpose"),
                        profile_id: &text("profileId"),
                        ttl_ms,
                    };
                    result(table.issue(&text("name"), &text("value"), options).map(|l| lease_json(&l)))
                }
                "read" => result(table.read(&text("leaseId")).map(|l| lease_json(&l))),
                "revoke" => ok(json!(table.revoke(&text("leaseId")))),
                "revokeName" => ok(json!(table.revoke_name(&text("name")))),
                "active" => ok(Value::Array(
                    table
                        .active()
                        .into_iter()
                        .map(|i| {
                            json!({ "leaseId": i.lease_id, "name": i.name, "expiresAt": i.expires_at,
                                "purpose": i.purpose, "profileId": i.profile_id })
                        })
                        .collect(),
                )),
                other => panic!("unknown op {other}"),
            };
            report.check(|| format!("{} at {}", step["op"], step["now"]), &got, &want);
            report.check(
                || format!("clock reads of {} at {}", step["op"], step["now"]),
                &json!(calls.get()),
                &step["clockCalls"],
            );
            steps_replayed += 1;
        }
        assert!(
            queue.lock().unwrap().is_empty(),
            "{name}: scripted ids unused"
        );
        let expected = report.total;
        report.finish(expected);
    }
    assert!(steps_replayed >= 80, "{steps_replayed} lease steps");
}

#[test]
fn a_lease_never_shows_its_value() {
    let queue = Arc::new(Mutex::new(VecDeque::from([vec![7_u8; 16]])));
    let mut table = LeaseTable::new(Box::new(|| 1_000), Box::new(Scripted(queue)));
    let options = IssueOptions {
        purpose: "deploy",
        profile_id: "p1",
        ttl_ms: None,
    };
    let lease = table
        .issue("openai", "correct horse battery", options)
        .unwrap();
    assert_eq!(lease.value, "correct horse battery");
    assert_eq!(lease.lease_id, format!("lse_{}", "07".repeat(16)));
    assert_eq!(lease.expires_at, 1_000 + DEFAULT_LEASE_TTL_MS);
    for shown in [
        format!("{lease:?}"),
        format!("{:?}", Some(&lease)),
        lease.to_json_string(),
        lease.to_json().to_string(),
    ] {
        assert!(
            shown.contains("[redacted]") && !shown.contains("horse"),
            "{shown}"
        );
    }
    assert!(!format!("{:?}", lease.info()).contains("horse"));
}

fn meta_check(step: &Value) -> (Option<String>, Option<String>) {
    let by = step.get("by").and_then(Value::as_str).map(str::to_owned);
    let desc = step.get("desc").and_then(Value::as_str).map(str::to_owned);
    (by, desc)
}

#[test]
fn memory_backend_scenarios() {
    let file = load("memory-backend");
    let mut steps_replayed = 0;
    for scenario in file["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let mut backend = MemoryBackend::new(scenario["available"].as_bool().unwrap_or(true));
        assert_eq!(backend.kind(), BackendKind::Memory);
        let mut report = Report::new(&format!("memory-backend/{name}"));
        for step in scenario["steps"].as_array().unwrap() {
            let s = |key: &str| step[key].as_str().unwrap_or_default();
            let (by, desc) = meta_check(step);
            let mut registered: Vec<Value> = Vec::new();
            let mut record = |v: &str| registered.push(Value::String(v.to_owned()));
            let register = step["register"].as_bool() == Some(true);
            let got = match step["op"].as_str().unwrap() {
                "probe" => result(backend.probe().map(|p| match p.reason {
                    Some(reason) => json!({ "available": p.available, "reason": reason }),
                    None => json!({ "available": p.available }),
                })),
                "get" => result(
                    backend
                        .get(s("name"))
                        .map(|v| v.map_or(Value::Null, Value::String)),
                ),
                "put" => result(
                    backend
                        .put(
                            s("name"),
                            s("value"),
                            step["now"].as_i64().unwrap(),
                            by.as_deref(),
                            desc.as_deref(),
                            if register { Some(&mut record) } else { None },
                        )
                        .map(|m| m.to_json()),
                ),
                "describe" => result(
                    backend
                        .describe(
                            s("name"),
                            s("desc"),
                            step["now"].as_i64().unwrap(),
                            by.as_deref(),
                            if register { Some(&mut record) } else { None },
                        )
                        .map(|m| m.to_json()),
                ),
                "delete" => result(backend.delete(s("name"), None).map(|b| json!(b))),
                "list" => result(
                    backend
                        .list()
                        .map(|l| Value::Array(l.iter().map(|m| m.to_json()).collect())),
                ),
                "dump" => ok(Value::Array(
                    backend
                        .dump()
                        .into_iter()
                        .map(|(k, v)| json!([k, v]))
                        .collect(),
                )),
                "setAvailable" => {
                    backend.available = step["available"].as_bool().unwrap();
                    ok(json!(true))
                }
                other => panic!("unknown op {other}"),
            };
            report.check(
                || format!("{} {}", step["op"], step["name"]),
                &got,
                &step["out"],
            );
            if register {
                report.check(
                    || format!("values registered by {} {}", step["op"], step["name"]),
                    &Value::Array(registered),
                    &step["registered"],
                );
            }
            steps_replayed += 1;
        }
        let expected = report.total;
        report.finish(expected);
    }
    assert!(steps_replayed >= 140, "{steps_replayed} backend steps");
}

#[test]
fn memory_backend_has_no_tombstones() {
    let mut backend = MemoryBackend::default();
    assert!(backend.tombstones().is_none());
    assert!(backend.clear_tombstone("a").is_none());
}

fn detail_value(v: &Value) -> DetailValue {
    match (spec_units(v), v) {
        (Some(units), _) => DetailValue::Str(units),
        (None, Value::Number(n)) => DetailValue::Num(n.clone()),
        (None, Value::Bool(b)) => DetailValue::Bool(*b),
        _ => DetailValue::Other,
    }
}

fn detail_input(spec: &Value) -> Option<Vec<(String, DetailValue)>> {
    match spec {
        Value::Null => None,
        Value::Object(o) if o.contains_key("undefined") => None,
        Value::Object(o) => Some(
            o.iter()
                .map(|(k, v)| (k.clone(), detail_value(v)))
                .collect(),
        ),
        other => panic!("detail input {other}"),
    }
}

fn detail_out(detail: &[(&'static str, DetailValue)]) -> Value {
    let mut out = serde_json::Map::new();
    for (key, value) in detail {
        out.insert(
            (*key).to_owned(),
            match value {
                DetailValue::Str(u) => enc_units(u),
                DetailValue::Num(n) => Value::Number(n.clone()),
                DetailValue::Bool(b) => json!(b),
                DetailValue::Other => panic!("an Other value survived"),
            },
        );
    }
    Value::Object(out)
}

#[test]
fn audit_detail_and_actor() {
    let file = load("audit-detail");
    let mut sanitize = Report::new("sanitizeDetail");
    for row in cases(&file, "sanitize") {
        let input = detail_input(&row[0]);
        let got = ok(detail_out(&sanitize_detail(input.as_deref())));
        sanitize.check(|| shown(&row[0]), &got, &row[1]);
    }
    sanitize.finish(cases(&file, "sanitize").len());
    assert!(cases(&file, "sanitize").len() >= 200);

    let marker = file["actor"]["osUserMarker"].as_str().unwrap();
    let mut actor = Report::new("actor user");
    for row in cases(&file, "actor") {
        let d = &row[0];
        let id = |key: &str| {
            d.get(key)
                .map(|v| String::from_utf16(&spec_units(v).unwrap()).unwrap())
        };
        let principal = match d["kind"].as_str().unwrap() {
            "owner" => SecretPrincipal::Owner {
                id: id("id"),
                surface: d
                    .get("surface")
                    .map(|n| SurfaceTrustLevel::from_f64(n.as_f64().unwrap()).unwrap()),
            },
            "agent" => SecretPrincipal::Agent {
                agent_id: id("agentId"),
            },
            _ => SecretPrincipal::Core,
        };
        let got = enc_units(&actor_user_units(&principal, &utf16(marker)));
        actor.check(|| shown(d), &got, &row[1]);
    }
    actor.finish(cases(&file, "actor").len());

    // What the memory sink files: the detail of an event, sanitized.
    let event = &file["memorySink"]["event"];
    let detail = vec![
        ("backend".to_owned(), DetailValue::Str(utf16("file"))),
        ("value".to_owned(), DetailValue::Str(utf16("x"))),
        (
            "purpose".to_owned(),
            DetailValue::Str(utf16(&"p".repeat(200))),
        ),
    ];
    assert_eq!(
        detail_to_json(&sanitize_detail(Some(&detail))),
        event["detail"]
    );
    assert_eq!(
        file["auditUnavailable"],
        json!({ "err": SecretError::audit_unavailable().to_json() })
    );
}
