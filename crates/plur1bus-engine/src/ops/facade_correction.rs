//! Per-call correction providers retain admission across outbound inference.
use super::{EffectCancel, EffectJournal, NativeMemory};
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, Cancel, EmbedError, EmbedKind, EngineError, HostServices, MemoryOpErrorCode,
        MemoryRow, Principal, StoreError, VectorSpaceIdentity,
    },
    embedding::{model_selection::ModelSelection, EmbeddingProvider},
    neo::{
        capture_journal::{neo_budget, CaptureJournal},
        correction_effects::{EffectAuthority, NativeCorrectionEffects},
    },
    ops::{
        context::{error, OperationContext},
        correction::{CorrectionEffects, CorrectionServices},
        sharing::ShareServices,
        write::{MemoryWriter, MutationStores},
    },
    store::directory::TrustedDirectory,
};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
};

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
        // The native Neo journal binds only user-owned callers with a logical workspace key
        // (`CaptureJournal::bind`). Any other owner corrects without Neo effects, as capture
        // skips Neo for it (RE-D155, RE-D165); the pin writes Neo for every owner (RY-A).
        let neo_owner = crate::context::is_user_principal(&admission.request.owner_user_id)
            && !admission.request.workspace_key.is_empty();
        let source = if admission.config["neo"]["enabled"] == false || !neo_owner {
            None
        } else if let Some(journal) = &self.journal {
            // A supplied journal is checked now, as before: an unusable binding refuses the
            // correction before any archive is written.
            NativeCorrectionEffects::open(
                journal.clone(),
                self.context.host_handle(),
                self.writer.stores.clone(),
                self.authority(principal, agent, Cancel::never()),
            )?;
            Some(Source::Journal(journal.clone()))
        } else {
            self.effect_journal.clone().map(Source::Factory)
        };
        let effects = source.map(|source| {
            Arc::new(LazyEffects {
                source,
                host: self.context.host_handle(),
                stores: self.writer.stores.clone(),
                principal: principal.clone(),
                agent: agent.clone(),
                base: self.base.clone(),
                cancel: self.effect_cancel.clone(),
                opened: OnceLock::new(),
                deferred: AtomicBool::new(false),
            }) as Arc<dyn CorrectionEffects>
        });
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

impl NativeMemory {
    fn authority(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        cancel: Cancel,
    ) -> EffectAuthority {
        EffectAuthority {
            principal: principal.clone(),
            agent: agent.clone(),
            cancel,
            base_db: self.base.clone(),
        }
    }
}

enum Source {
    Journal(Arc<CaptureJournal>),
    /// Resolved only at the first effect, after the library's admission, card ACL, archive
    /// and embedding: a composition creates its Neo root here (RE-D165).
    Factory(EffectJournal),
}

/// A correction's Neo effects, opened at their first use: the token (a composition's
/// shutdown and budget, RE-D165) starts after the mutation gate was taken and the embedding
/// ran, not when the writer was built. A failed or skipped effect is reported in the log, as
/// the pin's `safe-update.js` warns for a failed edge rewrite or event append; the
/// correction itself stays stored, as at the pin.
struct LazyEffects {
    source: Source,
    host: Arc<dyn HostServices>,
    stores: Arc<dyn MutationStores>,
    principal: Principal,
    agent: AgentContext,
    base: PathBuf,
    cancel: Option<EffectCancel>,
    /// `None` inside: the factory could not provide a journal, so no Neo effect runs.
    opened: OnceLock<Result<Option<(NativeCorrectionEffects, Cancel)>, StoreError>>,
    /// The edge rewrite was skipped for lack of budget, so the event is skipped too: either
    /// both effects run or neither, never edges without their event.
    deferred: AtomicBool,
}

impl LazyEffects {
    fn effects(&self) -> Result<Option<&(NativeCorrectionEffects, Cancel)>, StoreError> {
        self.opened
            .get_or_init(|| {
                let journal = match &self.source {
                    Source::Journal(journal) => journal.clone(),
                    Source::Factory(factory) => match factory() {
                        Ok(journal) => journal,
                        Err(_) => {
                            warn("unavailable", "neo-root");
                            return Ok(None);
                        }
                    },
                };
                let cancel = self
                    .cancel
                    .as_ref()
                    .map_or_else(Cancel::never, |cancel| cancel());
                NativeCorrectionEffects::open(
                    journal,
                    self.host.clone(),
                    self.stores.clone(),
                    EffectAuthority {
                        principal: self.principal.clone(),
                        agent: self.agent.clone(),
                        cancel: cancel.clone(),
                        base_db: self.base.clone(),
                    },
                )
                .map(|effects| Some((effects, cancel)))
                .map_err(|failure| match failure {
                    EngineError::Store(error) => error,
                    _ => StoreError::Unavailable,
                })
            })
            .as_ref()
            .map(Option::as_ref)
            .map_err(Clone::clone)
    }
}

/// Fixed, content-free diagnostics: no memory text, ID or path.
fn warn(outcome: &str, step: &str) {
    log::warn!(target: "plur1bus_engine::memory", "correction neo effect {outcome}: {step}");
}

impl CorrectionEffects for LazyEffects {
    fn contains(&self, context: &RequestContext, key: &str) -> Result<bool, StoreError> {
        match self.effects()? {
            Some((effects, _)) => effects.contains(context, key),
            None => Ok(false),
        }
    }
    fn rewrite_edges(
        &self,
        context: &RequestContext,
        old: &MemoryRow,
        new_id: &str,
    ) -> Result<(), StoreError> {
        let Some((effects, cancel)) = self.effects()? else {
            return Err(StoreError::Unavailable);
        };
        // Both remaining effects wait for the Neo leases at most the Neo budget each. With
        // less time left than that, neither starts (deferred, logged), so no edge points to a
        // version whose event is missing.
        let needed = neo_budget(self.host.as_ref()) * 2;
        if cancel.remaining().is_some_and(|left| left < needed) {
            self.deferred.store(true, Ordering::Release);
            warn("deferred", "edges-and-event");
            return Err(StoreError::Unavailable);
        }
        effects
            .rewrite_edges(context, old, new_id)
            .inspect_err(|_| warn("failed", "edges"))
    }
    fn record(
        &self,
        context: &RequestContext,
        source: &MemoryRow,
        event: &Value,
    ) -> Result<(), StoreError> {
        if self.deferred.load(Ordering::Acquire) {
            return Err(StoreError::Unavailable);
        }
        let Some((effects, _)) = self.effects()? else {
            return Err(StoreError::Unavailable);
        };
        effects
            .record(context, source, event)
            .inspect_err(|_| warn("failed", "event"))
    }
}
