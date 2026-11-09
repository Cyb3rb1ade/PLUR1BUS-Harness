//! Caller-bound host decision/embedding preparation. No writer lease is held during inference.
use super::*;
use crate::{
    capture::{
        merge_decision,
        normal_store::{assess, MergeMaterial, StoreEncoding, StoreOwner},
    },
    contract::{EmbedKind, HostError},
    text::{js::js_trim, json::TolerantJsonValue as Json},
};
use std::time::{Duration, Instant};
#[path = "normal_merge_origin.rs"]
mod origin;
pub(super) use origin::NormalMergeOrigin;
struct Snapshot {
    source: MemoryRecord,
    proof: String,
    binding: String,
    physical: (PathBuf, (u64, u64)),
}
#[derive(Clone, Copy)]
struct NormalInput<'a> {
    source_id: &'a str,
    params: &'a Json,
    selected: Option<&'a NormalCandidatePlan>,
}
#[path = "normal_selection.rs"]
pub(super) mod selection;
impl NativeMerge {
    /// Attempt the host-configured private merge of an already selected candidate ID.
    /// None leaves ordinary separate-store fallback to the caller. Provider faults may skip a
    /// merge, while cancellation/denied authority/source drift remain errors. Once a receipt
    /// exists, errors require durable open recovery; never repeat inference to recover intent.
    pub fn merge_normal(
        &self,
        source_id: &str,
        params: &Json,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<Option<MergeResult>, EngineError> {
        self.normal_run(
            NormalInput {
                source_id,
                params,
                selected: None,
            },
            principal,
            agent,
            cancel,
        )
    }
    fn normal_run(
        &self,
        input: NormalInput<'_>,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<Option<MergeResult>, EngineError> {
        let NormalInput {
            source_id,
            params,
            selected,
        } = input;
        cancel.check()?;
        if let Some(plan) = selected {
            plan.check(self, principal, agent, cancel)?;
        }
        if uuid::Uuid::parse_str(source_id).is_err() {
            return Err(StoreError::InvalidInput.into());
        }
        let operation = self.reader.context.enter(principal, agent)?;
        let ctx = &operation.context;
        let host = self.reader.context.host();
        let original_config =
            serde_json::to_value(host.config()).map_err(|_| StoreError::InvalidInput)?;
        let cfg = crate::config::effective_config(&original_config)
            .map_err(|_| StoreError::InvalidInput)?;
        let assessed_at = selected.map_or_else(|| host.now_ms(), |plan| plan.assessed_at);
        let assessed = assess(
            params,
            StoreOwner {
                agent_id: ctx.agent_id.as_str(),
                owner_user_id: &ctx.owner_user_id,
                workspace_key: &ctx.workspace_key,
            },
            assessed_at,
            cancel,
        )?;
        if cfg["merging"]["enabled"] == false
            || cfg["merging"]["autoApply"] != true
            || host.llm().is_none()
        {
            return Ok(None);
        }
        let model = host_model(&cfg, ctx.agent_id.as_str())?;
        let workspace = TrustedDirectory::open(&self.reader.context.destructive_workspace(ctx)?)?;
        let base = TrustedDirectory::open(&self.reader.base)?;
        let state_dir = TrustedDirectory::open(host.state_dir())?;
        let identity = self.reader.embedding_identity().clone();
        let dimension = identity
            .dimension
            .as_u64()
            .filter(|v| *v > 0 && *v <= 32768)
            .ok_or(StoreError::InvalidInput)? as usize;
        let binding_check = || -> Result<(), EngineError> {
            cancel.check()?;
            if let Some(plan) = selected {
                plan.check(self, principal, agent, cancel)?;
            }
            self.reader.context.assert_open()?;
            workspace.assert_unchanged()?;
            base.assert_unchanged()?;
            state_dir.assert_unchanged()?;
            if RequestContext::build(principal, agent, host)? != *ctx
                || serde_json::to_value(host.config()).map_err(|_| StoreError::InvalidInput)?
                    != original_config
                || host.workspace_dir(&ctx.agent_id)?.as_deref() != Some(workspace.path())
                || host.state_dir() != state_dir.path()
            {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(())
        };
        let snapshot = || -> Result<Snapshot, EngineError> {
            let _gate = self.reader.context.mutation()?;
            self.journal.with_merge_writer(
                principal,
                agent,
                ctx,
                cancel,
                &binding_check,
                |dir, proof, binding, check| {
                    CaptureJournal::guard_non_merge_pending(dir, cancel)?;
                    super::super::conflict_application_state::guard_pending(dir, cancel)?;
                    state::guard_pending(dir, cancel)?;
                    let store = self.selected_store(ctx, &identity)?;
                    let source = store
                        .get_record(source_id)?
                        .ok_or(StoreError::InvalidInput)?;
                    self.private(&source, ctx)?;
                    state::bounded_row(&source.row, cancel)?;
                    let value = Snapshot {
                        source,
                        proof: write_json(proof),
                        binding: binding.into(),
                        physical: store.physical_binding()?,
                    };
                    check()?;
                    Ok(value)
                },
            )
        };
        let initial = snapshot()?;
        if let Some(plan) = selected {
            if plan.proof.as_ref() != Some(&(initial.proof.clone(), initial.binding.clone()))
                || !plan
                    .source
                    .as_ref()
                    .ok_or(StoreError::InvalidInput)?
                    .same(&initial.source)?
            {
                return Err(StoreError::InvalidInput.into());
            }
        }
        let revalidate = || -> Result<(), EngineError> {
            let current = snapshot()?;
            if current.proof != initial.proof
                || current.binding != initial.binding
                || current.physical != initial.physical
                || !Record::from(initial.source.clone()).same(&current.source)?
            {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(())
        };
        if !assessed.compatible(&initial.source.row)? {
            return Ok(None);
        }
        let timeout = cfg["merging"]["timeoutMs"]
            .as_u64()
            .filter(|v| *v > 0)
            .unwrap_or(30_000)
            .min(30_000);
        let decision_cancel = cancel.limited_to(Instant::now() + Duration::from_millis(timeout));
        revalidate()?;
        let decision = merge_decision::check(
            host.llm(),
            &Json::String(JsString::from(initial.source.row.text.as_str())),
            &Json::String(JsString::from(assessed.text())),
            model.as_deref(),
            &decision_cancel,
        );
        revalidate()?;
        let decision = match decision {
            Ok(Some(value)) => value,
            Ok(None)
            | Err(EngineError::Host(
                HostError::Unavailable | HostError::Failed | HostError::InvalidResponse,
            )) => return Ok(None),
            Err(error) => return Err(error),
        };
        let Some(merged_text) = assessed.checked_text(&initial.source.row, &decision, cancel)?
        else {
            return Ok(None);
        };
        revalidate()?;
        let vectors =
            self.reader
                .embedding_provider()
                .embed(&[merged_text], EmbedKind::Passage, cancel);
        revalidate()?;
        let mut vectors = vectors?;
        if vectors.len() != 1 {
            return Err(StoreError::InvalidInput.into());
        }
        let vector = vectors.pop().ok_or(StoreError::InvalidInput)?;
        if vector.len() != dimension || vector.iter().any(|v| !v.is_finite()) {
            return Err(StoreError::InvalidInput.into());
        }
        let vector =
            parse_json(&serde_json::to_string(&vector).map_err(|_| StoreError::InvalidInput)?)
                .map_err(|_| StoreError::InvalidInput)?;
        let encoding = StoreEncoding {
            summary_max_words: cfg["summaryMaxWords"]
                .as_u64()
                .unwrap_or(150)
                .try_into()
                .map_err(|_| StoreError::InvalidInput)?,
            half_life_overrides: parse_json(&cfg["recall"]["halfLifeDaysMap"].to_string())
                .map_err(|_| StoreError::InvalidInput)?,
            flashbulb: cfg["memoryDynamics"]["flashbulbEncoding"] == true,
        };
        let now = host.now_ms();
        let Some(prepared) = assessed.merge(
            MergeMaterial {
                source: &initial.source.row,
                decision: &decision,
                vector: &vector,
                now_ms: now,
            },
            &encoding,
            cancel,
        )?
        else {
            return Ok(None);
        };
        let write_key = String::from_utf16(prepared.write_key.as_utf16_units())
            .map_err(|_| StoreError::InvalidInput)?;
        let request = MergeRequest {
            source: initial.source.clone(),
            replacement: prepared.into_row()?,
            write_key,
            now_ms: now,
            identity: identity.clone(),
        };
        // RE-D83 owns source CAS after publication starts; the source may legitimately be deleted.
        let publish_check = || -> Result<(), EngineError> {
            binding_check()?;
            if self.selected_store(ctx, &identity)?.physical_binding()? != initial.physical {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(())
        };
        revalidate()?;
        let origin = NormalMergeOrigin::prepare(
            params,
            assessed_at,
            &decision,
            &original_config,
            &workspace,
            &base,
        )?;
        self.settle_checked(
            &request,
            principal,
            agent,
            cancel,
            MergeMode {
                existing_only: false,
                validate_only: false,
                normal_origin: Some(&origin),
            },
            &publish_check,
        )
        .map(Some)
    }
}
fn host_model(cfg: &Value, agent: &str) -> Result<Option<String>, EngineError> {
    let feature = &cfg["merging"];
    // Direct transports and thinking controls cannot silently become the frozen host route.
    if ["baseUrl", "apiKey", "apiKeyRef"].iter().any(|key| {
        feature[*key]
            .as_str()
            .is_some_and(|v| !js_trim(v).is_empty())
    }) || feature["headers"]
        .as_object()
        .is_some_and(|v| !v.is_empty())
        || feature["disableThinking"] == true
    {
        return Err(StoreError::InvalidInput.into());
    }
    let agent_cfg = &cfg["llmRouter"]["agentModels"][agent];
    let selected = [agent_cfg["merging"].as_str(), agent_cfg["*"].as_str()]
        .into_iter()
        .flatten()
        .find(|v| valid_agent_model(v))
        .or_else(|| {
            feature["model"]
                .as_str()
                .map(js_trim)
                .filter(|v| !v.is_empty())
        })
        .or_else(|| {
            cfg["llmRouter"]["defaultModel"]
                .as_str()
                .map(js_trim)
                .filter(|v| !v.is_empty())
        });
    if selected.is_some_and(|v| v.len() > 4096) {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(selected.map(str::to_owned))
}
fn valid_agent_model(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/+@-".contains(&b))
}
