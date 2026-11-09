//! Foreground, actual-source conflict logging. Both source memories remain unchanged.
pub use super::conflict_summary::ConflictSummary;
use super::{
    conflict_file as io, conflict_summary,
    memory::{valid_id, MemoryReader},
};
use crate::{
    context::{is_user_principal, RequestContext},
    contract::{AgentContext, Cancel, EngineError, Principal, StoreError},
    neo::capture_journal::CaptureJournal,
    store::{directory::TrustedDirectory, shared_row::MemoryRecord},
    text::{js::JsString, json::parse_json},
};
use chrono::SecondsFormat;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
#[cfg(feature = "testkit")]
type ApplicationObserver = Arc<dyn Fn(&str) -> Result<(), EngineError> + Send + Sync>;
const LOG: &str = "conflict-log.jsonl";
/// Only observations that retain both rows; applying a resolution is a separate confirmed operation.
#[derive(Clone, Copy, Debug)]
pub enum MergeDecision {
    /// Both actual rows were retained after the merge decision.
    StoredSeparately,
    /// No merge-model call was made; both rows remain independent.
    NoMergeLlmCall,
}
impl MergeDecision {
    fn name(self) -> &'static str {
        match self {
            Self::StoredSeparately => "stored_separately",
            Self::NoMergeLlmCall => "no_merge_llm_call",
        }
    }
}
/// Expected actual source snapshots, never an alternate authority supplied by their fields.
pub struct ConflictRequest {
    /// Stable host operation identity, scoped to the current owner/agent/workspace.
    pub operation_id: uuid::Uuid,
    /// The actual newly stored private source, including shared-column metadata.
    pub new: MemoryRecord,
    /// The actual other visible source; it can be a properly authorized shared card.
    pub existing: MemoryRecord,
    /// The caller's finite similarity observation in [0, 1].
    pub score: f64,
    /// Observed merge outcome; this does not apply a resolution.
    pub decision: MergeDecision,
}
/// Uses the existing read/lifecycle boundary and the shared native/Node workspace writer leases.
pub struct ConflictLedger {
    reader: Arc<MemoryReader>,
    journal: Arc<CaptureJournal>,
    #[cfg(feature = "testkit")]
    application_observer: Option<ApplicationObserver>,
}
impl ConflictLedger {
    /// Bind existing source/lifecycle and workspace-policy services without writing files.
    pub fn new(reader: Arc<MemoryReader>, journal: Arc<CaptureJournal>) -> Self {
        Self {
            reader,
            journal,
            #[cfg(feature = "testkit")]
            application_observer: None,
        }
    }
    fn transaction<T>(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        action: impl FnOnce(
            &TrustedDirectory,
            &RequestContext,
            &dyn Fn() -> Result<(), EngineError>,
        ) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        self.transaction_with_journal(
            principal,
            agent,
            cancel,
            |workspace, dir, _, _, ctx, check| {
                super::conflict_application_state::guard_pending(dir, cancel)?;
                action(workspace, ctx, check)
            },
        )
    }
    fn transaction_with_journal<T>(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        action: impl FnOnce(
            &TrustedDirectory,
            &TrustedDirectory,
            &crate::text::json::TolerantJsonValue,
            &str,
            &RequestContext,
            &dyn Fn() -> Result<(), EngineError>,
        ) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        cancel.check()?;
        let operation = self.reader.context.enter(principal, agent)?;
        let ctx = &operation.context;
        if !is_user_principal(&ctx.owner_user_id) {
            return Err(StoreError::InvalidInput.into());
        }
        let workspace = TrustedDirectory::open(&self.reader.context.destructive_workspace(ctx)?)?;
        let base = TrustedDirectory::open(&self.reader.base)?;
        let _gate = self.reader.context.mutation()?;
        let check = || -> Result<(), EngineError> {
            cancel.check()?;
            self.reader.context.assert_open()?;
            workspace.assert_unchanged()?;
            base.assert_unchanged()?;
            if RequestContext::build(principal, agent, self.reader.context.host())? != *ctx
                || self
                    .reader
                    .context
                    .host()
                    .workspace_dir(&ctx.agent_id)?
                    .as_deref()
                    != Some(workspace.path())
            {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(())
        };
        self.journal.with_conflict_application_writer(
            principal,
            agent,
            ctx,
            cancel,
            &check,
            |dir, proof, binding, current| action(&workspace, dir, proof, binding, ctx, current),
        )
    }
    fn sources(&self, request: &ConflictRequest, ctx: &RequestContext) -> Result<(), EngineError> {
        let now = self.reader.context.host().now_ms();
        for expected in [&request.new, &request.existing] {
            let current = self
                .reader
                .find_visible_record(&expected.row.id, ctx, now)?;
            if serde_json::to_value(&current.row).map_err(|_| StoreError::Corrupt)?
                != serde_json::to_value(&expected.row).map_err(|_| StoreError::Corrupt)?
                || current.sharing != expected.sharing
            {
                return Err(StoreError::InvalidInput.into());
            }
        }
        let new = &request.new.row;
        if new.scope != "agent-private"
            || new.agent_id != ctx.agent_id.as_str()
            || new.stored_by != ctx.agent_id.as_str()
            || new.owner_user_id != ctx.owner_user_id
            || new.workspace_key != ctx.workspace_key
        {
            return Err(StoreError::InvalidInput.into());
        }
        let visibility = crate::neo::acl::derive(
            &[request.new.row.clone(), request.existing.row.clone()],
            ctx,
        )?;
        if visibility.scope != "agent_private" || request.existing.row.owner_user_id.is_empty() {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(())
    }
    /// Persist an immutable observed pair. A stable operation UUID makes exact concurrent retries idempotent.
    /// Source CAS and current ACL/policy are rechecked even for retries; no memory row is updated/deleted.
    pub fn record(
        &self,
        request: &ConflictRequest,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if request.operation_id.is_nil()
            || !valid_id(&request.new.row.id)
            || !valid_id(&request.existing.row.id)
            || request.new.row.id == request.existing.row.id
            || !request.score.is_finite()
            || !(0. ..=1.).contains(&request.score)
        {
            return Err(StoreError::InvalidInput.into());
        }
        self.transaction(principal, agent, cancel, |workspace, ctx, check| {
            self.sources(request, ctx)?;
            check()?;
            let dir = workspace.create_child(".adaptive-learning")?;
            let old = io::read(&dir, LOG, io::MAX_BYTES, cancel)?;
            let mut rows = io::records(old.as_deref().unwrap_or(&[]))?;
            let digest = request_digest(request)?;
            let operation = request.operation_id.to_string();
            let prior = rows
                .iter()
                .filter(|(v, _)| owned(v, ctx) && v["operationId"] == operation)
                .collect::<Vec<_>>();
            if prior.iter().any(|(v, _)| v["requestDigest"] != digest) {
                return Err(StoreError::InvalidInput.into());
            }
            let now = timestamp(self.reader.context.host().now_ms())?;
            let cache_name = cache_name(ctx)?;
            let cache = io::read(&dir, &cache_name, 1024 * 1024, cancel)?;
            let mut bytes = old.clone().unwrap_or_default();
            if prior.is_empty() {
                let row = json!({
                    "schemaVersion": 1, "timestamp": now,
                    "newMemoryId": request.new.row.id,
                    "newAgentId": request.new.row.stored_by,
                    "newText": cut(&request.new.row.text),
                    "existingMemoryId": request.existing.row.id,
                    "existingAgentId": request.existing.row.stored_by,
                    "existingText": cut(&request.existing.row.text),
                    "score": request.score, "category": request.new.row.category,
                    "mergeDecision": request.decision.name(), "operationId": operation,
                    "requestDigest": digest, "scope": "agent_private",
                    "agentId": ctx.agent_id.as_str(), "ownerUserId": ctx.owner_user_id,
                    "workspaceKey": ctx.workspace_key
                });
                let mut line = serde_json::to_vec(&row).map_err(|_| StoreError::Corrupt)?;
                line.push(b'\n');
                if line.len() > 1024 * 1024
                    || bytes.len() + line.len() > io::MAX_BYTES
                    || rows.len() == io::MAX_ROWS
                {
                    return Err(StoreError::InvalidInput.into());
                }
                rows.push((row, line.len()));
                bytes.extend(line);
            }
            let summary =
                conflict_summary::summarize(rows.iter().filter(|(v, _)| owned(v, ctx)), now);
            let cached = json!({
                "scope": "agent_private", "agentId": ctx.agent_id.as_str(),
                "ownerUserId": ctx.owner_user_id, "workspaceKey": ctx.workspace_key,
                "logSha256": hash(&bytes), "summary": summary
            });
            let mut cached = serde_json::to_vec(&cached).map_err(|_| StoreError::Corrupt)?;
            cached.push(b'\n');
            let current = || {
                check()?;
                self.sources(request, ctx)
            };
            if old.as_deref() != Some(bytes.as_slice()) {
                io::replace(&dir, LOG, old.as_deref(), &bytes, cancel, &current)?;
            } else {
                current()?;
                dir.sync_file_durable(LOG)?;
            }
            io::replace(
                &dir,
                &cache_name,
                cache.as_deref(),
                &cached,
                cancel,
                &current,
            )?;
            current()
        })
    }

    /// Derive from complete authorized rows. A stale/forged/missing cache never supplies counts.
    pub fn summary(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<ConflictSummary, EngineError> {
        self.transaction(principal, agent, cancel, |workspace, ctx, check| {
            let dir = match workspace.open_child(".adaptive-learning") {
                Ok(v) => Some(v),
                Err(StoreError::Io {
                    kind: std::io::ErrorKind::NotFound,
                }) => None,
                Err(e) => return Err(e.into()),
            };
            let bytes = dir
                .as_ref()
                .map(|d| io::read(d, LOG, io::MAX_BYTES, cancel))
                .transpose()?
                .flatten()
                .unwrap_or_default();
            let rows = io::records(&bytes)?;
            check()?;
            Ok(conflict_summary::summarize(
                rows.iter().filter(|(v, _)| owned(v, ctx)),
                timestamp(self.reader.context.host().now_ms())?,
            ))
        })
    }
}
fn owned(v: &Value, ctx: &RequestContext) -> bool {
    v["scope"] == "agent_private"
        && v["ownerUserId"] == ctx.owner_user_id
        && v["agentId"] == ctx.agent_id.as_str()
        && v["workspaceKey"] == ctx.workspace_key
        && parse_json(&v.to_string()).is_ok_and(|v| crate::neo::acl::visible(&v, Some(ctx)))
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn cache_name(ctx: &RequestContext) -> Result<String, EngineError> {
    Ok(format!(
        "native-conflict-review-summary-{}.json",
        hash(
            &serde_json::to_vec(&json!([
                ctx.agent_id.as_str(),
                ctx.owner_user_id,
                ctx.workspace_key
            ]))
            .map_err(|_| StoreError::Corrupt)?
        )
    ))
}
fn timestamp(now: i64) -> Result<String, EngineError> {
    Ok(chrono::DateTime::from_timestamp_millis(now)
        .ok_or(StoreError::InvalidInput)?
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}
fn cut(value: &str) -> String {
    let mut units = JsString::from(value).utf16_slice(0, 200).into_utf16_units();
    if units.last().is_some_and(|u| (0xd800..=0xdbff).contains(u)) {
        units.pop();
    }
    JsString::from_utf16_units(units).to_utf8_lossy()
}

fn request_digest(request: &ConflictRequest) -> Result<String, EngineError> {
    Ok(hash(
        &serde_json::to_vec(&json!({
            "new":request.new.row,"newSharing":request.new.sharing,
            "existing":request.existing.row,"existingSharing":request.existing.sharing,
            "score":request.score,"decision":request.decision.name()
        }))
        .map_err(|_| StoreError::Corrupt)?,
    ))
}
#[path = "conflict_resolution_store.rs"]
mod resolutions;
pub use resolutions::ResolutionRequest;

#[path = "conflict_application_plan.rs"]
mod applications;
pub use applications::{
    ApplicationAuthorization, ApplicationPlan, ApplicationRequest, ApplicationResult,
    ConfirmationCheck, ConfirmationVerifier,
};
