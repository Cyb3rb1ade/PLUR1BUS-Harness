//! The remaining memory operations in the process (RE-D165): correct, the proposals,
//! unimport, promote and curation, composed over the native facade and the process pools.
//!
//! The facade (`ops::facade::NativeMemory`) needs the human-operation Neo journal. It is
//! composed once, lazily, by the first operation that needs it: correct, proposal acceptance,
//! an unimport that applies, promote and curation. Reads, share, propose, proposal list and
//! reject and an unimport preview never compose it, so they create no Neo state. Every
//! operation runs in the foreground with its caller's principal; the library's ACL, owner
//! and policy checks decide, nothing here grants authority.

use super::{engine_stores::EngineStores, Unavailable};
use crate::{
    capture::shared_scope::{CapturePolicy, WorkspaceCapturePolicy},
    contract::{
        AgentContext, Cancel, EngineError, HostServices, MemoryCurationAction,
        MemoryCurationListQuery, MemoryCurationListResult, MemoryCurationOps,
        MemoryCurationResolveResult, MemoryPromoteRequest, MemoryPromotionResult,
        MemoryProposalAcceptResult, MemoryProposalListQuery, MemoryProposalListResult,
        MemoryProposalRejectResult, MemoryProposalsOps, MemoryProposeResult, MemoryUnimportRequest,
        MemoryUnimportResult, Principal, ProposalRejectOptions, ProposeOptions,
    },
    embedding::EmbeddingProvider,
    neo::capture_journal::CaptureJournal,
    ops::{
        context::OperationContext,
        facade::{MemoryPorts, NativeMemory},
        import_ledger::ImportLedger,
        import_row::ImportEncoding,
        proposals::Proposals,
        reembedding::state::MigrationStateStore,
        sharing::ShareServices,
        unimport::{FileUnimportEffects, Unimporter},
        write::MemoryWriter,
    },
};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, PoisonError,
    },
    time::{Duration, Instant},
};

/// The deadline of a promote or curation call, linked to engine shutdown. Every lease these
/// paths wait for has its own shorter bound (the Neo budget); this bounds the whole call.
const MEMORY_OP_BUDGET: Duration = Duration::from_secs(60);

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

/// What the facade is composed from; nothing here opens a store or a file.
pub(super) struct SlotInputs {
    pub(super) operations: Arc<OperationContext>,
    pub(super) stores: Arc<EngineStores>,
    pub(super) base: PathBuf,
    pub(super) neo_root: PathBuf,
    pub(super) embedder: Arc<dyn EmbeddingProvider>,
    pub(super) host: Arc<dyn HostServices>,
    pub(super) raw: Value,
    pub(super) shutdown: Cancel,
    pub(super) closed: Arc<AtomicBool>,
}

struct Native {
    memory: NativeMemory,
    journal: Arc<CaptureJournal>,
}

/// The lazily composed facade. Composition holds the slot lock only for creating the Neo
/// root directory and opening it (a bounded file-system step), never across an operation.
pub(super) struct NativeSlot {
    inputs: SlotInputs,
    native: Mutex<Option<Arc<Native>>>,
}

impl NativeSlot {
    pub(super) fn new(inputs: SlotInputs) -> Self {
        Self {
            inputs,
            native: Mutex::new(None),
        }
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

    fn native(&self) -> Result<Arc<Native>, EngineError> {
        self.open()?;
        let mut slot = self.native.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(native) = slot.as_ref() {
            return Ok(native.clone());
        }
        let inputs = &self.inputs;
        // The pin keeps Neo state under `neo.statePath` (default `<baseDbPath>/_neo`) and
        // creates it on first use; the human-operation journal pins it as capture does.
        crate::store::paths::secure_dir(&inputs.neo_root)?;
        let switching = inputs.base.clone();
        // Human operations follow the explicit workspace decision: an enabled workspace that
        // is not in a re-embedding switch (the same state file capture reads).
        let policy: Arc<dyn CapturePolicy> = Arc::new(
            WorkspaceCapturePolicy::new(inputs.base.clone()).with_maintenance(Arc::new(
                move || {
                    MigrationStateStore::new(&switching)
                        .and_then(|store| store.switching())
                        .unwrap_or(true)
                },
            )),
        );
        let journal = Arc::new(CaptureJournal::open(
            &inputs.neo_root,
            inputs.host.clone(),
            policy,
        )?);
        let stores = inputs.stores.clone();
        let memory = NativeMemory::new(
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
                embedder: inputs.embedder.clone(),
                sharing_providers: vec![inputs.embedder.clone()],
                journal: journal.clone(),
                jobs_root: Some(jobs_root(&inputs.base)),
                import_encoding: import_encoding(&inputs.raw),
            },
        );
        let native = Arc::new(Native { memory, journal });
        *slot = Some(native.clone());
        Ok(native)
    }

    pub(super) fn correct(
        &self,
        id: &str,
        text: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<crate::contract::MemoryCorrectResult, EngineError> {
        crate::contract::MemoryOps::correct(&self.native()?.memory, id, text, principal, agent)
    }

    pub(super) fn promote(
        &self,
        request: &MemoryPromoteRequest,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryPromotionResult, EngineError> {
        let native = self.native()?;
        native
            .memory
            .promote_with_cancel(request, principal, agent, &self.budget())
    }

    /// A preview reads ledgers and rows only; an applying run also cleans the graph edges of
    /// what it rolled back, under the original caller (an owner without a user principal has
    /// no Neo partition: counted as a cleanup error, KNOWN-GAP F14/RE-D129).
    pub(super) fn unimport(
        &self,
        request: &MemoryUnimportRequest,
        cancel: &Cancel,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryUnimportResult, EngineError> {
        self.open()?;
        let graph = if request.dry_run == Some(false) {
            Some(self.native()?.journal.clone())
        } else {
            None
        };
        let inputs = &self.inputs;
        let mut unimporter = Unimporter::new(
            inputs.operations.clone(),
            inputs.stores.clone(),
            Arc::new(ImportLedger::new(&inputs.base)),
            Arc::new(FileUnimportEffects),
            inputs.base.clone(),
            Some(jobs_root(&inputs.base)),
        );
        if let Some(journal) = graph {
            unimporter = unimporter.with_graph_cleanup(journal);
        }
        unimporter.unimport(request, principal, agent, cancel)
    }
}

/// The pin's `join(baseDbPath, "_jobs")`, read by unimport for `jobsSinceImport`.
fn jobs_root(base: &std::path::Path) -> PathBuf {
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
        let native = self.served()?.1.native()?;
        MemoryProposalsOps::accept(&native.memory, id, principal, agent)
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
        let native = slot.native()?;
        native
            .memory
            .native_curation()
            .list_with_cancel(&query, principal, agent, &slot.budget())
    }
    fn resolve(
        &self,
        id: &str,
        action: MemoryCurationAction,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryCurationResolveResult, EngineError> {
        let slot = self.slot()?;
        let native = slot.native()?;
        native.memory.native_curation().resolve_with_cancel(
            id,
            action,
            principal,
            agent,
            &slot.budget(),
        )
    }
}
