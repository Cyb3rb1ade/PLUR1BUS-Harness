//! The remaining memory operations in the process (RE-D165): correct, the proposals,
//! unimport, promote and curation, composed over the native facade and the process pools.
//!
//! Two facades (`ops::facade::NativeMemory`) exist. One has no Neo journal and is composed at
//! construction without any file access; correct and accept use it and resolve the journal
//! only at their first Neo effect, after the library authorized the call and checked the card.
//! The other has the human-operation journal; promote, curation and the graph cleanup of an
//! applying unimport use it, only for a caller the journal can bind (a user principal with a
//! logical workspace key and a workspace directory, with the origin the operation admits).
//! The Neo root is opened only then, and created only when Neo is enabled. Every operation runs in the foreground with its caller's
//! principal; the library's ACL, owner and policy checks decide, nothing here grants authority.
//!
//! Bounds (RE-D165): no step under the engine-wide mutation gate runs on an unbounded token.
//! Embeddings of correct, accept and share run on [`BudgetedEmbedder`] (shutdown and
//! min(`embedding.requestTimeoutMs`, 15 s)); Neo effects of a correction on shutdown and three
//! Neo budgets taken at their first use; promote and curation on shutdown and 60 s.

use super::{engine_stores::EngineStores, Unavailable};
use crate::{
    capture::shared_scope::{CapturePolicy, WorkspaceCapturePolicy},
    context::{is_user_principal, RequestContext},
    contract::{
        AgentContext, Cancel, EmbedError, EmbedKind, EngineError, HostServices,
        MemoryCorrectResult, MemoryCurationAction, MemoryCurationListQuery,
        MemoryCurationListResult, MemoryCurationOps, MemoryCurationResolveResult, MemoryOps,
        MemoryPromoteRequest, MemoryPromotionResult, MemoryProposalAcceptResult,
        MemoryProposalListQuery, MemoryProposalListResult, MemoryProposalRejectResult,
        MemoryProposalsOps, MemoryProposeResult, MemoryRow, MemoryUnimportRequest,
        MemoryUnimportResult, Principal, ProposalRejectOptions, ProposeOptions, TurnOrigin,
        VectorSpaceIdentity,
    },
    embedding::{model_selection::ModelSelection, EmbeddingProvider},
    neo::capture_journal::{neo_budget, CaptureJournal},
    ops::{
        context::OperationContext,
        facade::{MemoryPorts, NativeMemory},
        import_ledger::ImportLedger,
        import_row::ImportEncoding,
        proposals::Proposals,
        reembedding::state::MigrationStateStore,
        sharing::ShareServices,
        unimport::{FileUnimportEffects, UnimportCleanup, UnimportEffects, Unimporter},
        write::MemoryWriter,
    },
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, PoisonError,
    },
    time::{Duration, Instant},
};

/// The deadline of a promote or curation call, linked to engine shutdown. Every lease these
/// paths wait for has its own shorter bound (the Neo budget); this bounds the whole call.
const MEMORY_OP_BUDGET: Duration = Duration::from_secs(60);
/// The upper bound of one embedding call under the mutation gate (the remote default).
const EMBED_BUDGET_MAX: Duration = Duration::from_secs(15);

/// The host's import encoding policy, shared by import and the facade (`ImportEncoding`).
pub(super) fn import_encoding(raw: &Value) -> ImportEncoding {
    ImportEncoding {
        half_life_overrides: crate::recall::trace::from_value(&raw["recall"]["halfLifeDaysMap"]),
        flashbulb: raw["memoryDynamics"]["flashbulbEncoding"] == true,
        summary_max_words: raw["summaryMaxWords"]
            .as_u64()
            .and_then(|words| usize::try_from(words).ok())
            .unwrap_or(150),
    }
}

/// A test-only hook run inside every budgeted embedding call, with the call's token.
#[cfg(test)]
pub(super) type EmbedHook = Arc<dyn Fn(&Cancel) + Send + Sync>;

