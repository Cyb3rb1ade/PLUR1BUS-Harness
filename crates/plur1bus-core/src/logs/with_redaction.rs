//! `with-redaction.ts`: injected loggers receive the same live exact-value policy as the default writer, including child
//! context and errors.
//!
//! [`RedactingLogger`] keeps the target's levels, rotation and lifecycle while masking every message and structured field
//! before delivery. The target is the seam [`LogTarget`] (the TypeScript `HarnessLogger` without `child`: a child of the
//! wrapper merges its context into the wrapper's own, so the target never sees raw child context). Fields arrive as JSON;
//! turning an error value into its diagnostic fields (`serializeError`) is the caller's step.
use super::redact::TextRedactor;
use plur1bus_log_schema::Level;
use serde_json::{Map, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

/// What a redacting logger delivers to: one call per record, plus the lifecycle the wrapper passes through.
pub trait LogTarget: Send + Sync {
    /// Delivers one record whose message and fields are already redacted.
    fn log(&self, level: Level, message: &str, fields: &Map<String, Value>);
    /// Changes the minimum level.
    fn set_level(&self, level: Level);
    /// Changes the rotation options (`maxBytes`, `keep`, ...), as the target defines them.
    fn set_rotation(&self, options: &Value);
    /// Flushes and releases the target.
    fn close(&self);
}

/// The message delivered when redaction fails: the payload is withheld, never passed on raw.
pub const WITHHELD_MESSAGE: &str = "log redaction failed; the payload was withheld";

/// A logger that masks before it delivers.
#[derive(Clone)]
pub struct RedactingLogger {
    target: Arc<dyn LogTarget>,
    redactor: Arc<dyn TextRedactor>,
    base: Map<String, Value>,
}

/// `withRedaction(target, redactor)`.
pub fn with_redaction(
    target: Arc<dyn LogTarget>,
    redactor: Arc<dyn TextRedactor>,
) -> RedactingLogger {
    RedactingLogger {
        target,
        redactor,
        base: Map::new(),
    }
}

/// A redacting logger is a logger like any other (the bootstrap's [`HarnessLogger`]).
impl super::bootstrap::HarnessLogger for RedactingLogger {
    fn log(&self, level: Level, message: &str, fields: &Map<String, Value>) {
        RedactingLogger::log(self, level, message, fields);
    }

    fn child(&self, fields: &Map<String, Value>) -> Arc<dyn super::bootstrap::HarnessLogger> {
        Arc::new(RedactingLogger::child(self, fields))
    }

    fn set_level(&self, level: Level) {
        RedactingLogger::set_level(self, level);
    }

    fn set_rotation(&self, options: &Value) {
        RedactingLogger::set_rotation(self, options);
    }

    fn close(&self) {
        RedactingLogger::close(self);
    }
}

impl RedactingLogger {
    /// Redacts and delivers one record: the child context merged with `fields` (the fields win), then the redactor over
    /// the message and over the merged fields. A failure (a redactor or a target that panics) delivers
    /// [`WITHHELD_MESSAGE`] at level `error` instead; a log sink cannot stop the core.
    pub fn log(&self, level: Level, message: &str, fields: &Map<String, Value>) {
        let delivered = catch_unwind(AssertUnwindSafe(|| {
            let mut merged = self.base.clone();
            merged.extend(fields.iter().map(|(k, v)| (k.clone(), v.clone())));
            let redacted = match self.redactor.value(&Value::Object(merged)) {
                Value::Object(map) => map,
                // A redactor that does not answer with an object withheld the payload.
                _ => Map::new(),
            };
            self.target
                .log(level, &self.redactor.text(message), &redacted);
        }));
        if delivered.is_err() {
            // The sink may fail again; nothing more can be done.
            let _ = catch_unwind(AssertUnwindSafe(|| {
                self.target.log(Level::Error, WITHHELD_MESSAGE, &Map::new());
            }));
        }
    }

    /// `debug(message, fields)`.
    pub fn debug(&self, message: &str, fields: &Map<String, Value>) {
        self.log(Level::Debug, message, fields);
    }

    /// `info(message, fields)`.
    pub fn info(&self, message: &str, fields: &Map<String, Value>) {
        self.log(Level::Info, message, fields);
    }

    /// `warn(message, fields)`.
    pub fn warn(&self, message: &str, fields: &Map<String, Value>) {
        self.log(Level::Warn, message, fields);
    }

    /// `error(message, fields)`.
    pub fn error(&self, message: &str, fields: &Map<String, Value>) {
        self.log(Level::Error, message, fields);
    }

    /// A child whose context is this logger's context plus `fields`. The context stays raw here and is redacted on every
    /// delivery, so a credential that becomes known after the child was made is still masked.
    pub fn child(&self, fields: &Map<String, Value>) -> RedactingLogger {
        let mut base = self.base.clone();
        base.extend(fields.iter().map(|(k, v)| (k.clone(), v.clone())));
        RedactingLogger {
            target: self.target.clone(),
            redactor: self.redactor.clone(),
            base,
        }
    }

    /// Changes the target's minimum level.
    pub fn set_level(&self, level: Level) {
        self.target.set_level(level);
    }

    /// Changes the target's rotation options.
    pub fn set_rotation(&self, options: &Value) {
        self.target.set_rotation(options);
    }

    /// Closes the target.
    pub fn close(&self) {
        self.target.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::redact::SecretSet;
    use serde_json::json;
    use std::sync::Mutex;

    type Row = (Level, String, Map<String, Value>);

    #[derive(Default)]
    struct Recorder {
        rows: Mutex<Vec<Row>>,
        calls: Mutex<Vec<String>>,
    }

    impl LogTarget for Recorder {
        fn log(&self, level: Level, message: &str, fields: &Map<String, Value>) {
            self.rows
                .lock()
                .unwrap()
                .push((level, message.to_string(), fields.clone()));
        }
        fn set_level(&self, level: Level) {
            self.calls.lock().unwrap().push(level.as_str().to_string());
        }
        fn set_rotation(&self, options: &Value) {
            self.calls.lock().unwrap().push(options.to_string());
        }
        fn close(&self) {
            self.calls.lock().unwrap().push("closed".to_string());
        }
    }

    fn fields(v: &Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap_or_default()
    }

    /// `with-redaction.test.ts`: children consult the live registry and keep diagnostic error fields.
    #[test]
    fn children_consult_the_live_registry_and_pass_the_lifecycle_through() {
        let set = Arc::new(SecretSet::new());
        let secret = "fixture-with-redaction-0123456789";
        let target = Arc::new(Recorder::default());
        let logger = with_redaction(target.clone(), Arc::new(set.redactor(false, false)));
        let child = logger.child(&fields(&json!({"ordinary": secret, "public": 4096})));
        set.register(secret);
        child.warn(
            &format!("upstream {secret}"),
            &fields(&json!({"err": {"name": "Error", "message": format!("rejected {secret}"), "stack": "Error: rejected"}})),
        );
        let rows = target.rows.lock().unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!serde_json::to_string(&rows[0].2).unwrap().contains(secret));
        assert!(!rows[0].1.contains(secret));
        assert_eq!(rows[0].0, Level::Warn);
        assert_eq!(rows[0].2["public"], 4096);
        let err = &rows[0].2["err"];
        assert_eq!(err["name"], "Error");
        assert_eq!(err["message"], "rejected [REDACTED:secret]");
        assert!(err["stack"].as_str().unwrap().contains("Error"));
        drop(rows);
        logger.set_level(Level::Warn);
        logger.set_rotation(&json!({"maxBytes": 4096, "keep": 2}));
        logger.close();
        assert_eq!(
            *target.calls.lock().unwrap(),
            vec![
                "warn".to_string(),
                r#"{"keep":2,"maxBytes":4096}"#.to_string(),
                "closed".to_string()
            ]
        );
    }

    struct Failing;
    impl TextRedactor for Failing {
        #[allow(clippy::panic)]
        fn text(&self, _: &str) -> String {
            panic!("the redactor failed")
        }
        fn value(&self, v: &Value) -> Value {
            v.clone()
        }
    }

    #[test]
    fn a_failing_redactor_withholds_the_payload_and_never_stops_the_caller() {
        let target = Arc::new(Recorder::default());
        let logger = with_redaction(target.clone(), Arc::new(Failing));
        logger.info("raw message", &fields(&json!({"k": "raw field"})));
        let rows = target.rows.lock().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (rows[0].0, rows[0].1.as_str()),
            (Level::Error, WITHHELD_MESSAGE)
        );
        assert!(rows[0].2.is_empty());
    }

    #[test]
    fn the_fields_of_a_call_win_over_the_child_context() {
        let target = Arc::new(Recorder::default());
        let set = Arc::new(SecretSet::new());
        let logger = with_redaction(target.clone(), Arc::new(set.redactor(false, false)))
            .child(&fields(&json!({"a": 1, "b": 2})));
        logger.debug("m", &fields(&json!({"b": 3})));
        assert_eq!(
            Value::Object(target.rows.lock().unwrap()[0].2.clone()),
            json!({"a": 1, "b": 3})
        );
    }
}
