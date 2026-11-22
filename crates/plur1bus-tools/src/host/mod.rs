//! Hostctl catalog and gated operation boundary (P4-K K10b).
//! The library has no production entry point. Platform effects are explicit ports.

mod args;
mod catalog;
mod config;
mod eligibility;
/// Verified file operations for the native effect port.
pub mod filesystem;
pub mod native;
mod policy;
mod processes;
mod search;

#[cfg(test)]
mod tests;

pub use config::Config;
pub use eligibility::ProcessIdentity;
pub use policy::{HostClassifier, Policy};
pub use processes::{
    exec, session, signal_foreign, ForeignProcessPort, ProcessObservation, ProcessSessions,
    SessionPort,
};
pub use search::matches;

use crate::gate::{Allowed, ApprovedAction, Caller, Executor, Live};
use plur1bus_core::approvals::{AuditPort, Random};
use plur1bus_core::policy::decide::Clock;
use plur1bus_core::policy::fs_paths::{CanonicalPath, PathFs};
use serde_json::{json, Map, Value};
use std::io::{self, Write};
use uuid::Uuid;

/// A Hostctl failure envelope without sensitive input values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    /// The operation's stable failure code.
    pub code: &'static str,
    /// A short, safe explanation.
    pub hint: String,
}

impl Failure {
    fn new(code: &'static str, hint: impl Into<String>) -> Self {
        Self {
            code,
            hint: hint.into(),
        }
    }
    fn invalid(hint: impl Into<String>) -> Self {
        Self::new("INVALID_ARGUMENT", hint)
    }
    fn denied(hint: impl Into<String>) -> Self {
        Self::new("DENIED", hint)
    }
    fn outside() -> Self {
        Self::new("OUTSIDE_ROOT", "Use a path inside a configured local root.")
    }
    fn too_large(hint: impl Into<String>) -> Self {
        Self::new("TOO_LARGE", hint)
    }

    /// Encode the Hostctl wire failure.
    pub fn to_result(&self) -> Value {
        json!({"ok":false,"error":{"code":self.code,"hint":self.hint}})
    }
}

/// A redeemed operation and its canonical targets. The effect port must use the
/// provided path capability and the shared path layer when opening a file.
pub struct Invocation<'a> {
    /// Catalogued operation name.
    name: &'static str,
    /// Closed, validated arguments.
    args: &'a Map<String, Value>,
    /// Resolved targets in the catalogued argument order.
    paths: &'a [CanonicalPath],
    /// Canonical HTTP(S) URL for a web-open operation.
    url: Option<&'a str>,
    /// The authenticated owner of a process session.
    caller: &'a Caller,
    process_id: Option<Uuid>,
    visible_processes: &'a [Uuid],
    /// Maximum output bytes the adapter may retain.
    max_output_bytes: usize,
    max_search_results: usize,
    root_ids: &'a [&'a str],
    env_allow: &'a [String],
    shell_program: &'a str,
    /// Maximum operation lifetime.
    timeout_ms: u64,
    /// The caller's cancellation state.
    aborted: &'a dyn Fn() -> bool,
}

impl<'a> Invocation<'a> {
    /// The registered operation.
    pub fn name(&self) -> &'static str {
        self.name
    }
    /// The closed argument object.
    pub fn args(&self) -> &'a Map<String, Value> {
        self.args
    }
    /// The checked paths.
    pub fn paths(&self) -> &'a [CanonicalPath] {
        self.paths
    }
    /// An approved web URL, when present.
    pub fn url(&self) -> Option<&'a str> {
        self.url
    }
    /// The authenticated identity.
    pub fn caller(&self) -> &'a Caller {
        self.caller
    }
    /// IDs of the roots configured for this invocation.
    pub fn root_ids(&self) -> &[&str] {
        self.root_ids
    }
    /// The opaque registered process ID for an operation that uses one.
    pub fn process_id(&self) -> Option<Uuid> {
        self.process_id
    }
    /// Process IDs visible to this authenticated caller.
    pub fn visible_processes(&self) -> &[Uuid] {
        self.visible_processes
    }
    /// The output budget in bytes.
    pub fn max_output_bytes(&self) -> usize {
        self.max_output_bytes
    }
    /// The maximum duration in milliseconds.
    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms
    }
    /// Whether the call has been cancelled.
    pub fn aborted(&self) -> bool {
        (self.aborted)()
    }
}