/// The embedding budget shared by every budgeted provider of one engine.
pub(super) struct EmbedBudget {
    millis: AtomicU64,
    shutdown: Cancel,
    #[cfg(test)]
    hook: Mutex<Option<EmbedHook>>,
}

impl EmbedBudget {
    /// min(`embedding.requestTimeoutMs`, 15 s); the normalizer's floor of one second applies.
    pub(super) fn new(raw: &Value, shutdown: Cancel) -> Arc<Self> {
        let configured = raw["embedding"]["requestTimeoutMs"]
            .as_f64()
            .filter(|ms| ms.is_finite() && *ms >= 1000.0)
            .map_or(EMBED_BUDGET_MAX, |ms| Duration::from_millis(ms as u64));
        Arc::new(Self {
            millis: AtomicU64::new(configured.min(EMBED_BUDGET_MAX).as_millis() as u64),
            shutdown,
            #[cfg(test)]
            hook: Mutex::new(None),
        })
    }
    pub(super) fn duration(&self) -> Duration {
        Duration::from_millis(self.millis.load(Ordering::Acquire))
    }
    #[cfg(test)]
    pub(super) fn set(&self, budget: Duration) {
        self.millis
            .store(budget.as_millis() as u64, Ordering::Release);
    }
    #[cfg(test)]
    pub(super) fn set_hook(&self, hook: Option<EmbedHook>) {
        *self.hook.lock().unwrap_or_else(PoisonError::into_inner) = hook;
    }
}

/// An embedder whose calls end at shutdown or after the embedding budget, whatever token the
/// library passes (correct and share pass an unbounded one). A caller's own earlier deadline
/// is kept; its cancellation is checked before and after the call.
pub(super) struct BudgetedEmbedder {
    inner: Arc<dyn EmbeddingProvider>,
    budget: Arc<EmbedBudget>,
}

impl BudgetedEmbedder {
    pub(super) fn wrap(
        inner: Arc<dyn EmbeddingProvider>,
        budget: Arc<EmbedBudget>,
    ) -> Arc<dyn EmbeddingProvider> {
        Arc::new(Self { inner, budget })
    }
}

impl EmbeddingProvider for BudgetedEmbedder {
    fn model_selection(&self) -> ModelSelection {
        self.inner.model_selection()
    }
    fn identity(&self) -> &VectorSpaceIdentity {
        self.inner.identity()
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
        let mut deadline = Instant::now() + self.budget.duration();
        if let Some(left) = cancel.remaining() {
            deadline = deadline.min(Instant::now() + left);
        }
        let token = self.budget.shutdown.limited_to(deadline);
        #[cfg(test)]
        {
            let hook = self
                .budget
                .hook
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if let Some(hook) = hook {
                hook(&token);
            }
        }
        token.check().map_err(EmbedError::Cancelled)?;
        let vectors = self.inner.embed(texts, kind, &token)?;
        cancel.check().map_err(EmbedError::Cancelled)?;
        Ok(vectors)
    }
}

/// What the facade is composed from; nothing here opens a store or a file.
pub(super) struct SlotInputs {
    pub(super) operations: Arc<OperationContext>,
    pub(super) stores: Arc<EngineStores>,
    pub(super) base: PathBuf,
    pub(super) neo_root: PathBuf,
    pub(super) neo_enabled: bool,
    pub(super) embedder: Arc<dyn EmbeddingProvider>,
    pub(super) embed_budget: Arc<EmbedBudget>,
    pub(super) host: Arc<dyn HostServices>,
    pub(super) raw: Value,
    pub(super) shutdown: Cancel,
    pub(super) closed: Arc<AtomicBool>,
}

/// Which origins an operation admits; the library checks again, this only decides whether
/// the Neo journal may be opened or created for the caller.
#[derive(Clone, Copy)]
enum Admits {
    /// curation: a foreground user (`destructive_workspace`).
    User,
    /// promote: a foreground user or system caller.
    UserOrSystem,
    /// an applying unimport: a foreground system caller.
    System,
}

