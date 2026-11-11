//! RE-D170: process-owned implementation of the F9 snapshot entry points.
//!
//! Composition (wait graph): create, verify and reapply wait on nothing. A create takes no
//! mutation gate, excludes no writer and pauses no compaction; at most one create and one
//! reapply run per process, a second answers `engine-busy` at once. Reapply holds the
//! engine-wide mutation gate only for one row patch at a time (as `forget`), with the gate's
//! own bounded wait. Connection, request and process stop end every step.
use super::seams::Seam;
use crate::{
    contract::StoreError,
    contract::{
        Cancel, EngineError, HostServices, SnapshotFailure, SnapshotGrant, SnapshotMethod,
        SnapshotOps,
    },
    ops::{
        migrate::{FileMaintenanceAudit, MaintenanceAudit},
        snapshot::{
            snapshot_create::{prepare, CreateRequest, SnapshotRoots},
            verify_snapshot_cancellable, SnapshotError,
        },
        tombstone_reapply::{reapply, NamespaceReapplyTarget, ReapplyMutation, ReapplyTarget},
        tombstones::TombstoneLookup,
    },
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

/// Private process hook for the snapshot process tests: while `<dir>/hold` exists, a create
/// waits after its first copied file (writing `<dir>/held`), until the file is removed or the
/// call is cancelled (writing `<dir>/cancelled`). Read only under an authorized seam.
pub const HOLD_VARIABLE: &str = "PLUR1BUS_TEST_SNAPSHOT_HOLD";
/// Private process hook: the free bytes the disk check sees. Read only under an authorized seam.
pub const FREE_VARIABLE: &str = "PLUR1BUS_TEST_SNAPSHOT_FREE_BYTES";
const HOLD_LIMIT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(5);
/// JavaScript's `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Reapply's view of the engine process: its own namespace routes after S5 recovery, the
/// engine-wide mutation gate and the engine's close.
pub trait ReapplyRoutes: Send + Sync {
    /// The active writer routes, or `None` when the configured store root does not exist.
    fn reapply_target(&self) -> Result<Option<NamespaceReapplyTarget>, EngineError>;
    /// Whether the engine has begun to close.
    fn stopped(&self) -> bool;
}

/// No store root: every committed tombstone is reported `notFound`, nothing is created.
struct NoStores;
impl TombstoneLookup for NoStores {
    fn agent_exists(&self, _: &str) -> Result<bool, StoreError> {
        Ok(false)
    }
    fn status(&self, _: &str, _: &str) -> Result<Option<String>, StoreError> {
        Ok(None)
    }
}
impl ReapplyTarget for NoStores {
    fn tombstone(&self, _: &str, _: &str) -> Result<ReapplyMutation, StoreError> {
        Ok(ReapplyMutation::NotFound)
    }
}

/// One running call of a kind per process; released on drop.
struct Slot<'a>(&'a AtomicBool);
impl<'a> Slot<'a> {
    fn take(flag: &'a AtomicBool) -> Result<Self, SnapshotFailure> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self(flag))
            .map_err(|_| busy())
    }
}
impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn busy() -> SnapshotFailure {
    SnapshotFailure::Engine(EngineError::NotAvailable {
        reason: "engine-busy".into(),
    })
}
fn unavailable(reason: &str) -> SnapshotFailure {
    SnapshotFailure::Engine(EngineError::NotAvailable {
        reason: reason.into(),
    })
}

/// Native snapshot facade over the configured process store base and the host state directory.
pub struct ProcessSnapshots {
    host: Arc<dyn HostServices>,
    base: Option<PathBuf>,
    audit: Arc<dyn MaintenanceAudit>,
    routes: Arc<dyn ReapplyRoutes>,
    create_running: AtomicBool,
    reapply_running: AtomicBool,
    hold: Option<PathBuf>,
    free_bytes: Option<u64>,
}

impl ProcessSnapshots {
    /// Bind the base, the audit ledger and the engine's routes; nothing is opened or created.
    pub fn new(host: Arc<dyn HostServices>, routes: Arc<dyn ReapplyRoutes>) -> Self {
        Self::with_seam(host, routes, None)
    }

    /// As `new`; an authorized process seam also reads the two private test hooks.
    pub fn with_seam(
        host: Arc<dyn HostServices>,
        routes: Arc<dyn ReapplyRoutes>,
        seam: Option<Seam>,
    ) -> Self {
        let hold = seam
            .and_then(|_| std::env::var_os(HOLD_VARIABLE))
            .map(PathBuf::from);
        let free_bytes = seam
            .and_then(|_| std::env::var(FREE_VARIABLE).ok())
            .and_then(|value| value.parse().ok());
        let base = host
            .config()
            .base_db_path
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
        let audit = Arc::new(FileMaintenanceAudit::new(
            host.state_dir().join("engine-maintenance.jsonl"),
        ));
        Self {
            host,
            base,
            audit,
            routes,
            create_running: AtomicBool::new(false),
            reapply_running: AtomicBool::new(false),
            hold,
            free_bytes,
        }
    }

