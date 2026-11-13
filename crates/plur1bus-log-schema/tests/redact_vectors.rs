//! Replays the parity vectors `fixtures/parity/logs/{redact,secret-matcher}.json` (recorded from the TypeScript redactor by
//! `scripts/parity/export-logs.ts`) over the Rust redactor. Where JavaScript and Rust differ the case is pinned in
//! `DIVERGENCES` with the Rust answer and the reason; nothing else may differ.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use plur1bus_log_schema::redact::{
    json_escape_view, json_secret_views, mask_secrets_in_json, secret_forms_in, secret_forms_of,
    utf16::{to_well_formed, utf16, well_formed_prefix_units},
    RedactOptions, Redactor, SecretMatcher,
};
use serde_json::Value;
use std::{fs, path::PathBuf, sync::Arc};

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/parity/logs")
        .join(format!("{name}.json"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (run scripts/parity/export-logs.ts)",
            path.display()
        )
    });
    serde_json::from_str(&text).unwrap()
}

/// A stored string as UTF-16 code units: plain text, `{units}`, or `{parts}` of those.
fn units(e: &Value) -> Vec<u16> {
    match e {
        Value::String(s) => utf16(s),
        Value::Object(o) if o.contains_key("units") => o["units"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u.as_u64().unwrap() as u16)
            .collect(),
        Value::Object(o) => o["parts"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(units)
            .collect(),
        other => panic!("not a stored string: {other}"),
    }
}

/// A stored string that is well-formed.
fn string(e: &Value) -> String {
    let u = units(e);
    String::from_utf16(&u).unwrap_or_else(|_| panic!("not well-formed: {u:?}"))
}

fn strings(list: &Value) -> Vec<String> {
    list.as_array().unwrap().iter().map(string).collect()
}

fn options(o: &Value) -> RedactOptions {
    RedactOptions {
        pii: o["pii"] == true,
        secrets_only: o["secretsOnly"] == true,
        secrets: o.get("secrets").map(strings).unwrap_or_default(),
        secret_forms: o
            .get("secretForms")
            .map(|l| l.as_array().unwrap().iter().map(units).collect())
            .unwrap_or_default(),
        secret_matcher: None,
    }
}

fn matcher(case: &Value) -> SecretMatcher {
    SecretMatcher::new(
        case["forms"]
            .as_array()
            .unwrap()
            .iter()
            .map(units)
            .collect(),
    )
}

fn spans(list: &Value) -> Vec<(usize, usize)> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s[0].as_u64().unwrap() as usize,
                s[1].as_u64().unwrap() as usize,
            )
        })
        .collect()
}

fn bytes(list: &Value) -> Vec<u8> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}

fn found(m: &SecretMatcher, input: &[u16]) -> Vec<(usize, usize)> {
    m.find_text_spans_units(input)
        .iter()
        .map(|s| (s.start, s.end))
        .collect()
}

/// Cases where the Rust answer differs from the recorded JavaScript one, with the Rust answer and why. The key is the
/// area and the case name.
const DIVERGENCES: &[(&str, &str, &str)] = &[
    // A JavaScript /i regexp (no u flag) never folds a non-ASCII letter onto an ASCII one; the regex crate's (?i) uses
    // Unicode simple case folding, so the Kelvin sign is a k. The Rust side redacts more, never less.
    (
        "text",
        "unicode-fold-kelvin-sign-in-a-header-name",
        "Coo\u{212a}ie: [REDACTED:key]",
    ),
    // The patterns of redaction.json run in the regex crate, whose \s is Unicode White_Space: U+FEFF is no space there
    // (JavaScript: one), U+0085 is one (JavaScript: not).
    (
        "text",
        "js-whitespace-bom-after-bearer",
        "sent Bearer\u{feff}abcdefghijklmnop done",
    ),
    (
        "text",
        "js-whitespace-nel-after-bearer",
        "sent [REDACTED:pattern] done",
    ),
    // JavaScript numbers repeated keys in insertion order, a serde_json::Map iterates in key order.
    (
        "value",
        "secrets-only-repeated-key-numbering",
        r##"{"[REDACTED:secret]":4,"[REDACTED:secret]#2":1,"[REDACTED:secret]#3":2,"other":3}"##,
    ),
    (
        "maskJson",
        "repeated-keys",
        r##"{"[REDACTED:secret]":4,"[REDACTED:secret]#2":1,"[REDACTED:secret]#3":2,"other":3}"##,
    ),
];

fn divergence(area: &str, name: &str) -> Option<&'static str> {
    DIVERGENCES
        .iter()
        .find(|(a, n, _)| *a == area && *n == name)
        .map(|(_, _, rust)| *rust)
}

