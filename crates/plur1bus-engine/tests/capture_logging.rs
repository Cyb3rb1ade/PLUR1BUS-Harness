//! Controller CA-R2: the batch failure path must not disclose reflected capture input.
#![allow(clippy::unwrap_used)]

use std::sync::Mutex;

use plur1bus_engine::capture::batch::run_batch;
use plur1bus_engine::capture::logging::{CaptureLogSink, SafeCaptureLog};
use plur1bus_engine::contract::EngineError;

#[derive(Default)]
struct RecordingLog(Mutex<Vec<SafeCaptureLog>>);

impl CaptureLogSink for RecordingLog {
    fn record(&self, entry: SafeCaptureLog) {
        self.0.lock().unwrap().push(entry);
    }
}

#[test]
fn a_batch_error_reflecting_capture_input_emits_a_content_free_log_without_changing_the_error() {
    let private = "synthetic private capture sentence used only by the injected failure";
    let sink = RecordingLog::default();
    let result: Result<(), EngineError> = run_batch(&sink, 8, || {
        Err(EngineError::Invalid {
            field: private.into(),
            message: private.into(),
        })
    });
    assert!(matches!(result, Err(EngineError::Invalid { message, .. }) if message == private));
    let records = sink.0.lock().unwrap();
    assert_eq!(
        records.len(),
        1,
        "a failed batch must produce its diagnostic"
    );
    let line = serde_json::to_string(&records[0]).unwrap();
    assert_eq!(
        line,
        r#"{"stage":"batch-embedding","class":"invalid-input","code":"invalid-input","count":8}"#
    );
    assert!(!line.contains(private));
}

#[test]
fn a_successful_batch_preserves_its_vectors_and_emits_no_failure_log() {
    let sink = RecordingLog::default();
    let expected = vec![vec![1.0_f32, 0.0], vec![0.0, 1.0]];
    let result = run_batch(&sink, 2, || Ok(expected.clone())).unwrap();
    assert_eq!(result, expected);
    assert!(sink.0.lock().unwrap().is_empty());
}
