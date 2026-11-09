//! Per-call correction providers retain admission across outbound inference.
use super::NativeMemory;
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, Cancel, EmbedError, EmbedKind, EngineError, MemoryOpErrorCode, Principal,
        VectorSpaceIdentity,
    },
    embedding::{model_selection::ModelSelection, EmbeddingProvider},
    neo::correction_effects::{EffectAuthority, NativeCorrectionEffects},
    ops::{
        context::{error, OperationContext},
        correction::CorrectionServices,
        sharing::ShareServices,
        write::MemoryWriter,
    },
    store::directory::TrustedDirectory,
};
use serde_json::Value;
use std::sync::Arc;

struct Admission {
    context: Arc<OperationContext>,
    principal: Principal,
    agent: AgentContext,
    request: RequestContext,
    config: Value,
    workspace: TrustedDirectory,
    base: TrustedDirectory,
}
impl Admission {
    fn open(
        memory: &NativeMemory,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<Self, EngineError> {
        let request = RequestContext::build(principal, agent, memory.context.host())?;
        let workspace = memory.context.destructive_workspace(&request)?;
        let admission = Self {
            context: memory.context.clone(),
            principal: principal.clone(),
            agent: agent.clone(),
            request,
            config: serde_json::to_value(memory.context.host().config())
                .map_err(|_| error(MemoryOpErrorCode::Storage))?,
            workspace: TrustedDirectory::open(&workspace)?,
            base: TrustedDirectory::open(&memory.base)?,
        };
        admission.check()?;
        Ok(admission)
    }
    fn check(&self) -> Result<(), EngineError> {
        self.context.assert_open()?;
        self.workspace.assert_unchanged()?;
        self.base.assert_unchanged()?;
        if RequestContext::build(&self.principal, &self.agent, self.context.host())? != self.request
            || self.context.destructive_workspace(&self.request)? != self.workspace.path()
            || serde_json::to_value(self.context.host().config())
                .map_err(|_| error(MemoryOpErrorCode::Storage))?
                != self.config
        {
            return Err(error(MemoryOpErrorCode::Conflict));
        }
        Ok(())
    }
    fn provider(self: &Arc<Self>, inner: Arc<dyn EmbeddingProvider>) -> Arc<dyn EmbeddingProvider> {
        Arc::new(Provider {
            inner,
            admission: self.clone(),
        })
    }
}
struct Provider {
    inner: Arc<dyn EmbeddingProvider>,
    admission: Arc<Admission>,
}
impl EmbeddingProvider for Provider {
    fn identity(&self) -> &VectorSpaceIdentity {
        self.inner.identity()
    }
    fn model_selection(&self) -> ModelSelection {
        self.inner.model_selection()
    }
    fn invalidate_egress(&self) {
        self.inner.invalidate_egress();
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        cancel.check().map_err(EmbedError::Cancelled)?;
        self.admission
            .check()
            .map_err(|_| EmbedError::Unavailable)?;
        let vectors = self.inner.embed(texts, kind, cancel)?;
        cancel.check().map_err(EmbedError::Cancelled)?;
        self.admission
            .check()
            .map_err(|_| EmbedError::Unavailable)?;
        Ok(vectors)
    }
}
impl NativeMemory {
    pub(super) fn correction_writer(
        &self,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryWriter, EngineError> {
        let admission = Arc::new(Admission::open(self, principal, agent)?);
        let effects = if admission.config["neo"]["enabled"] == false {
            None
        } else {
            Some(Arc::new(NativeCorrectionEffects::open(
                self.journal.clone(),
                self.context.host_handle(),
                self.writer.stores.clone(),
                EffectAuthority {
                    principal: principal.clone(),
                    agent: agent.clone(),
                    cancel: Cancel::never(),
                    base_db: self.base.clone(),
                },
            )?)
                as Arc<dyn crate::ops::correction::CorrectionEffects>)
        };
        let mut writer = MemoryWriter::new(
            self.context.clone(),
            self.writer.stores.clone(),
            self.base.clone(),
        )
        .with_corrections(CorrectionServices {
            embedder: admission.provider(self.embedder.clone()),
            effects,
        });
        if let Some(sharing) = &self.writer.sharing {
            writer = writer.with_sharing(ShareServices {
                reader: sharing.reader.clone(),
                stores: sharing.stores.clone(),
                providers: sharing
                    .providers
                    .iter()
                    .map(|provider| admission.provider(provider.clone()))
                    .collect(),
            });
        }
        admission.check()?;
        Ok(writer)
    }
}