#[test]
fn text_vectors() {
    let v = fixture("redact");
    let cases = v["text"].as_array().unwrap();
    assert!(cases.len() > 80);
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let redactor = Redactor::new(options(&case["options"])).unwrap();
        let got = redactor.text_units(&units(&case["input"]));
        let want = match divergence("text", name) {
            Some(rust) => rust.to_string(),
            None => string(&case["output"]),
        };
        if got != want {
            failures.push(format!("text case {name}: got {got:?}, want {want:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn value_vectors() {
    let v = fixture("redact");
    for case in v["value"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let redactor = Redactor::new(options(&case["options"])).unwrap();
        let input: Value = serde_json::from_str(&string(&case["inputJson"])).unwrap();
        let got = redactor.value(&input);
        let want: Value = match divergence("value", name) {
            Some(rust) => serde_json::from_str(rust).unwrap(),
            None => serde_json::from_str(&string(&case["outputJson"])).unwrap(),
        };
        assert_eq!(got, want, "value case {name}");
    }
}

#[test]
fn window_vectors() {
    let v = fixture("redact");
    for case in v["window"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let redactor = Redactor::new(options(&case["options"])).unwrap();
        let input = string(&case["input"]);
        let (begin, end) = (
            case["begin"].as_u64().unwrap() as usize,
            case["end"].as_u64().unwrap() as usize,
        );
        assert_eq!(
            redactor.text_window(&input, begin, end).unwrap(),
            string(&case["output"]),
            "window case {name}"
        );
    }
    let redactor = Redactor::new(RedactOptions::default()).unwrap();
    assert!(redactor.text_window("abc", 2, 1).is_err());
    assert!(redactor.text_window("abc", 0, 4).is_err());
}

#[test]
fn secret_key_vectors() {
    let v = fixture("redact");
    for case in v["secretKey"].as_array().unwrap() {
        let name = string(&case["name"]);
        assert_eq!(
            plur1bus_log_schema::redact::is_secret_key(&name).unwrap(),
            case["secret"] == true,
            "key name {name:?}"
        );
    }
}

#[test]
fn mask_json_vectors() {
    let v = fixture("redact");
    for case in v["maskJson"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let m = Arc::new(match case.get("forms") {
            Some(_) => matcher(case),
            None => SecretMatcher::from_strs(
                secret_forms_in(strings(&case["secrets"]).iter().map(String::as_str))
                    .iter()
                    .map(String::as_str),
            ),
        });
        let json = units(&case["json"]);
        assert_eq!(
            m.scan_json_units(&json).found,
            case["found"] == true,
            "scan {name}"
        );
        let json = String::from_utf16(&json).unwrap();
        if case["loneSurrogate"] == true {
            // serde_json refuses a lone surrogate escape: the scan above is all the Rust side can check.
            assert!(serde_json::from_str::<Value>(&json).is_err(), "{name}");
            continue;
        }
        let value: Value = serde_json::from_str(&json).unwrap();
        let got = mask_secrets_in_json(&json, &value, &m);
        match case["result"].as_str().unwrap() {
            "none" => assert_eq!(got.unwrap(), None, "{name}"),
            "error" => {
                let err = got.unwrap_err();
                assert!(err.0.contains("outside any string"), "{name}: {err}");
                assert!(case["message"]
                    .as_str()
                    .unwrap()
                    .contains("outside any string"));
            }
            _ => {
                let masked = got
                    .unwrap()
                    .unwrap_or_else(|| panic!("{name}: nothing masked"));
                let want_value = match divergence("maskJson", name) {
                    Some(rust) => serde_json::from_str(rust).unwrap(),
                    None => serde_json::from_str::<Value>(&string(&case["valueJson"])).unwrap(),
                };
                assert_eq!(masked.value, want_value, "{name}");
                assert_eq!(
                    serde_json::from_str::<Value>(&masked.json).unwrap(),
                    want_value,
                    "{name}: the serialised text"
                );
            }
        }
    }
}

#[test]
fn matcher_text_vectors() {
    let v = fixture("secret-matcher");
    let cases = v["text"].as_array().unwrap();
    assert!(cases.len() >= 15);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let m = matcher(case);
        let input = units(&case["input"]);
        assert_eq!(found(&m, &input), spans(&case["spans"]), "spans {name}");
        let masked = m.mask_text_units(&input);
        assert_eq!(
            masked,
            to_well_formed(&units(&case["masked"])),
            "masked {name}"
        );
        let projection = m.project_text_units(&input);
        assert_eq!(
            projection.text,
            to_well_formed(&units(&case["projected"])),
            "projection {name}"
        );
        assert_eq!(
            projection
                .spans
                .iter()
                .map(|s| (s.start, s.end))
                .collect::<Vec<_>>(),
            spans(&case["spans"]),
            "projection spans {name}"
        );
        for w in case["windows"].as_array().unwrap() {
            let (begin, end) = (
                w["begin"].as_u64().unwrap() as usize,
                w["end"].as_u64().unwrap() as usize,
            );
            assert_eq!(
                m.mask_text_window_units(&input, begin, end).unwrap(),
                to_well_formed(&units(&w["output"])),
                "window {begin}..{end} of {name}"
            );
        }
        if let Some(b) = case.get("bytes") {
            let input = bytes(&b["input"]);
            assert_eq!(
                m.find_byte_spans(&input)
                    .iter()
                    .map(|s| (s.start, s.end))
                    .collect::<Vec<_>>(),
                spans(&b["spans"]),
                "byte spans {name}"
            );
            assert_eq!(
                m.mask_bytes(&input),
                bytes(&b["masked"]),
                "byte mask {name}"
            );
        }
    }
}

#[test]
fn matcher_byte_vectors() {
    let v = fixture("secret-matcher");
    for case in v["bytes"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let m = matcher(case);
        let input = bytes(&case["input"]);
        assert_eq!(
            m.find_byte_spans(&input)
                .iter()
                .map(|s| (s.start, s.end))
                .collect::<Vec<_>>(),
            spans(&case["spans"]),
            "spans {name}"
        );
        assert_eq!(m.mask_bytes(&input), bytes(&case["masked"]), "mask {name}");
        assert_eq!(
            m.max_source_bytes(),
            case["maxSourceBytes"].as_u64().unwrap() as usize,
            "{name}"
        );
        for w in case["windows"].as_array().unwrap() {
            let (begin, end) = (
                w["begin"].as_u64().unwrap() as usize,
                w["end"].as_u64().unwrap() as usize,
            );
            assert_eq!(
                m.mask_bytes_window(&input, begin, end).unwrap(),
                bytes(&w["output"]),
                "window {begin}..{end} of {name}"
            );
        }
    }
}

#[test]
fn matcher_limit_vectors() {
    let v = fixture("secret-matcher");
    for case in v["limits"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let m = matcher(case);
        assert_eq!(
            m.max_form_units(),
            case["maxFormUnits"].as_u64().unwrap() as usize,
            "{name}"
        );
        assert_eq!(
            m.max_source_bytes(),
            case["maxSourceBytes"].as_u64().unwrap() as usize,
            "{name}"
        );
        assert_eq!(
            m.forms().len(),
            case["distinctForms"].as_u64().unwrap() as usize,
            "{name}"
        );
    }
}

#[test]
fn form_vectors() {
    let v = fixture("secret-matcher");
    for case in v["formsOf"].as_array().unwrap() {
        assert_eq!(
            secret_forms_of(&string(&case["value"])),
            strings(&case["forms"]),
            "{}",
            string(&case["value"])
        );
    }
    for case in v["formsIn"].as_array().unwrap() {
        let values = strings(&case["values"]);
        assert_eq!(
            secret_forms_in(values.iter().map(String::as_str)),
            strings(&case["forms"]),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn helper_vectors() {
    let v = fixture("secret-matcher");
    for case in v["wellFormed"].as_array().unwrap() {
        let limit = case["limit"].as_u64().unwrap() as usize;
        assert_eq!(
            well_formed_prefix_units(&units(&case["text"]), limit),
            string(&case["output"]),
            "{:?} {limit}",
            case["text"]
        );
    }
    for case in v["escapes"].as_array().unwrap() {
        let input = units(&case["input"]);
        match (json_escape_view(&input), case["view"].as_object()) {
            (None, None) => {}
            (Some(view), Some(want)) => {
                assert_eq!(
                    to_well_formed(&view.text),
                    to_well_formed(&units(&want["text"])),
                    "{:?}",
                    case["input"]
                );
                let offsets: Vec<usize> = (0..=view.text.len())
                    .map(|at| view.source_offset(at))
                    .collect();
                let want_offsets: Vec<usize> = want["offsets"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|o| o.as_u64().unwrap() as usize)
                    .collect();
                assert_eq!(offsets, want_offsets, "{:?}", case["input"]);
            }
            other => panic!("{:?}: {other:?}", case["input"]),
        }
    }
    for case in v["secretViews"].as_array().unwrap() {
        let got: Vec<Vec<u16>> = json_secret_views(&units(&case["json"]));
        let want: Vec<Vec<u16>> = case["views"]
            .as_array()
            .unwrap()
            .iter()
            .map(units)
            .collect();
        assert_eq!(got, want, "{:?}", case["json"]);
    }
}