/// The journal a caller can use, or why there is none.
enum JournalFor {
    Bound(Arc<CaptureJournal>),
    /// Neo is off and no root exists: nothing of Neo to read, revise or clean.
    Absent,
    /// No partition (not a user principal, no workspace key or directory, refused origin) or
    /// the root cannot be opened or created.
    Refused,
}

/// The one human-operation journal of the engine, opened (and with Neo enabled created) on
/// first use. The lock is held only for that bounded file-system step.
pub(super) struct JournalCache {
    neo_root: PathBuf,
    neo_enabled: bool,
    base: PathBuf,
    host: Arc<dyn HostServices>,
    journal: Mutex<Option<Arc<CaptureJournal>>>,
}

impl JournalCache {
    fn get(&self) -> JournalFor {
        let mut slot = self.journal.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(journal) = slot.as_ref() {
            return JournalFor::Bound(journal.clone());
        }
        if self.neo_enabled {
            if crate::store::paths::secure_dir(&self.neo_root).is_err() {
                return JournalFor::Refused;
            }
        } else if !self.neo_root.is_dir() {
            return JournalFor::Absent;
        }
        let switching = self.base.clone();
        // Human operations follow the explicit workspace decision: an enabled workspace that
        // is not in a re-embedding switch (the same state file capture reads).
        let policy: Arc<dyn CapturePolicy> = Arc::new(
            WorkspaceCapturePolicy::new(self.base.clone()).with_maintenance(Arc::new(move || {
                MigrationStateStore::new(&switching)
                    .and_then(|store| store.switching())
                    .unwrap_or(true)
            })),
        );
        match CaptureJournal::open(&self.neo_root, self.host.clone(), policy) {
            Ok(journal) => {
                let journal = Arc::new(journal);
                *slot = Some(journal.clone());
                JournalFor::Bound(journal)
            }
            Err(_) => JournalFor::Refused,
        }
    }
}

/// The facade for a journal-needing call, or why it runs without one.
enum Facade {
    Journaled(Arc<NativeMemory>),
    NeoOff(Arc<NativeMemory>),
    Refused(Arc<NativeMemory>),
}

/// The facades. Correct and accept always use the plain facade: their Neo effects resolve the
/// journal only at their first use, after the library's admission, card ACL, archive and
/// embedding (`NativeMemory::with_effect_journal`). Promote, curation and the graph cleanup
/// of an applying unimport use the journaled facade, for an admitted caller with a Neo
/// partition only.
pub(super) struct NativeSlot {
    inputs: SlotInputs,
    cache: Arc<JournalCache>,
    plain: Arc<NativeMemory>,
    journaled: Mutex<Option<Arc<NativeMemory>>>,
}

impl NativeSlot {
    pub(super) fn new(inputs: SlotInputs) -> Self {
        let cache = Arc::new(JournalCache {
            neo_root: inputs.neo_root.clone(),
            neo_enabled: inputs.neo_enabled,
            base: inputs.base.clone(),
            host: inputs.host.clone(),
            journal: Mutex::new(None),
        });
        let plain = Arc::new(Self::compose(&inputs, &cache, None));
        Self {
            inputs,
            cache,
            plain,
            journaled: Mutex::new(None),
        }
    }

