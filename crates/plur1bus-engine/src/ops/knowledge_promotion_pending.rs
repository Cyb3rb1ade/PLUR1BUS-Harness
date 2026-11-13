//! The queue nominates IDs. Actual sources and the entry point grant publication authority.
use super::*;
impl NativePromotion {
    /// Select visible private pending sources for an authenticated foreground host caller.
    /// This additive native operation does not change MemoryPromoteRequest, which requires IDs.
    pub fn run_pending(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<MemoryPromotionResult, EngineError> {
        self.pending(principal, agent, cancel, None)
    }

    pub(crate) fn run_for_job(
        &self,
        authority: &JobAuthority,
        cancel: &Cancel,
    ) -> Result<MemoryPromotionResult, EngineError> {
        let (principal, agent) = authority.caller();
        self.pending(principal, agent, cancel, Some(authority))
    }

    fn pending(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        scheduled: Option<&JobAuthority>,
    ) -> Result<MemoryPromotionResult, EngineError> {
        cancel.check()?;
        let operation = self.reader.context.enter(principal, agent)?;
        let ctx = &operation.context;
        check_authority(ctx, scheduled)?;
        let raw = serde_json::to_value(self.reader.context.host().config())
            .map_err(|_| StoreError::Corrupt)?;
        let config = crate::config::effective_config(&raw).map_err(|_| StoreError::InvalidInput)?;
        let path = self
            .reader
            .context
            .host()
            .workspace_dir(&ctx.agent_id)?
            .ok_or_else(|| error(MemoryOpErrorCode::InvalidInput))?;
        let workspace = TrustedDirectory::open(&path)?;
        let adaptive = match workspace.open_child(".adaptive-learning") {
            Ok(dir) => Some(dir),
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => None,
            Err(e) => return Err(e.into()),
        };
        let before = adaptive
            .as_ref()
            .map(|dir| io::read(dir, "knowledge-pending.json", 2 * 1024 * 1024, cancel))
            .transpose()?
            .flatten();
        let text = before
            .as_deref()
            .map(std::str::from_utf8)
            .transpose()
            .map_err(|_| StoreError::Corrupt)?;
        let pending = knowledge_queue_for_promotion(text, cancel)?;
        let subject = AclSubject::from_context(ctx);
        // Reuse the frozen normalization, dedupe, order and validation before touching a source.
        let candidates = promotion_plan::plan(
            &PromotionInput {
                context: &subject,
                config: &config,
                ids: None,
                pending: &pending,
                content: None,
                now: self.reader.context.host().now_ms(),
                lock_busy: true,
            },
            cancel,
            |_| Err(StoreError::Corrupt.into()),
            || Ok(()),
        )?;
        let sources = if candidates.result.items.is_empty() {
            Vec::new()
        } else {
            self.sources(ctx)?
        };
        let source_bindings = bindings(&sources)?;
        let mut selected = Vec::new();
        let mut bytes = 0usize;
        for item in candidates.result.items {
            cancel.check()?;
            let snapshot = self.snapshot(&sources, &item.id, ctx)?;
            if snapshot.visible
                && snapshot
                    .raw
                    .as_ref()
                    .is_some_and(|(_, record)| publishable(&record.row, ctx, scheduled.is_some()))
            {
                let row = &snapshot.raw.as_ref().ok_or(StoreError::Corrupt)?.1.row;
                bytes = bytes
                    .checked_add(
                        serde_json::to_vec(row)
                            .map_err(|_| StoreError::Corrupt)?
                            .len(),
                    )
                    .ok_or(StoreError::Unavailable)?;
                if bytes > io::MAX_BYTES {
                    return Err(StoreError::Unavailable.into());
                }
                selected.push(snapshot);
            }
        }
        let check = || {
            cancel.check()?;
            self.reader.context.assert_open()?;
            workspace.assert_unchanged()?;
            if let Some(dir) = &adaptive {
                dir.assert_unchanged()?;
            }
            if RequestContext::build(principal, agent, self.reader.context.host())? != *ctx
                || self
                    .reader
                    .context
                    .host()
                    .workspace_dir(&ctx.agent_id)?
                    .as_deref()
                    != Some(workspace.path())
                || serde_json::to_value(self.reader.context.host().config())
                    .map_err(|_| StoreError::Corrupt)?
                    != raw
            {
                return Err(StoreError::Unavailable.into());
            }
            if !selected.is_empty() {
                let current = self.sources(ctx)?;
                if bindings(&current)? != source_bindings {
                    return Err(StoreError::UntrustedPath.into());
                }
                for snapshot in &selected {
                    cancel.check()?;
                    if !snapshot.same(&self.snapshot(&current, &snapshot.id, ctx)?)? {
                        return Err(StoreError::Unavailable.into());
                    }
                }
            }
            Ok(())
        };
        self.observe("promotion-pending-selected")?;
        check()?;
        if selected.is_empty() {
            return serde_json::from_value(serde_json::json!({"agentId":ctx.agent_id,"items":[]}))
                .map_err(|_| StoreError::Corrupt.into());
        }
        let ids = selected
            .iter()
            .map(|snapshot| snapshot.id.clone())
            .collect::<Vec<_>>();
        self.run_checked(
            &ids,
            (principal, agent),
            cancel,
            &check,
            Some(before.as_deref()),
            scheduled,
        )
    }
}
