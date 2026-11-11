//! Native MemoryOps composition; no process capability or new wire method is implied.
use super::{
    context::OperationContext,
    curation::NativeCuration,
    import::{ImportStores, Importer},
    import_ledger::ImportLedger,
    import_row::ImportEncoding,
    knowledge_promotion::NativePromotion,
    memory::{MemoryReader, ReadStores},
    proposals::Proposals,
    rebind::{RebindStores, Rebinder},
    sharing::{ShareServices, SharedStores},
    unimport::{UnimportEffects, UnimportStores, Unimporter},
    write::{MemoryWriter, MutationStores},
};
use crate::{
    contract::{
        AgentContext, Cancel, EngineError, MemoryCard, MemoryCorrectResult, MemoryCurationOps,
        MemoryForgetResult, MemoryImportRequest, MemoryImportResult, MemoryLinkRequest,
        MemoryLinkResult, MemoryListQuery, MemoryListResult, MemoryOps, MemoryPromoteRequest,
        MemoryPromotionResult, MemoryProposalAcceptResult, MemoryProposalListQuery,
        MemoryProposalListResult, MemoryProposalRejectResult, MemoryProposalsOps,
        MemoryProposeResult, MemoryRebindRequest, MemoryRebindResult, MemoryShareResult,
        MemoryShareTarget, MemoryState, MemoryStatsResult, MemoryUnbindRequest, MemoryUnbindResult,
        MemoryUnimportRequest, MemoryUnimportResult, Principal, ProposalRejectOptions,
        ProposeOptions, ShareOptions,
    },
    embedding::EmbeddingProvider,
    neo::capture_journal::CaptureJournal,
};
use std::{path::PathBuf, sync::Arc};
#[path = "facade_correction.rs"]
mod correction;

/// Explicit trusted native dependencies. Routes still authorize each actual request;
/// supplying a route does not confer row ownership or a maintenance grant.
pub struct MemoryPorts {
    /// Existing readable pools.
    pub read: Arc<dyn ReadStores>,
    /// Existing private mutation pool.
    pub mutation: Arc<dyn MutationStores>,
    /// Shared destinations, including explicit unsupported status.
    pub shared: Arc<dyn SharedStores>,
    /// Import admission and writable route.
    pub import: Arc<dyn ImportStores>,
    /// Owner-binding migration route.
    pub rebind: Arc<dyn RebindStores>,
    /// Import rollback and existing shared pools.
    pub unimport: Arc<dyn UnimportStores>,
    /// Actual archive/audit and configured graph/mirror cleanup.
    pub unimport_effects: Arc<dyn UnimportEffects>,
    /// Active embedding identity used by reads, corrections and import.
    pub embedder: Arc<dyn EmbeddingProvider>,
    /// Explicit active/retained shared destination providers.
    pub sharing_providers: Vec<Arc<dyn EmbeddingProvider>>,
    /// Original host/policy-bound Neo journal, not a caller-derived root. `None` composes the
    /// facade without Neo: correct and accept run without Neo effects, unimport without graph
    /// cleanup, and promote and curation, which need the journal's leases, refuse.
    pub journal: Option<Arc<CaptureJournal>>,
    /// Explicit jobs root for rollback guards; no discovery is performed here.
    pub jobs_root: Option<PathBuf>,
    /// Validated host import encoding policy.
    pub import_encoding: ImportEncoding,
}