    fn compose(
        inputs: &SlotInputs,
        cache: &Arc<JournalCache>,
        journal: Option<Arc<CaptureJournal>>,
    ) -> NativeMemory {
        let stores = inputs.stores.clone();
        let embedder = BudgetedEmbedder::wrap(inputs.embedder.clone(), inputs.embed_budget.clone());
        let shutdown = inputs.shutdown.clone();
        let host = inputs.host.clone();
        let journaled = journal.is_some();
        let native = NativeMemory::new(
            inputs.operations.clone(),
            inputs.base.clone(),
            MemoryPorts {
                read: stores.clone(),
                mutation: stores.clone(),
                shared: stores.clone(),
                import: stores.clone(),
                rebind: stores.clone(),
                unimport: stores,
                unimport_effects: Arc::new(FileUnimportEffects),
                embedder: embedder.clone(),
                sharing_providers: vec![embedder],
                journal,
                jobs_root: Some(jobs_root(&inputs.base)),
                import_encoding: import_encoding(&inputs.raw),
            },
        )
        // Taken at the first Neo effect, after the gate and the embedding: three Neo budgets
        // (event lookup, edges, event; each lease wait is bounded by one), ended by shutdown.
        .with_effect_cancel(Arc::new(move || {
            shutdown.limited_to(Instant::now() + neo_budget(host.as_ref()) * 3)
        }));
        if journaled {
            return native;
        }
        let cache = cache.clone();
        native.with_effect_journal(Arc::new(move || match cache.get() {
            JournalFor::Bound(journal) => Ok(journal),
            JournalFor::Absent | JournalFor::Refused => {
                Err(crate::contract::StoreError::Unavailable.into())
            }
        }))
    }

    fn unavailable(&self) -> Unavailable {
        Unavailable {
            closed: self.inputs.closed.clone(),
        }
    }

    fn open(&self) -> Result<(), EngineError> {
        if self.inputs.closed.load(Ordering::Acquire) {
            return Err(self.unavailable().error());
        }
        self.inputs.shutdown.check()?;
        Ok(())
    }

    /// A call's token: engine shutdown and [`MEMORY_OP_BUDGET`], whichever comes first.
    fn budget(&self) -> Cancel {
        self.inputs
            .shutdown
            .limited_to(Instant::now() + MEMORY_OP_BUDGET)
    }

    /// Whether the journal could bind this caller for this operation: the admitted origin,
    /// a user principal with a logical workspace key and a host workspace directory (what
    /// `destructive_workspace` and `CaptureJournal::bind` require). Only a check of the
    /// request (no store, no file); the library authorizes the operation itself.
    fn partition(&self, principal: &Principal, agent: &AgentContext, admits: Admits) -> bool {
        let origin = match admits {
            Admits::User => agent.origin == TurnOrigin::User,
            Admits::UserOrSystem => matches!(agent.origin, TurnOrigin::User | TurnOrigin::System),
            Admits::System => agent.origin == TurnOrigin::System,
        };
        if !origin || agent.background {
            return false;
        }
        let host = self.inputs.host.as_ref();
        RequestContext::build(principal, agent, host)
            .is_ok_and(|ctx| is_user_principal(&ctx.owner_user_id) && !ctx.workspace_key.is_empty())
            && host
                .workspace_dir(&principal.agent_id)
                .is_ok_and(|dir| dir.is_some_and(|dir| !dir.as_os_str().is_empty()))
    }

    /// The Neo root is opened only for a caller with a partition, and created only when Neo
    /// is enabled (RE-D165).
    fn journal_for(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        admits: Admits,
    ) -> JournalFor {
        if !self.partition(principal, agent, admits) {
            return JournalFor::Refused;
        }
        self.cache.get()
    }

    fn facade(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        admits: Admits,
    ) -> Result<Facade, EngineError> {
        self.open()?;
        let journal = match self.journal_for(principal, agent, admits) {
            JournalFor::Bound(journal) => journal,
            JournalFor::Absent => return Ok(Facade::NeoOff(self.plain.clone())),
            JournalFor::Refused => return Ok(Facade::Refused(self.plain.clone())),
        };
        let mut slot = self
            .journaled
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(native) = slot.as_ref() {
            return Ok(Facade::Journaled(native.clone()));
        }
        let native = Arc::new(Self::compose(&self.inputs, &self.cache, Some(journal)));
        *slot = Some(native.clone());
        Ok(Facade::Journaled(native))
    }