    fn admit(&self, grant: &SnapshotGrant, cancel: &Cancel) -> Result<&Path, SnapshotFailure> {
        grant.check(cancel)?;
        if self.routes.stopped() {
            return Err(unavailable("closed"));
        }
        self.base
            .as_deref()
            .ok_or_else(|| unavailable("composition-pending"))
    }

    /// The required content-free audit line; a failed append prevents the mutation.
    fn audit(
        &self,
        grant: &SnapshotGrant,
        method: SnapshotMethod,
        target: &Value,
    ) -> Result<(), SnapshotFailure> {
        self.audit.append(
            &json!({"kind":"engine-snapshot","method":method.wire_name(),
            "actor":"core-snapshot","coreLink":grant.origin(),"target":target,
            "at":self.host.now_ms()}),
        )?;
        Ok(())
    }

    /// Mark a create and/or a reapply as running (tests only).
    #[cfg(test)]
    pub(crate) fn set_running(&self, create: bool, reapply: bool) {
        self.create_running.store(create, Ordering::Release);
        self.reapply_running.store(reapply, Ordering::Release);
    }

    /// Per copied file: the engine's close ends the copy; the authorized hold hook waits here.
    fn progress(&self, cancel: &Cancel) -> Result<(), SnapshotError> {
        if self.routes.stopped() {
            return Err(SnapshotError::Cancelled);
        }
        let Some(directory) = &self.hold else {
            return Ok(());
        };
        let hold = directory.join("hold");
        if !hold.exists() {
            return Ok(());
        }
        std::fs::write(directory.join("held"), b"").map_err(|_| SnapshotError::Storage)?;
        let until = Instant::now() + HOLD_LIMIT;
        while hold.exists() {
            if cancel.is_cancelled() || self.routes.stopped() {
                // Proof for the process tests that the revoked grant ended the copy.
                let _ = std::fs::write(directory.join("cancelled"), b"");
                return Err(SnapshotError::Cancelled);
            }
            if Instant::now() >= until {
                return Err(SnapshotError::Storage);
            }
            std::thread::sleep(POLL);
        }
        Ok(())
    }
}

impl SnapshotOps for ProcessSnapshots {
    fn create(
        &self,
        grant: &SnapshotGrant,
        out: &Path,
        cancel: &Cancel,
    ) -> Result<Value, SnapshotFailure> {
        let base = self.admit(grant, cancel)?;
        let _slot = Slot::take(&self.create_running)?;
        let progress = |_: &str| self.progress(cancel);
        let request = CreateRequest {
            state_dir: self.host.state_dir(),
            base,
            out,
            now_ms: self.host.now_ms(),
            free_bytes: self.free_bytes,
            progress: Some(&progress),
        };
        let plan = match prepare(&SnapshotRoots::new(self.host.state_dir()), request) {
            Ok(plan) => plan,
            Err(error) => {
                self.audit(grant, SnapshotMethod::Create, &json!({"invalid":true}))?;
                return Err(error.into());
            }
        };
        self.audit(grant, SnapshotMethod::Create, &json!({"id":plan.id()}))?;
        grant.check(cancel)?;
        let report = plan.execute(cancel)?;
        serde_json::to_value(report).map_err(|_| SnapshotFailure::Snapshot(SnapshotError::Storage))
    }

    fn verify(
        &self,
        grant: &SnapshotGrant,
        dir: &Path,
        cancel: &Cancel,
    ) -> Result<Value, SnapshotFailure> {
        self.admit(grant, cancel)?;
        let dir = SnapshotRoots::new(self.host.state_dir()).bind_snapshot(dir)?;
        let report = verify_snapshot_cancellable(&dir, cancel)?;
        // JavaScript numbers: an integral byte count is written as the pin writes it (`52`,
        // not `52.0`); any other `Number(manifest.bytes)` stays a double.
        let bytes = if report.bytes.fract() == 0.0 && report.bytes.abs() <= MAX_SAFE_INTEGER {
            json!(report.bytes as i64)
        } else {
            json!(report.bytes)
        };
        Ok(json!({"id":report.id,"files":report.files,"bytes":bytes}))
    }

    fn reapply(&self, grant: &SnapshotGrant, cancel: &Cancel) -> Result<Value, SnapshotFailure> {
        let base = self.admit(grant, cancel)?;
        let _slot = Slot::take(&self.reapply_running)?;
        self.audit(grant, SnapshotMethod::Reapply, &json!({}))?;
        grant.check(cancel)?;
        let report = match self.routes.reapply_target()? {
            Some(target) => reapply(base, &target, true, cancel)?,
            None => reapply(base, &NoStores, true, cancel)?,
        };
        serde_json::to_value(report).map_err(|_| SnapshotFailure::Snapshot(SnapshotError::Storage))
    }
}