/// Native effects run after validation, authorization and a recorded begin event.
pub trait Effects {
    /// The real harness process identity, checked before a foreign signal can be delegated.
    fn process_identity(&self) -> ProcessIdentity;
    /// Apply only the operation named by the invocation. A process start uses the
    /// supplied ID, and an error from a start leaves no running child.
    fn apply(&mut self, call: Invocation<'_>) -> Result<Value, Failure>;
}

/// The typestate executor for Hostctl operations.
pub struct Hostctl<'a, F> {
    /// The parsed Hostctl settings.
    pub config: &'a Config,
    /// Current filesystem and root policy.
    pub policy: &'a Policy<'a, F>,
    /// Clock for action expiry.
    pub clock: &'a dyn Clock,
    /// Random bytes for opaque process IDs.
    pub random: &'a dyn Random,
    /// Begin and result audit events.
    pub audit: &'a mut dyn AuditPort,
    /// The platform effect port.
    pub effects: &'a mut dyn Effects,
    /// Process ownership and admission shared by callers of this executor.
    pub processes: &'a mut ProcessSessions,
    /// Cancellation before, during and after the operation.
    pub aborted: &'a dyn Fn() -> bool,
}

impl<F: PathFs> Hostctl<'_, F> {
    /// The stable registration metadata used by the differential replay.
    pub fn definitions(config: &Config) -> Vec<Value> {
        catalog::definitions(config)
    }

    fn run(&mut self, approved: ApprovedAction, who: &Caller) -> Result<Value, Failure> {
        if !self.config.enabled {
            return Err(Failure::denied("Hostctl is disabled."));
        }
        use catalog::Operation as O;
        let spec = catalog::Spec::get(approved.tool())
            .ok_or_else(|| Failure::invalid("Choose a registered hostctl tool."))?;
        if approved.capability() != spec.capability {
            return Err(Failure::denied(
                "The approval names a different capability.",
            ));
        }
        if (self.aborted)() {
            return Err(Failure::new("ABORTED", "Cancelled."));
        }
        let raw = approved.args().clone();
        let input = args::validate(self.config, spec, &raw)?;
        eligibility::validate_runtime(
            spec.operation,
            input,
            self.config,
            who,
            self.effects.process_identity(),
        )?;
        if spec.operation == O::KillForeign && !matches!(approved.allowed(), Allowed::Approval(_)) {
            return Err(Failure::denied(
                "A separate approval is required for this process.",
            ));
        }
        let prepared = self.policy.prepare(spec.operation, input)?;
        let classification = prepared.classification();
        let targets = classification.targets.as_deref().unwrap_or_default();
        let expires_at = approved.expires_at();
        let action_hash = approved.action_hash().to_owned();
        approved
            .redeem(
                &Live {
                    tool: spec.name,
                    args: &raw,
                    targets,
                    hash_extra: classification.hash_extra.as_deref(),
                    caller: who,
                },
                self.clock,
            )
            .map_err(|_| Failure::new("CHANGED", "The approved operation changed or expired."))?;
        let audit_fields = |code| {
            let mut fields = json!({
                "operation": spec.name, "code": code, "actionHash": action_hash,
                "agentId": who.agent_id, "principal": who.principal, "sessionId": who.session_id
            });
            if !targets.is_empty() || prepared.url.is_some() {
                fields["targetHash"] = json!(classification.hash_extra);
            }
            if let Some(pid) = input.get("pid").and_then(Value::as_u64) {
                fields["pid"] = json!(pid);
            }
            if let Some(id) = input
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| Uuid::parse_str(id).ok())
            {
                fields["processId"] = json!(id.to_string());
            }
            fields
        };
        let denied = || Failure::denied("Audit is unavailable; no operation was performed.");
        if !self.audit.present() {
            return Err(denied());
        }
        self.audit
            .record("hostctl.begin", &audit_fields("START"))
            .map_err(|_| denied())?;
        let result = (|| {
            if (self.aborted)() {
                return Err(Failure::new("ABORTED", "Cancelled."));
            }
            let current = self.policy.prepare(spec.operation, input)?;
            if current.classification().hash_extra != classification.hash_extra {
                return Err(Failure::new(
                    "CHANGED",
                    "The target changed after approval.",
                ));
            }
            if !matches!(
                self.clock.now().partial_cmp(&expires_at),
                Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
            ) {
                return Err(Failure::new(
                    "CHANGED",
                    "The approval expired before the effect.",
                ));
            }
            let starting = matches!(spec.operation, O::Start | O::Exec | O::Shell);
            let process_id = if starting {
                let mut bytes = [0u8; 16];
                self.random.fill(&mut bytes);
                let id = uuid::Builder::from_random_bytes(bytes).into_uuid();
                self.processes.reserve(who, id)?;
                Some(id)
            } else if let Some(id) = input.get("id").and_then(Value::as_str) {
                Some(self.processes.owned(id, who)?)
            } else {
                None
            };
            let root_ids: Vec<_> = self
                .policy
                .roots
                .iter()
                .map(|root| root.id.as_str())
                .collect();
            let visible_processes = if spec.operation == O::ProcessList {
                self.processes.visible(who)?
            } else {
                Vec::new()
            };
            let applied = self.effects.apply(Invocation {
                name: spec.name,
                args: input,
                paths: &current.paths,
                url: current.url.as_deref(),
                caller: who,
                max_output_bytes: self.config.output_bytes as usize,
                max_search_results: self.config.max_results as usize,
                root_ids: &root_ids,
                env_allow: &self.config.env_allow,
                shell_program: &self.config.shell,
                timeout_ms: input
                    .get("timeoutMs")
                    .and_then(Value::as_f64)
                    .unwrap_or(self.config.timeout_ms) as u64,
                aborted: self.aborted,
                process_id,
                visible_processes: &visible_processes,
            });
            if let Some(id) = process_id {
                if starting && applied.is_err() {
                    self.processes.forget(id);
                } else if matches!(spec.operation, O::Exec | O::Shell)
                    || applied
                        .as_ref()
                        .ok()
                        .is_some_and(|result| result["running"] == false)
                {
                    self.processes.finished(id);
                }
            }
            let mut result = applied?;
            if let Some(id) = process_id.filter(|_| spec.operation != O::WriteStdin) {
                result
                    .as_object_mut()
                    .ok_or_else(|| Failure::new("IO_ERROR", "Invalid process result."))?
                    .insert("id".to_owned(), json!(id.to_string()));
            }
            if spec.operation == O::ProcessList {
                result = self.processes.filter_owned(result, who)?;
                for item in result["processes"].as_array().into_iter().flatten() {
                    if item["running"] == false {
                        if let Some(id) =
                            item["id"].as_str().and_then(|id| Uuid::parse_str(id).ok())
                        {
                            self.processes.finished(id);
                        }
                    }
                }
            }
            let max = (self.config.output_bytes * 2.0 + 4096.0).min(1_048_576.0) as usize;
            serde_json::to_writer(ByteLimit(max), &result)
                .map_err(|_| Failure::too_large("The result exceeds its byte limit."))?;
            Ok(result)
        })();
        let code = result
            .as_ref()
            .map_or_else(|error: &Failure| error.code, |_| "OK");
        self.audit
            .record("hostctl.end", &audit_fields(code))
            .map_err(|_| Failure::new("IO_ERROR", "The operation result could not be recorded."))?;
        result
    }
}

impl<F: PathFs> Executor for Hostctl<'_, F> {
    type Output = Result<Value, Failure>;
    fn execute(&mut self, approved: ApprovedAction, who: &Caller) -> Self::Output {
        self.run(approved, who)
    }
}

struct ByteLimit(usize);

impl Write for ByteLimit {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(input.len())
            .ok_or_else(|| io::Error::from(io::ErrorKind::FileTooLarge))?;
        Ok(input.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
