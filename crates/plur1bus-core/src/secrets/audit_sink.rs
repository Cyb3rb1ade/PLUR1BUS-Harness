//! `createFileAuditSink` of `secrets/audit.ts`: the store's audit records in the hash chain and in `logs/audit.log`
//! (P4-20 flip B).
//!
//! One record, two places, in the order TypeScript writes them: the chain (`audit-chain.jsonl`, under the lock both
//! cores take) and then one line of `logs/audit.log`. Both are tried. When either fails the record is not durable, and
//! the store releases and changes nothing ([`SecretError::audit_unavailable`]).
//!
//! The record is `{ at, actor: { user, host }, action, target, detail }`. `target` is `null` for a call without a
//! name. `detail` is what [`sanitize_detail`] keeps, through the redactor of the store's registry: `reason` and
//! `purpose` are free text of a caller and must not carry a value.
//!
//! What differs from TypeScript, and changes no record:
//! - TypeScript passes the detail through a second registry of the sink itself (`registerSecret`), which nothing in
//!   the core fills. There is one pass here.
//! - The line of `logs/audit.log` has the bytes `JSON.stringify` gives. The chain writes its record with the members
//!   in the order of `serde_json` (as for the records of P4-12); a reader of the chain parses the line.
use super::audit::{actor_user, detail_to_json, sanitize_detail};
use super::error::SecretError;
use super::store::{AuditEvent, AuditSink};
use crate::js::json_stringify;
use crate::logs::redact::TextRedactor;
use crate::logs::sink::default_secure_path;
use crate::rbac::audit::redacted_detail;
use plur1bus_audit::chain;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The file of the line copy, inside the directory of the logs.
pub const AUDIT_LOG: &str = "audit.log";

/// The audit sink of a store that owns its files: the chain and `logs/audit.log`.
pub struct FileAuditSink {
    logs: PathBuf,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    redactor: Box<dyn TextRedactor>,
    os_user: String,
    host: String,
}

impl FileAuditSink {
    /// A sink for the directory `logs` (`<home>/logs`). `clock` is `Date.now()`; `redactor` is the redactor of the
    /// store's registry. The user of an owner without an id and the host are those of this process
    /// (`userInfo().username`, `hostname()`).
    pub fn new(
        logs: PathBuf,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        redactor: Box<dyn TextRedactor>,
    ) -> FileAuditSink {
        let os_user = Some(whoami::username())
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| "unknown".to_owned());
        let host = plur1bus_rpc::process::hostname()
            .ok()
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| "localhost".to_owned());
        FileAuditSink {
            logs,
            clock,
            redactor,
            os_user,
            host,
        }
    }

    /// The same sink with a given user and host (tests compare whole lines).
    pub fn with_identity(mut self, os_user: &str, host: &str) -> FileAuditSink {
        self.os_user = os_user.to_owned();
        self.host = host.to_owned();
        self
    }

    /// The line of `logs/audit.log` for a record: one `O_APPEND` write, fsynced, private to the user.
    fn append_line(&self, line: &str) -> std::io::Result<()> {
        // The directory of the logs exists by the time a store runs (the chain made it, or the log writer did).
        std::fs::create_dir_all(&self.logs)?;
        let path = self.logs.join(AUDIT_LOG);
        let mut open = std::fs::OpenOptions::new();
        open.append(true).create(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
        let mut file = open.open(&path)?;
        let _ = default_secure_path(&path, 0o600);
        file.write_all(line.as_bytes())?;
        file.sync_all()
    }
}

/// The record as the text of `JSON.stringify` and as a value for the chain.
fn record_of(
    at: i64,
    user: &str,
    host: &str,
    event: &AuditEvent,
    redactor: &dyn TextRedactor,
) -> Result<(String, Value), serde_json::Error> {
    let sanitized = sanitize_detail(Some(&event.detail));
    let pairs: Vec<(String, Value)> = match detail_to_json(&sanitized) {
        // `detail_to_json` gives a map, which has lost the order `sanitize_detail` wrote: read it back in that order.
        Value::Object(map) => sanitized
            .iter()
            .filter_map(|(key, _)| map.get(*key).map(|v| ((*key).to_owned(), v.clone())))
            .collect(),
        _ => Vec::new(),
    };
    let detail = redacted_detail(&pairs, redactor);
    let action = event.action.as_str();
    let target = match &event.target {
        Some(name) => json_stringify(name),
        None => "null".to_owned(),
    };
    let line = format!(
        "{{\"at\":{at},\"actor\":{{\"user\":{},\"host\":{}}},\"action\":{},\"target\":{target},\"detail\":{detail}}}",
        json_stringify(user),
        json_stringify(host),
        json_stringify(action),
    );
    let record = json!({ "at": at, "actor": { "user": user, "host": host }, "action": action,
        "target": event.target, "detail": serde_json::from_str::<Value>(&detail)? });
    Ok((line, record))
}

