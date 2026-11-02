//! Invalid collaborator data stays fallible; recorder integrity precedes imports/version.
#![allow(
    clippy::unwrap_used,
    reason = "fixture and subprocess failures must stop the test"
)]

use plur1bus_engine::recall::memory_context::{self, FormatOptions, PromptItem};
use plur1bus_engine::recall::neo_prelude::{NeoPrelude, NeoRequest};
use plur1bus_engine::recall::render::RenderError;
use plur1bus_engine::recall::warm::{self, WarmParameters, WarmRecall, WarmRequest};
use plur1bus_engine::text::js::JsString;
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;

#[test]
fn malformed_record_metadata_returns_an_error_without_panicking() {
    for fields in [
        json!(null),
        json!([]),
        json!("synthetic malformed row"),
        json!(1),
    ] {
        let item = PromptItem {
            fields,
            display: "evidence".into(),
            trace: None,
        };
        let result = memory_context::format(&[item], &FormatOptions::from_value(&json!({}), 0.0));
        assert!(result.is_err());
    }
}

struct EmptyNeo;
impl NeoPrelude for EmptyNeo {
    fn read(&self, _request: &NeoRequest<'_>) -> Result<JsString, RenderError> {
        Ok(JsString::default())
    }
}

struct FailedRead(RenderError);
impl WarmRecall for FailedRead {
    fn has_table(&self) -> Result<bool, RenderError> {
        Err(self.0.clone())
    }
    fn recall(&mut self, _parameters: &WarmParameters) -> Result<(), RenderError> {
        unreachable!("the failed lease must stop selection")
    }
}

#[test]
fn every_nonabort_warm_error_degrades_and_abort_propagates() {
    let request = WarmRequest {
        prompt: "Warm this query".into(),
        neo_enabled: false,
        top_n: 12,
        allowed: true,
    };
    for error in [
        RenderError::InvalidIndex,
        RenderError::InvalidTimestamp,
        RenderError::InvalidTimezone,
    ] {
        let result = warm::run(&request, &mut FailedRead(error), &EmptyNeo);
        assert!(result.is_ok());
        let result = result.unwrap();
        assert!(result.blocks.is_empty());
        assert_eq!(result.degraded.unwrap().reason, "warm-failed");
    }
    assert_eq!(
        warm::run(&request, &mut FailedRead(RenderError::Aborted), &EmptyNeo),
        Err(RenderError::Aborted)
    );
}

#[test]
fn render_recorder_rejects_tampered_source_before_version_or_imports() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch
        .path()
        .join("engine/recall/assemble-prompt-context.js");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(source, "throw new Error('untrusted source imported');").unwrap();
    let script =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/recall/record-render.mjs");
    let output = Command::new("node")
        .arg(script)
        .arg("--capture")
        .arg(scratch.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("pinned render source hash mismatch"));
    assert!(!error.contains("untrusted source imported"));
    assert!(!error.contains("record with pinned Node"));
}
