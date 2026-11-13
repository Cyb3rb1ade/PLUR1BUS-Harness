//! Real bounded rate-limit file updates; successful recording is not an idempotent job receipt.
use super::{check, record, Key};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    jobs::ledger::io,
    store::{
        directory::{regular_file_identity, TrustedDirectory},
        kernel_lease,
    },
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use std::{io::Write, path::Path, sync::Arc};
const FILE: &str = "run-state.json";
const MAX_BYTES: usize = 2 * 1024 * 1024;
type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
#[cfg(feature = "testkit")]
type Observer = Arc<dyn Fn(&str) -> Result<(), EngineError> + Send + Sync>;

/// Existing caller-selected physical state directory. Construction grants no memory/tenant access.
/// Reads create nothing. Writes serialize cooperating native updaters and preserve unrelated JSON.
pub struct RateLimitStore {
    dir: TrustedDirectory,
    clock: Clock,
    #[cfg(feature = "testkit")]
    observer: Option<Observer>,
}
impl RateLimitStore {
    /// Retain the existing ordinary directory and the host clock; no state or lock files are created.
    pub fn open(root: &Path, clock: Clock) -> Result<Self, EngineError> {
        Ok(Self {
            dir: TrustedDirectory::open(root)?,
            clock,
            #[cfg(feature = "testkit")]
            observer: None,
        })
    }
    /// Observe post-fsync/pre-rename and committed boundaries in isolated fault/crash fixtures only.
    #[cfg(feature = "testkit")]
    #[must_use]
    pub fn with_observer(mut self, observer: Observer) -> Self {
        self.observer = Some(observer);
        self
    }
    fn observe(&self, _stage: &str) -> Result<(), EngineError> {
        #[cfg(feature = "testkit")]
        if let Some(observer) = &self.observer {
            observer(_stage)?;
        }
        Ok(())
    }
    /// Read a complete bounded snapshot; corrupt/untrusted state is an error, never an empty fallback.
    pub fn check(&self, key: &Key, interval_ms: f64, cancel: &Cancel) -> Result<Json, EngineError> {
        let bytes = io::read(&self.dir, FILE, MAX_BYTES, cancel)?;
        let state = decode(bytes.as_deref())?;
        let result = check(state.as_ref(), key, interval_ms, (self.clock)(), cancel)?;
        self.dir.assert_unchanged()?;
        cancel.check()?;
        Ok(result)
    }
    /// Record one successful run. A crash after rename may already count it; retries increment again
    /// as Node does. This API does not execute, reserve or replay a body and is not an exactly-once grant.
    pub fn record(&self, key: &Key, cancel: &Cancel) -> Result<(), EngineError> {
        self.update(cancel, |state, now| record(state, key, now, cancel))
    }

    /// Read the existing state without opening a writer lease.
    pub(crate) fn snapshot(&self, cancel: &Cancel) -> Result<Option<Json>, EngineError> {
        decode(io::read(&self.dir, FILE, MAX_BYTES, cancel)?.as_deref())
    }

    /// Reuse the run-state writer when another job updates an independent field.
    pub(crate) fn update(
        &self,
        cancel: &Cancel,
        apply: impl FnOnce(Option<&Json>, f64) -> Result<Json, EngineError>,
    ) -> Result<(), EngineError> {
        cancel.check()?;
        self.dir.assert_unchanged()?;
        self.dir.restrict_private()?;
        let lease = kernel_lease::acquire(&self.dir, "run-state-writer", cancel, &mut || {})?;
        let old = io::read(&self.dir, FILE, MAX_BYTES, cancel)?;
        let identity = io::identity(&self.dir, FILE)?;
        let state = decode(old.as_deref())?;
        let next = write_json(&apply(state.as_ref(), (self.clock)())?);
        if next.len() > MAX_BYTES {
            return Err(StoreError::Corrupt.into());
        }
        self.staging_bound(cancel)?;
        let name = format!(".native-run-state-{}.tmp", uuid::Uuid::new_v4());
        let mut file = self.dir.create_file(&name)?;
        let staged_identity = regular_file_identity(&file)?;
        let _cleanup = Staging {
            dir: &self.dir,
            name: &name,
            identity: staged_identity,
        };
        file.write_all(next.as_bytes()).map_err(StoreError::from)?;
        file.sync_all().map_err(StoreError::from)?;
        drop(file);
        self.observe("prepared")?;
        cancel.check()?;
        lease.check(&self.dir)?;
        if io::read(&self.dir, FILE, MAX_BYTES, cancel)? != old
            || io::identity(&self.dir, FILE)? != identity
        {
            return Err(StoreError::Unavailable.into());
        }
        if io::read(&self.dir, &name, MAX_BYTES, cancel)?.as_deref() != Some(next.as_bytes()) {
            return Err(StoreError::Unavailable.into());
        }
        self.dir
            .replace_staged(&name, FILE, staged_identity, identity)?;
        self.observe("committed")?;
        cancel.check()?;
        lease.check(&self.dir)?;
        if io::identity(&self.dir, FILE)? != Some(staged_identity)
            || io::read(&self.dir, FILE, MAX_BYTES, cancel)?.as_deref() != Some(next.as_bytes())
        {
            return Err(StoreError::Unavailable.into());
        }
        Ok(())
    }
    fn staging_bound(&self, cancel: &Cancel) -> Result<(), EngineError> {
        self.dir.assert_unchanged()?;
        let mut staged = 0;
        for (index, item) in std::fs::read_dir(self.dir.path())
            .map_err(StoreError::from)?
            .enumerate()
        {
            cancel.check()?;
            if index >= 50_000 {
                return Err(StoreError::Corrupt.into());
            }
            let item = item.map_err(StoreError::from)?;
            if item
                .file_name()
                .to_string_lossy()
                .starts_with(".native-run-state-")
            {
                staged += 1;
            }
            if staged >= 128 {
                return Err(StoreError::Corrupt.into());
            }
        }
        self.dir.assert_unchanged()?;
        Ok(())
    }
}
fn decode(bytes: Option<&[u8]>) -> Result<Option<Json>, EngineError> {
    bytes
        .map(|bytes| {
            parse_json(std::str::from_utf8(bytes).map_err(|_| StoreError::Corrupt)?)
                .map_err(|_| StoreError::Corrupt.into())
        })
        .transpose()
}
struct Staging<'a> {
    dir: &'a TrustedDirectory,
    name: &'a str,
    identity: (u64, u64),
}
impl Drop for Staging<'_> {
    fn drop(&mut self) {
        if io::identity(self.dir, self.name).ok().flatten() == Some(self.identity) {
            let _ = self.dir.remove_file(self.name);
        }
    }
}