impl AuditSink for FileAuditSink {
    fn record(&mut self, event: &AuditEvent) -> Result<(), SecretError> {
        let user = actor_user(&event.principal, &self.os_user);
        let Ok((line, record)) = record_of(
            (self.clock)(),
            &user,
            &self.host,
            event,
            self.redactor.as_ref(),
        ) else {
            return Err(SecretError::audit_unavailable());
        };
        // Who writes, for the events the chain adds on its own behalf (`actorOfThisProcess` of `audit/chain.ts`).
        let actor = chain::Actor {
            user: &self.os_user,
            host: &self.host,
            writer: "core",
        };
        let chained = chain::append(&self.logs, &actor, &record);
        let written = self.append_line(&format!("{line}\n"));
        match (chained, written) {
            (Ok(()), Ok(())) => Ok(()),
            _ => Err(SecretError::audit_unavailable()),
        }
    }
}

/// The path of the line copy for a directory of logs.
pub fn audit_log_path(logs: &Path) -> PathBuf {
    logs.join(AUDIT_LOG)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::utf16;
    use crate::logs::redact::SecretSet;
    use crate::secrets::audit::{AuditAction, DetailValue};
    use crate::secrets::error::SecretErrorCode;
    use crate::secrets::types::SecretPrincipal;

    const AT: i64 = 1_767_323_045_678;

    fn sink(logs: &Path, set: &Arc<SecretSet>) -> FileAuditSink {
        FileAuditSink::new(
            logs.to_owned(),
            Arc::new(|| AT),
            Box::new(set.redactor(false, false)),
        )
        .with_identity("alex", "host-1")
    }

    fn text(s: &str) -> DetailValue {
        DetailValue::Str(utf16(s))
    }

    fn event(
        action: AuditAction,
        target: Option<&str>,
        principal: SecretPrincipal,
        detail: Vec<(&str, DetailValue)>,
    ) -> AuditEvent {
        AuditEvent {
            action,
            target: target.map(str::to_owned),
            principal,
            detail: detail.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
        }
    }

    fn log_lines(logs: &Path) -> Vec<String> {
        std::fs::read_to_string(audit_log_path(logs))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// The `rec` of every chain line that is a secret's record (the chain adds events of its own).
    fn chain_records(logs: &Path) -> Vec<Value> {
        std::fs::read_to_string(logs.join(chain::ACTIVE))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap()["rec"].clone())
            .filter(|rec| {
                rec["action"]
                    .as_str()
                    .is_some_and(|a| a.starts_with("secret."))
            })
            .collect()
    }

    #[test]
    fn a_record_is_one_line_of_the_log_and_one_record_of_the_chain() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        let set = Arc::new(SecretSet::new());
        let mut sink = sink(&logs, &set);
        // The detail in an order of the caller's, with a key the whitelist does not know.
        sink.record(&event(
            AuditAction::Lease,
            Some("api.key"),
            SecretPrincipal::Core,
            vec![
                ("ttlMs", DetailValue::Num(5000.into())),
                ("value", text("never written")),
                ("leaseId", text("lse-one")),
                ("profileId", text("web-search")),
                ("purpose", text("web-search")),
            ],
        ))
        .unwrap();
        let lines = log_lines(&logs);
        // The bytes `JSON.stringify` gives: the five members, the detail in the order of the whitelist.
        assert_eq!(
            lines,
            [format!(
                "{{\"at\":{AT},\"actor\":{{\"user\":\"core\",\"host\":\"host-1\"}},\"action\":\"secret.lease\",\"target\":\"api.key\",\"detail\":{{\"purpose\":\"web-search\",\"profileId\":\"web-search\",\"leaseId\":\"lse-one\",\"ttlMs\":5000}}}}"
            )]
        );
        // The chain holds the same record.
        let line: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(chain_records(&logs), [line]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(audit_log_path(&logs))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_call_without_a_name_has_a_null_target_and_the_actor_follows_the_principal() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        let set = Arc::new(SecretSet::new());
        let mut sink = sink(&logs, &set);
        let owner = |id: Option<&str>| SecretPrincipal::Owner {
            id: id.map(str::to_owned),
            surface: None,
        };
        let agent = |id: Option<&str>| SecretPrincipal::Agent {
            agent_id: id.map(str::to_owned),
        };
        for principal in [
            owner(None),
            owner(Some("user-1")),
            agent(None),
            agent(Some("scout")),
        ] {
            sink.record(&event(
                AuditAction::List,
                None,
                principal,
                vec![("backend", text("file"))],
            ))
            .unwrap();
        }
        let lines = log_lines(&logs);
        let users: Vec<String> = ["alex", "user-1", "agent:unknown", "agent:scout"]
            .iter()
            .map(|user| {
                format!(
                    "{{\"at\":{AT},\"actor\":{{\"user\":\"{user}\",\"host\":\"host-1\"}},\"action\":\"secret.list\",\"target\":null,\"detail\":{{\"backend\":\"file\"}}}}"
                )
            })
            .collect();
        assert_eq!(lines, users);
        let chained = chain_records(&logs);
        assert_eq!(chained.len(), 4);
        assert!(chained.iter().all(|rec| rec["target"].is_null()));
        // A record without a detail has an empty one, not a missing one.
        sink.record(&event(
            AuditAction::Get,
            Some("api.key"),
            SecretPrincipal::Core,
            vec![],
        ))
        .unwrap();
        assert!(log_lines(&logs)[4].ends_with("\"target\":\"api.key\",\"detail\":{}}"));
    }

    #[test]
    fn a_value_the_registry_knows_does_not_reach_either_place() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        let set = Arc::new(SecretSet::new());
        let value = "plain words that are a registered value";
        set.register(value);
        let mut sink = sink(&logs, &set);
        sink.record(&event(
            AuditAction::Denied,
            None,
            SecretPrincipal::Core,
            vec![
                ("reason", text(&format!("the caller wrote {value} here"))),
                ("purpose", text(value)),
                ("method", text("lease")),
            ],
        ))
        .unwrap();
        let line = &log_lines(&logs)[0];
        let chain = std::fs::read_to_string(logs.join(chain::ACTIVE)).unwrap();
        assert!(!line.contains(value) && !chain.contains(value));
        assert!(line.contains("the caller wrote ") && line.contains("\"method\":\"lease\""));
        // A value registered after the sink was made is masked too: the redactor is the live one.
        let later = "another value, registered later on";
        set.register(later);
        sink.record(&event(
            AuditAction::Denied,
            None,
            SecretPrincipal::Core,
            vec![("reason", text(later))],
        ))
        .unwrap();
        assert!(!std::fs::read_to_string(audit_log_path(&logs))
            .unwrap()
            .contains(later));
        assert!(!std::fs::read_to_string(logs.join(chain::ACTIVE))
            .unwrap()
            .contains(later));
    }

    #[test]
    fn both_places_are_tried_and_one_that_fails_is_an_audit_that_is_not_available() {
        let set = Arc::new(SecretSet::new());
        let lease = || {
            event(
                AuditAction::Set,
                Some("api.key"),
                SecretPrincipal::Core,
                vec![("backend", text("file"))],
            )
        };
        // The line cannot be written: the chain has the record all the same, and the store is told.
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(audit_log_path(&logs)).unwrap();
        let refused = sink(&logs, &set).record(&lease()).unwrap_err();
        assert_eq!(refused.code, SecretErrorCode::AuditUnavailable);
        assert_eq!(chain_records(&logs).len(), 1);
        // The chain cannot be written: the line is there all the same, and the store is told.
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(logs.join(chain::ACTIVE)).unwrap();
        let refused = sink(&logs, &set).record(&lease()).unwrap_err();
        assert_eq!(refused.code, SecretErrorCode::AuditUnavailable);
        assert_eq!(log_lines(&logs).len(), 1);
        // Neither: nothing is written and the store is told.
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::write(&logs, "a file where the directory should be").unwrap();
        let refused = sink(&logs, &set).record(&lease()).unwrap_err();
        assert_eq!(refused.code, SecretErrorCode::AuditUnavailable);
    }
}
