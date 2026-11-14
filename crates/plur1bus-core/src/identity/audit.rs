//! `identity/audit.ts`: the writer that puts the identity service's events into `logs/audit.log`, in the line shape the
//! CLI writes: `{ at, actor: { user, host }, action, target, detail }`, one JSON line, append-only, private to the user.
//! An event without an actor (a claim relayed by a channel adapter) is attributed to the core itself. No event carries a
//! pairing code: the service never hands one to the sink.
use super::service_impl::{AuditEvent, IdentityAudit};
use super::store::create_private;
use crate::rbac::audit::{audit_line, detail_redactor};
use plur1bus_log_schema::redact::Redactor;
use std::io::Write;
use std::path::{Path, PathBuf};

/// `createAuditWriter({ file, securePath, clock })`.
pub struct AuditWriter {
    file: PathBuf,
    secure_path: Box<dyn Fn(&Path)>,
    clock: Box<dyn Fn() -> i64>,
    secured: bool,
    redactor: Redactor,
}

impl AuditWriter {
    /// A writer for `file`. Fails when the redaction data cannot be read: nothing may be written then.
    pub fn new(
        file: PathBuf,
        secure_path: Box<dyn Fn(&Path)>,
        clock: Box<dyn Fn() -> i64>,
    ) -> Result<AuditWriter, String> {
        Ok(AuditWriter {
            file,
            secure_path,
            clock,
            secured: false,
            redactor: detail_redactor()?,
        })
    }

    /// The line of an event at `at`, without its newline.
    pub fn line(&self, at: i64, e: &AuditEvent) -> String {
        let (user, host) = e
            .actor
            .as_ref()
            .map_or(("core", "core"), |a| (a.user.as_str(), a.host.as_str()));
        audit_line(
            at,
            user,
            host,
            &e.action,
            &e.target,
            &e.detail,
            &self.redactor,
        )
    }
}

impl IdentityAudit for AuditWriter {
    fn emit(&mut self, e: &AuditEvent) -> Result<(), String> {
        let io = |e: std::io::Error| e.to_string();
        if !self.secured {
            // Once per writer: the private directory and file, then the host's port.
            create_private(&self.file).map_err(io)?;
            (self.secure_path)(&self.file);
            self.secured = true;
        }
        let line = format!("{}\n", self.line((self.clock)(), e));
        let mut open = std::fs::OpenOptions::new();
        open.append(true).create(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
        open.open(&self.file)
            .and_then(|mut f| f.write_all(line.as_bytes()))
            .map_err(io)
    }
}
