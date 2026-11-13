//! Limits of the shared redactor that a vector cannot express: running time on hostile input
//! (`redact.test.ts` "a generated path flood cannot stall redaction", `redaction-gaps.test.ts` "is linear on long runs"),
//! the depth bound with every option, and that the input is never changed.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use plur1bus_log_schema::redact::{RedactOptions, Redactor, MAX_DEPTH};
use serde_json::{json, Value};
use std::time::Instant;

fn plain() -> Redactor {
    Redactor::new(RedactOptions::default()).unwrap()
}

#[test]
fn a_generated_path_flood_cannot_stall_redaction() {
    let started = Instant::now();
    plain().text(&"/x".repeat(256));
    assert!(
        started.elapsed().as_millis() < 1000,
        "took {:?}",
        started.elapsed()
    );
}

#[test]
fn redaction_is_linear_on_long_runs_without_a_separator() {
    let redactor = plain();
    let runs = [
        "m".repeat(65536),
        "a.b-".repeat(16384),
        "key ".repeat(16384),
        "\"a".repeat(32768),
        "k:".repeat(32768),
        "= ".repeat(32768),
        format!("{}://", "a".repeat(32768)),
        "ab+".repeat(21845),
    ];
    for run in runs {
        let started = Instant::now();
        redactor.text(&run);
        assert!(
            started.elapsed().as_millis() < 1000,
            "{} bytes took {:?}",
            run.len(),
            started.elapsed()
        );
    }
}

#[test]
fn the_registry_scan_is_linear_on_periodic_input() {
    let secret = "abababababababababababab-fixture";
    let redactor = Redactor::new(RedactOptions {
        secrets: vec![secret.to_string(), "ab".repeat(16)],
        ..RedactOptions::default()
    })
    .unwrap();
    let input = "ab".repeat(100_000);
    let started = Instant::now();
    let out = redactor.text(&input);
    assert!(
        started.elapsed().as_millis() < 1000,
        "took {:?}",
        started.elapsed()
    );
    assert!(out.contains("[REDACTED:secret]"));
    assert!(!out.contains("abababab"));
}

#[test]
fn nesting_beyond_the_bound_is_replaced_with_every_option() {
    for options in [
        RedactOptions::default(),
        RedactOptions {
            pii: true,
            secrets_only: false,
            secrets: vec!["fixture-depth-0123456789".to_string()],
            ..RedactOptions::default()
        },
        RedactOptions {
            secrets: vec!["fixture-depth-0123456789".to_string()],
            secrets_only: true,
            ..RedactOptions::default()
        },
    ] {
        let mut v = json!("fixture-depth-0123456789 Bearer abcdef123456");
        for _ in 0..(MAX_DEPTH + 5) {
            v = json!([v, {"k": 1}]);
        }
        let got = Redactor::new(options).unwrap().value(&v).to_string();
        assert!(!got.contains("fixture-depth-0123456789"));
        assert!(!got.contains("abcdef123456"));
        assert!(got.contains("[TRUNCATED:depth]"));
    }
}

#[test]
fn the_input_is_not_changed_and_non_strings_pass() {
    let input =
        json!({"a": {"token": "x"}, "n": 1, "z": null, "l": ["Bearer abcdefghij"], "b": true});
    let copy = input.clone();
    let out = plain().value(&input);
    assert_eq!(input, copy);
    assert_eq!(out["a"]["token"], "[REDACTED:key]");
    assert_eq!(out["l"][0], "[REDACTED:pattern]");
    assert_eq!(
        plain().value(&json!({"n": 1, "z": null, "b": true})),
        json!({"n": 1, "z": null, "b": true})
    );
}

#[test]
fn rule_six_is_off_unless_asked_for() {
    let text = "mail a.b@example.test or +4930123456789";
    assert_eq!(plain().text(text), text);
    let pii = Redactor::new(RedactOptions {
        pii: true,
        ..RedactOptions::default()
    })
    .unwrap();
    assert!(pii.pii());
    assert_eq!(pii.text(text), "mail [REDACTED:pii] or [REDACTED:pii]");
    assert_eq!(
        pii.value(&json!({"note": "a.b@example.test", "n": 3})),
        json!({"note": "[REDACTED:pii]", "n": 3})
    );
}

#[test]
fn references_survive_only_where_named() {
    let detail: Value =
        json!({"apiKey": {"handle": "service.reference", "ordinary": "plain-value"}});
    let out = plain().value_preserving_references(&detail, &["/apiKey/handle".to_string()]);
    assert_eq!(out["apiKey"]["handle"], "service.reference");
    assert_eq!(out["apiKey"]["ordinary"], "[REDACTED:key]");
}