    pub(super) fn correct(
        &self,
        id: &str,
        text: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCorrectResult, EngineError> {
        self.open()?;
        self.plain.correct(id, text, principal, agent)
    }

    pub(super) fn promote(
        &self,
        request: &MemoryPromoteRequest,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryPromotionResult, EngineError> {
        let budget = self.budget();
        match self.facade(principal, agent, Admits::UserOrSystem)? {
            Facade::Journaled(native) | Facade::Refused(native) => {
                native.promote_with_cancel(request, principal, agent, &budget)
            }
            Facade::NeoOff(native) => native.promote_neo_off(request, principal, agent, &budget),
        }
    }

    /// A preview reads ledgers and rows only. An applying run cleans the graph edges of what it
    /// rolled back under its original caller; without a Neo partition that cleanup is counted
    /// as an error (KNOWN-GAP F14/RE-D129), and with Neo off and no root there is nothing to
    /// clean (all counters 0, as at the pin).
    pub(super) fn unimport(
        &self,
        request: &MemoryUnimportRequest,
        cancel: &Cancel,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryUnimportResult, EngineError> {
        self.open()?;
        let mut graph = None;
        // A request for another agent is refused by the library before anything is read; it
        // never opens or creates Neo state.
        let own = request.agent_id == principal.agent_id;
        let effects: Arc<dyn UnimportEffects> = if request.dry_run == Some(false) && own {
            match self.journal_for(principal, agent, Admits::System) {
                JournalFor::Bound(journal) => {
                    graph = Some(journal);
                    Arc::new(FileUnimportEffects)
                }
                JournalFor::Absent => Arc::new(GraphCleanup(0)),
                JournalFor::Refused => Arc::new(GraphCleanup(1)),
            }
        } else {
            Arc::new(FileUnimportEffects)
        };
        let inputs = &self.inputs;
        let mut unimporter = Unimporter::new(
            inputs.operations.clone(),
            inputs.stores.clone(),
            Arc::new(ImportLedger::new(&inputs.base)),
            effects,
            inputs.base.clone(),
            Some(jobs_root(&inputs.base)),
        );
        if let Some(journal) = graph {
            unimporter = unimporter.with_graph_cleanup(journal);
        }
        unimporter.unimport(request, principal, agent, cancel)
    }
}

/// Archive and audit as [`FileUnimportEffects`]; the graph cleanup is not composed for this
/// caller and reports a fixed result (errors 1: not done; errors 0: nothing to clean).
struct GraphCleanup(usize);
impl UnimportEffects for GraphCleanup {
    fn archive(
        &self,
        row: &MemoryRow,
        agent: &str,
        state: &Path,
        now: i64,
    ) -> Result<PathBuf, EngineError> {
        FileUnimportEffects.archive(row, agent, state, now)
    }
    fn audit(&self, workspace: &Path, entry: &Value) -> Result<(), EngineError> {
        FileUnimportEffects.audit(workspace, entry)
    }
    fn cleanup(
        &self,
        _agent: &str,
        _workspace: Option<&Path>,
        _archive: &Path,
        _ids: &[String],
    ) -> Result<Option<UnimportCleanup>, EngineError> {
        Ok(Some(UnimportCleanup {
            cleanup_errors: self.0,
            ..Default::default()
        }))
    }
}

/// The pin's `join(baseDbPath, "_jobs")`, read by unimport for `jobsSinceImport`.
fn jobs_root(base: &Path) -> PathBuf {
    base.join("_jobs")
}

/// `engine.memory.proposals.*` and `engine.memory.propose`.
pub(super) struct ProposalsPort {
    served: Option<(Proposals, Arc<NativeSlot>)>,
    closed: Arc<AtomicBool>,
}

impl ProposalsPort {
    /// A writer of its own over the same pools and lifecycle as forget and share.
    pub(super) fn new(
        slot: Option<Arc<NativeSlot>>,
        sharing: Option<ShareServices>,
        closed: Arc<AtomicBool>,
    ) -> Self {
        let served = slot.zip(sharing).map(|(slot, sharing)| {
            let inputs = &slot.inputs;
            let writer = MemoryWriter::new(
                inputs.operations.clone(),
                inputs.stores.clone(),
                inputs.base.clone(),
            )
            .with_sharing(sharing);
            (Proposals::new(Arc::new(writer)), slot)
        });
        Self { served, closed }
    }

    fn served(&self) -> Result<&(Proposals, Arc<NativeSlot>), EngineError> {
        let unavailable = Unavailable {
            closed: self.closed.clone(),
        };
        if self.closed.load(Ordering::Acquire) {
            return Err(unavailable.error());
        }
        self.served.as_ref().ok_or_else(|| unavailable.error())
    }

    pub(super) fn propose(
        &self,
        id: &str,
        text: &str,
        options: &ProposeOptions,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposeResult, EngineError> {
        self.served()?
            .0
            .propose(id, text, options, principal, agent)
    }
}

impl MemoryProposalsOps for ProposalsPort {
    fn list(
        &self,
        query: MemoryProposalListQuery,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposalListResult, EngineError> {
        self.served()?.0.list(query, principal, agent)
    }
    fn accept(
        &self,
        id: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposalAcceptResult, EngineError> {
        // Accepting rewrites the shared copy through the correction writer.
        let slot = &self.served()?.1;
        slot.open()?;
        MemoryProposalsOps::accept(slot.plain.as_ref(), id, principal, agent)
    }
    fn reject(
        &self,
        id: &str,
        options: ProposalRejectOptions,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryProposalRejectResult, EngineError> {
        self.served()?.0.reject(id, options, principal, agent)
    }
}

/// `engine.memory.curation.*` with the call budget instead of the trait's unbounded token.
pub(super) struct CurationPort {
    slot: Option<Arc<NativeSlot>>,
    closed: Arc<AtomicBool>,
}

impl CurationPort {
    pub(super) fn new(slot: Option<Arc<NativeSlot>>, closed: Arc<AtomicBool>) -> Self {
        Self { slot, closed }
    }

    fn slot(&self) -> Result<&NativeSlot, EngineError> {
        let unavailable = Unavailable {
            closed: self.closed.clone(),
        };
        if self.closed.load(Ordering::Acquire) {
            return Err(unavailable.error());
        }
        self.slot.as_deref().ok_or_else(|| unavailable.error())
    }
}

impl MemoryCurationOps for CurationPort {
    fn list(
        &self,
        query: MemoryCurationListQuery,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCurationListResult, EngineError> {
        let slot = self.slot()?;
        let budget = slot.budget();
        match slot.facade(principal, agent, Admits::User)? {
            Facade::Journaled(native) => match native.native_curation() {
                Some(curation) => curation.list_with_cancel(&query, principal, agent, &budget),
                None => native.curation().list(query, principal, agent),
            },
            Facade::NeoOff(native) => {
                native.curation_list_neo_off(&query, principal, agent, &budget)
            }
            Facade::Refused(native) => native.curation().list(query, principal, agent),
        }
    }
    fn resolve(
        &self,
        id: &str,
        action: MemoryCurationAction,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCurationResolveResult, EngineError> {
        let slot = self.slot()?;
        let budget = slot.budget();
        match slot.facade(principal, agent, Admits::User)? {
            Facade::Journaled(native) => match native.native_curation() {
                Some(curation) => {
                    curation.resolve_with_cancel(id, action, principal, agent, &budget)
                }
                None => native.curation().resolve(id, action, principal, agent),
            },
            Facade::NeoOff(native) => native.curation_resolve_neo_off(principal, agent),
            Facade::Refused(native) => native.curation().resolve(id, action, principal, agent),
        }
    }
}
