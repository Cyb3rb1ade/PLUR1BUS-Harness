use super::*;
use serde_json::{json, Value};

#[test]
fn coding_diff_page_vectors() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/coding/diff-pages.json"
    ))
    .unwrap();
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let result = tool_diff(
            "session",
            c["output"].as_str(),
            c["offset"].as_i64().unwrap(),
            c["limit"].as_i64().unwrap(),
            &|text| text.replace("secret-fixture", "[masked]"),
        );
        let wire = match result {
            Ok(diff) => json!({ "ok": diff }),
            Err(e) => {
                json!({"err": { "code": if e.reason.as_deref() == Some("tool-diff-unavailable") { "E_NOT_AVAILABLE" }
                else if e.code == C::NotFound { "E_NOT_FOUND" } else { "E_INVALID_PARAMS" }, "message": e.message, "reason": e.reason }})
            }
        };
        assert_eq!(wire, c["result"], "{name}");
    }
}

#[test]
fn advisory_output_limit_applies_before_and_after_redaction() {
    use std::cell::Cell;
    let result = |output: String| VerifierResult {
        ok: true,
        exit_code: Some(0),
        reason: None,
        output,
    };
    let called = Cell::new(false);
    let oversized = release_advisory_output(result("أ".repeat(32_769)), &|_| {
        called.set(true);
        "masked".to_owned()
    });
    assert!(!oversized.ok);
    assert!(!called.get());
    assert_eq!(oversized.reason.as_deref(), Some("output-limit"));
    assert!(oversized.output.is_empty());

    let expanded = release_advisory_output(result("ok".to_owned()), &|_| "x".repeat(65_537));
    assert!(!expanded.ok);
    assert_eq!(expanded.reason.as_deref(), Some("output-limit"));
    assert!(expanded.output.is_empty());

    let exactly = release_advisory_output(result("x".repeat(65_536)), &str::to_owned);
    assert!(exactly.ok);
    assert_eq!(exactly.output.len(), 65_536);
}
