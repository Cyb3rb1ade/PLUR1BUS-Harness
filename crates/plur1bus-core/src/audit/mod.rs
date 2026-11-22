//! `packages/core/src/audit/` (P4-K K2, plan P4-21), the append half: the core's [`AuditSink`] over the hash-chained audit
//! file, and the rule that the audit line is written before the effect it records.
//!
//! The chain itself (line format, anchor, rotation, the writer lock that excludes the TypeScript core, crash recovery,
//! verification and reanchor) is `crates/plur1bus-audit`, which the CLI and the Rust core already share (P4-03); it is not
//! written a second time here. What `createAuditChain` adds on top is ported: the event must be recordable (a finite,
//! non-negative `at`), and its `detail` goes through the D111 redactor (`redactAuditDetail`) before it reaches the line.
//! `crates/plur1bus-core/tests/audit_chain_cross.rs` proves that the TypeScript verifier accepts what this sink writes, and
//! that a chain written in turns by the TypeScript core and by this sink stays one verified chain.
//!
//! **Nothing here runs in the product.** Not ported here (the K2 entry of the ledger): `verify` and `rotate` of the core's
//! chain object (the crate has `inspect`), the health read (`health.ts`), the owner notices (`notices.ts`) and the
//! `audit.*` RPC methods (`rpc.ts`): they are the surface of the flip (mode T).
use crate::logs::redact::TextRedactor;
use crate::rbac::audit::{AuditEvent, AuditSink};
use plur1bus_audit::chain::{append, Actor};
use serde_json::{json, Map, Value};
use std::path::PathBuf;

/// `audit-chain.jsonl`, the active chain file.
pub const ACTIVE_NAME: &str = "audit-chain.jsonl";
/// `audit-chain.anchor`, the pin of the newest line.
pub const ANCHOR_NAME: &str = "audit-chain.anchor";

/// The hash-chained audit file as an [`AuditSink`] (`createAuditChain({ dir }).append`).
pub struct ChainSink<'a> {
    dir: PathBuf,
    user: String,
    host: String,
    writer: String,
    redactor: &'a dyn TextRedactor,
}

impl<'a> ChainSink<'a> {
    /// A sink over the chain in `dir`. `user`, `host` and `writer` name this writer in the events the chain writes on its
    /// own behalf (an advanced anchor after an interrupted append).
    pub fn new(
        dir: PathBuf,
        user: &str,
        host: &str,
        writer: &str,
        redactor: &'a dyn TextRedactor,
    ) -> Self {
        ChainSink {
            dir,
            user: user.to_owned(),
            host: host.to_owned(),
            writer: writer.to_owned(),
            redactor,
        }
    }

    /// The `rec` of the chain line for `e`: the five members, the detail redacted.
    pub fn record_of(&self, e: &AuditEvent) -> Value {
        let detail: Map<String, Value> = e.detail.iter().cloned().collect();
        let redacted = match self.redactor.value(&Value::Object(detail)) {
            Value::Object(m) => Value::Object(m),
            _ => json!({}),
        };
        json!({ "at": e.at, "actor": { "user": e.user, "host": e.host }, "action": e.action, "target": e.target, "detail": redacted })
    }
}

impl AuditSink for ChainSink<'_> {
    fn append(&mut self, e: &AuditEvent) -> Result<(), String> {
        // `assertRecordable`: a negative time is not a time this chain records.
        if e.at < 0 {
            return Err("audit-chain: invalid event; refusing to record it".to_owned());
        }
        let actor = Actor {
            user: &self.user,
            host: &self.host,
            writer: &self.writer,
        };
        append(&self.dir, &actor, &self.record_of(e)).map_err(|err| format!("audit-chain: {err}"))
    }
}

/// The audit line before the effect: `effect` runs only after `sink` recorded `event`; when the sink refuses, the effect
/// does not run and the refusal is returned (fail closed).
pub fn recorded_then<T>(
    sink: &mut dyn AuditSink,
    event: &AuditEvent,
    effect: impl FnOnce() -> T,
) -> Result<T, String> {
    sink.append(event)?;
    Ok(effect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rbac::audit::detail_redactor;

    fn event(at: i64) -> AuditEvent {
        AuditEvent {
            at,
            user: "christian".into(),
            host: "h1".into(),
            action: "policy.decision".into(),
            target: "tool:fs.read".into(),
            detail: vec![
                ("rule".into(), json!("approval-class")),
                ("password".into(), json!("hunter2-hunter2")),
            ],
        }
    }

    #[test]
    fn the_detail_is_redacted_before_it_reaches_the_chain() {
        let r = detail_redactor().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut sink = ChainSink::new(dir.path().to_path_buf(), "core", "h1", "plur1bus-core", &r);
        sink.append(&event(1)).unwrap();
        let text = std::fs::read_to_string(dir.path().join(ACTIVE_NAME)).unwrap();
        assert!(!text.contains("hunter2"), "{text}");
        assert!(text.contains("approval-class"));
        assert!(dir.path().join(ANCHOR_NAME).exists());
    }

    #[test]
    fn no_effect_without_its_audit_line() {
        let mut refusing = |_: &AuditEvent| -> Result<(), String> { Err("disk full".into()) };
        let mut ran = false;
        assert!(recorded_then(&mut refusing, &event(1), || ran = true).is_err());
        assert!(!ran);
        let r = detail_redactor().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut sink = ChainSink::new(dir.path().to_path_buf(), "core", "h1", "plur1bus-core", &r);
        assert!(sink.append(&event(-1)).is_err());
        assert!(
            !dir.path().join(ACTIVE_NAME).exists(),
            "a refused event writes nothing"
        );
        assert_eq!(recorded_then(&mut sink, &event(2), || 7), Ok(7));
    }
}
