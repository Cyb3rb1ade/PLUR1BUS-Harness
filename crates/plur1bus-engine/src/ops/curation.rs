//! Frozen human curation facade over original-caller C4 reads and audit-first revisions.
use super::context::{error, OperationContext};
use crate::{
    context::RequestContext,
    contract::{
        limits::{validate_input, ValidationOptions},
        AgentContext, Cancel, EngineError, MemoryCurationAction, MemoryCurationListQuery,
        MemoryCurationListResult, MemoryCurationOps, MemoryCurationResolveResult,
        MemoryOpErrorCode, Principal,
    },
    neo::{
        capture_journal::CaptureJournal,
        revisions::{Action, RevisionRequest, RevisionStore},
    },
    store::directory::TrustedDirectory,
    text::{
        js::{js_trim, JsString},
        json::{write_json, TolerantJsonValue as Json},
    },
};
use std::sync::Arc;
#[cfg(feature = "testkit")]
type Observer = Arc<dyn Fn(&str) -> Result<(), EngineError> + Send + Sync>;
/// Native implementation; construction grants nothing and does not activate ProcessEngine flags.
/// The supplied journal must enforce human-operation policy, separately from automatic capture.
pub struct NativeCuration {
    context: Arc<OperationContext>,
    journal: Arc<CaptureJournal>,
    writer: RevisionStore,
}
impl NativeCuration {
    /// Share the real operation lifecycle and human writer; no filesystem action at construction.
    pub fn new(context: Arc<OperationContext>, journal: Arc<CaptureJournal>) -> Self {
        let writer = RevisionStore::new(journal.clone(), context.host_handle());
        Self {
            context,
            journal,
            writer,
        }
    }
    /// Test-only durable-stage fault injection, never a production authority switch.
    #[cfg(feature = "testkit")]
    pub fn with_observer(mut self, observer: Observer) -> Self {
        self.writer = self.writer.with_observer(observer);
        self
    }
    fn check(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        ctx: &RequestContext,
        workspace: &TrustedDirectory,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        cancel.check()?;
        self.context.assert_open()?;
        workspace.assert_unchanged()?;
        if RequestContext::build(principal, agent, self.context.host())? != *ctx {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        let _ = self
            .journal
            .curation_reader(principal, agent, ctx, cancel)?;
        Ok(())
    }
    /// Typed list with explicit cancellation. Invalid legacy Unicode or result shape is refused;
    /// identifiers/text are never silently replaced and raw JSON never bypasses the frozen facade.
    pub fn list_with_cancel(
        &self,
        query: &MemoryCurationListQuery,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<MemoryCurationListResult, EngineError> {
        cancel.check()?;
        let operation = self.context.enter(principal, agent)?;
        let ctx = &operation.context;
        let path = self.context.destructive_workspace(ctx)?;
        let limit = query
            .limit
            .as_ref()
            .map(|n| {
                n.as_f64()
                    .ok_or_else(|| error(MemoryOpErrorCode::InvalidInput))
            })
            .transpose()?;
        let _ = crate::neo::curation::list(&[], &[], ctx, limit, cancel)?;
        let workspace = TrustedDirectory::open(&path)?;
        let reader = self
            .journal
            .curation_reader(principal, agent, ctx, cancel)?;
        let raw = reader.read_curation(limit, ctx, cancel)?;
        self.check(principal, agent, ctx, &workspace, cancel)?;
        serde_json::from_str(&write_json(&raw)).map_err(|_| error(MemoryOpErrorCode::Storage))
    }
    /// Resolve the actual newest visible record. A source change before the locked CAS refuses;
    /// recovery retains the original caller, audit mode and frozen revision without a new decision.
    pub fn resolve_with_cancel(
        &self,
        id: &str,
        action: MemoryCurationAction,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<MemoryCurationResolveResult, EngineError> {
        cancel.check()?;
        let operation = self.context.enter(principal, agent)?;
        let ctx = &operation.context;
        let path = self.context.destructive_workspace(ctx)?;
        validate_input(
            Some(id),
            ValidationOptions {
                max_length: Some(200),
                name: "curation id",
                required: true,
                ..Default::default()
            },
        )
        .map_err(|_| error(MemoryOpErrorCode::InvalidInput))?;
        if js_trim(id).is_empty() {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let workspace = TrustedDirectory::open(&path)?;
        let _gate = self.context.mutation()?;
        let reader = self
            .journal
            .curation_reader(principal, agent, ctx, cancel)?;
        let expected=reader.curation_records(ctx,cancel)?.into_iter().find(|row|matches!(row,Json::Object(fields) if fields.iter().any(|(key,value)|key==&JsString::from("id")&&value==&Json::String(id.into())))).ok_or_else(||error(MemoryOpErrorCode::NotFound))?;
        let action = match action {
            MemoryCurationAction::Keep => Action::Keep,
            MemoryCurationAction::Drop => Action::Drop,
        };
        let check = || self.check(principal, agent, ctx, &workspace, cancel);
        check()?;
        self.writer.apply_curation_checked(
            principal,
            agent,
            &RevisionRequest {
                operation_id: uuid::Uuid::new_v4(),
                expected,
                action,
            },
            cancel,
            &check,
        )?;
        Ok(MemoryCurationResolveResult {
            id: id.into(),
            ok: true,
            status: Some(
                if action == Action::Keep {
                    "promoted"
                } else {
                    "demoted"
                }
                .into(),
            ),
            reason: None,
        })
    }
}
impl MemoryCurationOps for NativeCuration {
    fn list(
        &self,
        query: MemoryCurationListQuery,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCurationListResult, EngineError> {
        self.list_with_cancel(&query, principal, agent, &Cancel::never())
    }
    fn resolve(
        &self,
        id: &str,
        action: MemoryCurationAction,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCurationResolveResult, EngineError> {
        self.resolve_with_cancel(id, action, principal, agent, &Cancel::never())
    }
}