/// Every component shares one operation generation, registry root and import ledger.
/// Neo correction effects are deliberately constructed anew for each original caller.
pub struct NativeMemory {
    context: Arc<OperationContext>,
    base: PathBuf,
    reader: Arc<MemoryReader>,
    writer: Arc<MemoryWriter>,
    proposals: Proposals,
    importer: Importer,
    rebinder: Rebinder,
    unimporter: Unimporter,
    promotion: Option<NativePromotion>,
    curation: Option<NativeCuration>,
    journal: Option<Arc<CaptureJournal>>,
    embedder: Arc<dyn EmbeddingProvider>,
    effect_cancel: Option<EffectCancel>,
    no_journal: NoJournal,
}
/// The token each correction's Neo effects run on (shutdown and budget of a composition).
pub type EffectCancel = Arc<dyn Fn() -> Cancel + Send + Sync>;
/// Curation without a Neo journal: there is nothing to read or revise. The caller is admitted
/// as `NativeCuration` admits it first, so a refused caller gets the same refusal.
struct NoJournal(Arc<OperationContext>);
impl NoJournal {
    fn refuse(&self, p: &Principal, a: &AgentContext) -> EngineError {
        let admitted = self
            .0
            .enter(p, a)
            .and_then(|operation| self.0.destructive_workspace(&operation.context));
        admitted.err().unwrap_or_else(no_journal)
    }
}
impl MemoryCurationOps for NoJournal {
    fn list(
        &self,
        _: crate::contract::MemoryCurationListQuery,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<crate::contract::MemoryCurationListResult, EngineError> {
        Err(self.refuse(p, a))
    }
    fn resolve(
        &self,
        _: &str,
        _: crate::contract::MemoryCurationAction,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<crate::contract::MemoryCurationResolveResult, EngineError> {
        Err(self.refuse(p, a))
    }
}
/// The refusal `CaptureJournal::bind` gives a caller without a Neo partition.
fn no_journal() -> EngineError {
    crate::contract::StoreError::InvalidInput.into()
}
impl NativeMemory {
    /// Compose lazily without opening a table, creating directories or calling providers.
    pub fn new(context: Arc<OperationContext>, base: PathBuf, ports: MemoryPorts) -> Self {
        let reader = Arc::new(MemoryReader::new(
            context.clone(),
            ports.read,
            ports.embedder.clone(),
            base.clone(),
        ));
        let writer = Arc::new(
            MemoryWriter::new(context.clone(), ports.mutation, base.clone()).with_sharing(
                ShareServices {
                    reader: reader.clone(),
                    stores: ports.shared,
                    providers: ports.sharing_providers,
                },
            ),
        );
        let receipts = Arc::new(ImportLedger::new(&base));
        let mut unimporter = Unimporter::new(
            context.clone(),
            ports.unimport,
            receipts.clone(),
            ports.unimport_effects,
            base.clone(),
            ports.jobs_root,
        );
        if let Some(journal) = &ports.journal {
            unimporter = unimporter.with_graph_cleanup(journal.clone());
        }
        Self {
            importer: Importer::new(
                context.clone(),
                ports.import,
                ports.embedder.clone(),
                receipts.clone(),
                base.clone(),
                ports.import_encoding,
            ),
            rebinder: Rebinder::new(context.clone(), ports.rebind, base.clone()),
            unimporter,
            promotion: ports
                .journal
                .clone()
                .map(|journal| NativePromotion::new(reader.clone(), journal)),
            curation: ports
                .journal
                .clone()
                .map(|journal| NativeCuration::new(context.clone(), journal)),
            proposals: Proposals::new(writer.clone()),
            no_journal: NoJournal(context.clone()),
            context,
            base,
            reader,
            writer,
            journal: ports.journal,
            embedder: ports.embedder,
            effect_cancel: None,
        }
    }
    /// Run each correction's Neo effects on the token `cancel` returns instead of an unbounded
    /// one (a composition's shutdown and budget, RE-D165).
    #[must_use]
    pub fn with_effect_cancel(mut self, cancel: EffectCancel) -> Self {
        self.effect_cancel = Some(cancel);
        self
    }
    /// [`MemoryOps::promote`] within the caller's cancellation and deadline. A process composition
    /// passes its shutdown-linked budget here instead of the trait's unbounded token.
    pub fn promote_with_cancel(
        &self,
        request: &MemoryPromoteRequest,
        p: &Principal,
        a: &AgentContext,
        cancel: &Cancel,
    ) -> Result<MemoryPromotionResult, EngineError> {
        match &self.promotion {
            Some(promotion) => promotion.run(&request.ids, p, a, cancel),
            // Admitted as `NativePromotion::run` admits first, then refused for the journal.
            None => {
                cancel.check()?;
                let operation = self.context.enter(p, a)?;
                let ctx = &operation.context;
                if ctx.background() || !matches!(ctx.origin_wire(), "user" | "system") {
                    return Err(super::context::error(
                        crate::contract::MemoryOpErrorCode::Denied,
                    ));
                }
                Err(no_journal())
            }
        }
    }
    /// The native curation component, whose `*_with_cancel` entries take a bounded token;
    /// `None` without a Neo journal.
    pub fn native_curation(&self) -> Option<&NativeCuration> {
        self.curation.as_ref()
    }
}

impl MemoryOps for NativeMemory {
    fn list(
        &self,
        query: MemoryListQuery,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryListResult, EngineError> {
        self.reader.list(&query, p, a)
    }
    fn show(&self, id: &str, p: &Principal, a: &AgentContext) -> Result<MemoryCard, EngineError> {
        self.reader.show(id, p, a)
    }
    fn forget(
        &self,
        id: &str,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryForgetResult, EngineError> {
        self.writer.forget(id, p, a)
    }
    fn correct(
        &self,
        id: &str,
        text: &str,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryCorrectResult, EngineError> {
        let operation = self.context.enter(p, a)?;
        self.context.destructive_workspace(&operation.context)?;
        self.correction_writer(p, a)?.correct(id, text, p, a)
    }
    fn share(
        &self,
        id: &str,
        target: MemoryShareTarget,
        options: ShareOptions,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryShareResult, EngineError> {
        self.writer.share(id, target, p, a, &options)
    }
    fn state(&self, p: &Principal, a: &AgentContext) -> Result<MemoryState, EngineError> {
        self.reader.state(p, a)
    }
    fn propose(
        &self,
        id: &str,
        text: &str,
        options: ProposeOptions,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryProposeResult, EngineError> {
        self.proposals.propose(id, text, &options, p, a)
    }
    fn proposals(&self) -> &dyn MemoryProposalsOps {
        self
    }
    fn import(
        &self,
        request: MemoryImportRequest,
        cancel: &Cancel,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryImportResult, EngineError> {
        self.importer.import(&request, p, a, cancel)
    }
    fn rebind(
        &self,
        request: MemoryRebindRequest,
        cancel: &Cancel,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryRebindResult, EngineError> {
        self.rebinder.rebind(&request, p, a, cancel)
    }
    fn unbind(
        &self,
        request: MemoryUnbindRequest,
        cancel: &Cancel,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryUnbindResult, EngineError> {
        self.rebinder.unbind(&request, p, a, cancel)
    }
    fn unimport(
        &self,
        request: MemoryUnimportRequest,
        cancel: &Cancel,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryUnimportResult, EngineError> {
        self.unimporter.unimport(&request, p, a, cancel)
    }
    fn link(
        &self,
        id: &str,
        request: MemoryLinkRequest,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryLinkResult, EngineError> {
        self.reader.link(id, &request, p, a)
    }
    fn stats(
        &self,
        ids: Option<&[String]>,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryStatsResult, EngineError> {
        self.reader.stats(ids, p, a)
    }
    fn promote(
        &self,
        request: MemoryPromoteRequest,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryPromotionResult, EngineError> {
        self.promote_with_cancel(&request, p, a, &Cancel::never())
    }
    fn curation(&self) -> &dyn MemoryCurationOps {
        match &self.curation {
            Some(curation) => curation,
            None => &self.no_journal,
        }
    }
}

impl MemoryProposalsOps for NativeMemory {
    fn list(
        &self,
        query: MemoryProposalListQuery,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryProposalListResult, EngineError> {
        self.proposals.list(query, p, a)
    }
    fn accept(
        &self,
        id: &str,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryProposalAcceptResult, EngineError> {
        let operation = self.context.enter(p, a)?;
        self.context.destructive_workspace(&operation.context)?;
        Proposals::new(Arc::new(self.correction_writer(p, a)?)).accept(id, p, a)
    }
    fn reject(
        &self,
        id: &str,
        options: ProposalRejectOptions,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<MemoryProposalRejectResult, EngineError> {
        self.proposals.reject(id, options, p, a)
    }
}
