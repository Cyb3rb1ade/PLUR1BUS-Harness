//! Actual-source proposal publication and authorized lookup; no confirmation is inferred here.
use super::*;
use crate::{
    capture::conflict_resolution,
    text::json::{write_json, TolerantJsonValue as Json},
};
const RESOLVED: &str = "conflict-resolved.jsonl";
/// One proposal for an already durable observed pair, never a request to apply its content.
pub struct ResolutionRequest<'a> {
    /// Stable proposal operation identity for exact retries.
    pub operation_id: uuid::Uuid,
    /// Original observed pair, including actual source snapshots and observation identity.
    pub conflict: &'a ConflictRequest,
    /// Bounded untrusted recommendation fields. They cannot grant permissions.
    pub decision: &'a Json,
}
impl ConflictLedger {
    /// Persist a recommendation only after current source CAS and its actual owned observation.
    /// Both memories remain unchanged; applying any proposal requires a separate bound confirmation.
    pub fn propose_resolution(
        &self,
        request: &ResolutionRequest<'_>,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        if request.operation_id.is_nil() {
            return Err(StoreError::InvalidInput.into());
        }
        self.transaction(principal, agent, cancel, |workspace, ctx, check| {
            self.sources(request.conflict, ctx)?;
            check()?;
            let dir = workspace.open_child(".adaptive-learning")?;
            let observed =
                io::read(&dir, LOG, io::MAX_BYTES, cancel)?.ok_or(StoreError::InvalidInput)?;
            let observations = io::records(&observed)?;
            let digest = request_digest(request.conflict)?;
            let original = observations
                .iter()
                .rev()
                .find(|(v, _)| {
                    owned(v, ctx) && v["operationId"] == request.conflict.operation_id.to_string()
                })
                .map(|(v, _)| v)
                .ok_or(StoreError::InvalidInput)?;
            validate_original(original, request.conflict)?;
            if original["requestDigest"] != digest {
                return Err(StoreError::InvalidInput.into());
            }
            let original_json =
                parse_json(&original.to_string()).map_err(|_| StoreError::Corrupt)?;
            let proposed = conflict_resolution::proposal(
                &original_json,
                request.decision,
                self.reader.context.host().now_ms(),
                cancel,
            )?;
            let mut row: Value = serde_json::from_str(&write_json(&proposed))
                .map_err(|_| StoreError::InvalidInput)?;
            row["operationId"] = json!(request.operation_id.to_string());
            row["sourceDigest"] = json!(digest);
            row["decisionDigest"] = json!(hash(write_json(request.decision).as_bytes()));
            row["scope"] = json!("agent_private");
            row["agentId"] = json!(ctx.agent_id.as_str());
            row["ownerUserId"] = json!(ctx.owner_user_id);
            row["workspaceKey"] = json!(ctx.workspace_key);
            if !owned(&row, ctx) {
                return Err(StoreError::InvalidInput.into());
            }
            let old = io::read(&dir, RESOLVED, io::MAX_BYTES, cancel)?;
            let rows = io::records(old.as_deref().unwrap_or(&[]))?;
            let current = || {
                check()?;
                self.sources(request.conflict, ctx)?;
                if io::read(&dir, LOG, io::MAX_BYTES, cancel)?.as_deref()
                    != Some(observed.as_slice())
                {
                    return Err(StoreError::InvalidInput.into());
                }
                Ok(())
            };
            let prior = rows
                .iter()
                .filter(|(v, _)| {
                    owned(v, ctx) && v["operationId"] == request.operation_id.to_string()
                })
                .collect::<Vec<_>>();
            if prior.len() > 1 {
                return Err(StoreError::Corrupt.into());
            }
            if let Some((prior, _)) = prior.first() {
                let time = prior["resolvedAt"].as_str().ok_or(StoreError::Corrupt)?;
                chrono::DateTime::parse_from_rfc3339(time).map_err(|_| StoreError::Corrupt)?;
                row["resolvedAt"] = prior["resolvedAt"].clone();
                if &row != prior {
                    return Err(StoreError::InvalidInput.into());
                }
                current()?;
                dir.sync_file_durable(RESOLVED)?;
                current()?;
                return Ok(row);
            }
            let mut line = serde_json::to_vec(&row).map_err(|_| StoreError::Corrupt)?;
            line.push(b'\n');
            let mut bytes = old.clone().unwrap_or_default();
            if line.len() > 1024 * 1024
                || bytes.len() + line.len() > io::MAX_BYTES
                || rows.len() == io::MAX_ROWS
            {
                return Err(StoreError::InvalidInput.into());
            }
            bytes.extend(line);
            io::replace(&dir, RESOLVED, old.as_deref(), &bytes, cancel, &current)?;
            current()?;
            Ok(row)
        })
    }
    /// Latest owned strong recommendation for this actual visible pair. This never applies it.
    /// Current source mismatch or inaccessible sources refuse rather than returning stale content.
    pub fn find_resolution(
        &self,
        memory_id: &str,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<Option<Value>, EngineError> {
        if !valid_id(memory_id) {
            return Err(StoreError::InvalidInput.into());
        }
        self.transaction(principal, agent, cancel, |workspace, ctx, check| {
            let dir = match workspace.open_child(".adaptive-learning") {
                Ok(dir) => dir,
                Err(StoreError::Io {
                    kind: std::io::ErrorKind::NotFound,
                }) => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            let Some(bytes) = io::read(&dir, RESOLVED, io::MAX_BYTES, cancel)? else {
                return Ok(None);
            };
            let rows = io::records(&bytes)?;
            for (row, _) in rows.into_iter().rev().filter(|(v, _)| owned(v, ctx)) {
                cancel.check()?;
                if row["recommendation"] != "apply_via_safe_reconsolidation"
                    || row["dryRun"] != false
                {
                    continue;
                }
                let original = &row["original"];
                if original["newMemoryId"] != memory_id && original["existingMemoryId"] != memory_id
                {
                    continue;
                }
                let observed =
                    io::read(&dir, LOG, io::MAX_BYTES, cancel)?.ok_or(StoreError::InvalidInput)?;
                if !io::records(&observed)?
                    .into_iter()
                    .any(|(candidate, _)| owned(&candidate, ctx) && candidate == *original)
                {
                    return Err(StoreError::InvalidInput.into());
                }
                let source = |field: &str| -> Result<MemoryRecord, EngineError> {
                    let id = original[field]
                        .as_str()
                        .filter(|id| valid_id(id))
                        .ok_or(StoreError::Corrupt)?;
                    self.reader
                        .find_visible_record(id, ctx, self.reader.context.host().now_ms())
                };
                let request = ConflictRequest {
                    operation_id: original["operationId"]
                        .as_str()
                        .ok_or(StoreError::Corrupt)?
                        .parse()
                        .map_err(|_| StoreError::Corrupt)?,
                    new: source("newMemoryId")?,
                    existing: source("existingMemoryId")?,
                    score: original["score"].as_f64().ok_or(StoreError::Corrupt)?,
                    decision: match original["mergeDecision"].as_str() {
                        Some("stored_separately") => MergeDecision::StoredSeparately,
                        Some("no_merge_llm_call") => MergeDecision::NoMergeLlmCall,
                        _ => return Err(StoreError::Corrupt.into()),
                    },
                };
                self.sources(&request, ctx)?;
                validate_original(original, &request)?;
                if row["sourceDigest"] != request_digest(&request)? {
                    return Err(StoreError::InvalidInput.into());
                }
                // Recompute the recommendation and selectors from the observed fields, not a cached flag.
                let value = parse_json(&row.to_string()).map_err(|_| StoreError::Corrupt)?;
                let projected = conflict_resolution::proposal(
                    &parse_json(&original.to_string()).map_err(|_| StoreError::Corrupt)?,
                    &value,
                    self.reader.context.host().now_ms(),
                    cancel,
                )?;
                let projected: Value = serde_json::from_str(&write_json(&projected))
                    .map_err(|_| StoreError::Corrupt)?;
                if projected["recommendation"] != row["recommendation"] {
                    return Err(StoreError::Corrupt.into());
                }
                check()?;
                self.sources(&request, ctx)?;
                if io::read(&dir, LOG, io::MAX_BYTES, cancel)?.as_deref()
                    != Some(observed.as_slice())
                    || io::read(&dir, RESOLVED, io::MAX_BYTES, cancel)?.as_deref()
                        != Some(bytes.as_slice())
                {
                    return Err(StoreError::InvalidInput.into());
                }
                return Ok(Some(row));
            }
            check()?;
            Ok(None)
        })
    }
}
fn validate_original(row: &Value, request: &ConflictRequest) -> Result<(), EngineError> {
    if row["newMemoryId"] != request.new.row.id
        || row["existingMemoryId"] != request.existing.row.id
        || row["newAgentId"] != request.new.row.stored_by
        || row["existingAgentId"] != request.existing.row.stored_by
        || row["newText"] != cut(&request.new.row.text)
        || row["existingText"] != cut(&request.existing.row.text)
        || row["score"].as_f64() != Some(request.score)
        || row["category"] != request.new.row.category
        || row["mergeDecision"] != request.decision.name()
    {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(())
}
