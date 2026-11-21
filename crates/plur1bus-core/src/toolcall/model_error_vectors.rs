//! Replays `fixtures/parity/toolcall/model-tool-error.json` (mode V, `scripts/parity/export-model-tool-error.ts`): the
//! envelope the model gets for each failure, secret source, home directory and platform, compared as JSON text (the home
//! grid as its message and the envelope's hash).
use super::json::{parse_units, Parsed, V};
use super::model_tool_error::{ModelToolErrorOptions, ModelToolErrors, SecretSource};
use super::vectors::{hash16, js};
use plur1bus_log_schema::redact::SecretFormsCache;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/parity/toolcall/model-tool-error.json"
    ))
    .expect("fixture parses")
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| js(x).lossy())
        .collect()
}

#[test]
fn model_tool_error_cases() {
    let f = fixture();
    // The process's home is never used by a case: each names its own.
    let mut boundary = ModelToolErrors::new("/process/home", "/process/home");
    let mut ran = 0;
    for c in f["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let failure = match parse_units(js(&c["failure"]).units()) {
            Ok(Parsed::Value(v)) => v,
            other => panic!("{name}: {other:?}"),
        };
        let raw: Vec<String>;
        let raw_refs: Vec<&str>;
        let forms: Vec<String>;
        let secrets = match c.get("secrets") {
            None => SecretSource::Raw(&[]),
            Some(s) if s.get("raw").is_some() => {
                raw = strings(&s["raw"]);
                raw_refs = raw.iter().map(String::as_str).collect();
                SecretSource::Raw(&raw_refs)
            }
            Some(s) if s.get("forms").is_some() => {
                forms = strings(&s["forms"]);
                SecretSource::Forms(&forms)
            }
            Some(s) => {
                let values = strings(&s["matcher"]);
                let snapshot =
                    SecretFormsCache::default().snapshot(values.iter().map(String::as_str));
                SecretSource::Matcher(snapshot.matcher.clone())
            }
        };
        let options = ModelToolErrorOptions {
            secrets,
            home: c["home"].as_str(),
            real_home: c.get("realHome").and_then(Value::as_str),
            platform: c["platform"].as_str().unwrap(),
        };
        let got = boundary.model_tool_error(&failure, &options);
        let want = &c["answer"];
        match (got, want.get("throws")) {
            (Err(e), Some(t)) => assert_eq!(Some(e.name), t["name"].as_str(), "{name}"),
            (Ok(v), None) => {
                let text = v.stringify();
                if let Some(h) = want.get("h") {
                    let message = v
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .map(V::stringify);
                    let recorded = V::Str(js(&want["message"])).stringify();
                    assert_eq!(
                        message.as_deref(),
                        Some(recorded.as_str()),
                        "{name}: {}",
                        c["failure"]
                    );
                    assert_eq!(h.as_str(), Some(hash16(&text).as_str()), "{name}: {text}");
                    assert_eq!(
                        want["n"].as_u64(),
                        Some(text.encode_utf16().count() as u64),
                        "{name}"
                    );
                } else {
                    assert_eq!(text, js(want).lossy(), "{name}");
                }
            }
            (got, _) => panic!("{name}: Rust {got:?}, TypeScript {want}"),
        }
        ran += 1;
    }
    assert!(ran > 700, "{ran} cases");
}

#[test]
fn legacy_forms_keep_one_matcher_per_membership() {
    let mut boundary = ModelToolErrors::new("/h", "/h");
    let failure = V::obj([(
        "error",
        V::obj([("code", V::s("tool-failed")), ("message", V::s("m"))]),
    )]);
    let forms = vec!["alpha-form-1".to_owned(), "beta-form-22".to_owned()];
    let reversed: Vec<String> = forms.iter().rev().cloned().collect();
    for list in [&forms, &reversed] {
        let options = ModelToolErrorOptions {
            secrets: SecretSource::Forms(list),
            home: Some("/h"),
            real_home: None,
            platform: "linux",
        };
        boundary.model_tool_error(&failure, &options).unwrap();
    }
    let first = boundary.legacy_matcher().unwrap();
    let options = ModelToolErrorOptions {
        secrets: SecretSource::Forms(&reversed),
        home: Some("/h"),
        real_home: None,
        platform: "linux",
    };
    boundary.model_tool_error(&failure, &options).unwrap();
    assert!(std::sync::Arc::ptr_eq(
        &first,
        &boundary.legacy_matcher().unwrap()
    ));
    let changed = vec!["gamma-form-333".to_owned()];
    let options = ModelToolErrorOptions {
        secrets: SecretSource::Forms(&changed),
        home: Some("/h"),
        real_home: None,
        platform: "linux",
    };
    boundary.model_tool_error(&failure, &options).unwrap();
    assert!(!std::sync::Arc::ptr_eq(
        &first,
        &boundary.legacy_matcher().unwrap()
    ));
}
