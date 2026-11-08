//! Concrete host/provider/policy capabilities for the F7 coordinator.
use super::{
    backend::GenerationBackend,
    coordinator::CoordinatorError as Error,
    coordinator_ports::{MigrationProvider, MigrationRuntime},
    projection, validation,
};
use crate::{
    contract::{Cancel, EmbedKind, EngineConfig, HostServices, VectorSpaceIdentity},
    embedding::{self, EmbeddingProvider},
    ops::{
        models::{inspect_artifacts, ArtifactStatus},
        workspace_policy::PolicyStore,
    },
    store::{directory::TrustedDirectory, paths::assert_trusted_path},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
fn check(c: &Cancel) -> Result<(), Error> {
    c.check().map_err(|_| Error::Cancelled)
}
fn value(raw: &Json) -> Result<Value, Error> {
    serde_json::from_str(&write_json(raw))
        .map_err(|_| Error::Invalid("invalid target provider specification"))
}
fn raw(v: &Value) -> Result<Json, Error> {
    parse_json(&v.to_string()).map_err(|_| Error::Host)
}
struct ProviderLease {
    identity: VectorSpaceIdentity,
    provider: Mutex<Option<Box<dyn EmbeddingProvider>>>,
}
impl ProviderLease {
    fn new(provider: Box<dyn EmbeddingProvider>) -> Self {
        Self {
            identity: provider.identity().clone(),
            provider: Mutex::new(Some(provider)),
        }
    }
}
impl MigrationProvider for ProviderLease {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(&self, texts: &[String], kind: EmbedKind, c: &Cancel) -> Result<Vec<Vec<f64>>, Error> {
        check(c)?;
        let lease = self.provider.lock().map_err(|_| Error::Provider)?;
        let provider = lease.as_ref().ok_or(Error::Closed)?;
        let result = provider.embed(texts, kind, c).map_err(|_| {
            if c.is_cancelled() {
                Error::Cancelled
            } else {
                Error::Provider
            }
        })?;
        check(c)?;
        Ok(result
            .into_iter()
            .map(|v| v.into_iter().map(f64::from).collect())
            .collect())
    }
    fn close(&self) -> Result<(), Error> {
        let mut provider = self.provider.lock().map_err(|_| Error::Provider)?;
        drop(provider.take());
        Ok(())
    }
}
/// Actual coordinator dependencies over the owning host, selected generation and policy store.
/// Construction is read-only; every provider uses the existing guarded production factory.
pub struct NativeRuntime {
    host: Arc<dyn HostServices>,
    backend: Arc<GenerationBackend>,
    policy: PolicyStore,
    state_root: PathBuf,
}
impl NativeRuntime {
    /// Bind trusted host roots; no model, store or directory is created by this constructor.
    pub fn new(
        host: Arc<dyn HostServices>,
        backend: Arc<GenerationBackend>,
        state_root: &Path,
    ) -> Result<Self, Error> {
        assert_trusted_path(state_root).map_err(|_| Error::Host)?;
        Ok(Self {
            host,
            backend,
            policy: PolicyStore::new(state_root).map_err(|_| Error::Host)?,
            state_root: state_root.to_owned(),
        })
    }
    fn projected_config(&self, target: &Value) -> Result<(EngineConfig, PathBuf), Error> {
        let mut config = serde_json::to_value(self.host.config()).map_err(|_| Error::Host)?;
        let current = config
            .get("embedding")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut projected = projection::embedding_config(target, &current)
            .map_err(|_| Error::Invalid("invalid target provider specification"))?;
        let cache = current
            .pointer("/local/cacheDir")
            .or_else(|| current.get("cacheDir"))
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| self.host.state_dir().join("models"));
        if projected["provider"] == "local-transformers" {
            projected["local"]["cacheDir"] = json!(cache);
        }
        config["embedding"] = projected;
        Ok((
            crate::config::validate(&config)
                .map_err(|_| Error::Invalid("invalid target provider configuration"))?,
            cache,
        ))
    }
}
impl MigrationRuntime for NativeRuntime {
    fn now_ms(&self) -> i64 {
        self.host.now_ms()
    }
    fn free_bytes(&self, c: &Cancel) -> Result<u64, Error> {
        available_bytes(&self.state_root, c)
    }
    fn artifacts_verified(&self, fingerprint: &Json, c: &Cancel) -> Result<bool, Error> {
        check(c)?;
        let fingerprint = value(fingerprint)?;
        let model = fingerprint["model"]
            .as_str()
            .ok_or(Error::Invalid("invalid local model fingerprint"))?;
        let profile = embedding::artifacts::pinned_profile(model, fingerprint["dtype"].as_str())
            .filter(|p| {
                p.role == "embedding" && fingerprint["revision"].as_str() == Some(&p.revision)
            })
            .ok_or(Error::Invalid("unavailable pinned target model"))?;
        let (_, cache) = self.projected_config(&json!({"fingerprint":fingerprint}))?;
        let status = inspect_artifacts(profile, Some(&cache), c).map_err(|_| Error::Cancelled)?;
        check(c)?;
        Ok(status == ArtifactStatus::Verified)
    }
    fn plan_probe(&self, target: &Json, c: &Cancel) -> Result<Vec<f64>, Error> {
        let provider = self.create_provider(target, c)?;
        let result = provider.embed(
            &["PLUR1BUS reembedding-plan provider probe".into()],
            EmbedKind::Passage,
            c,
        );
        provider.close()?;
        let mut vectors = result?;
        if vectors.len() != 1 {
            return Err(Error::Invalid("target embedding probe result mismatch"));
        }
        vectors.pop().ok_or(Error::Provider)
    }
    fn create_provider(
        &self,
        target: &Json,
        c: &Cancel,
    ) -> Result<Box<dyn MigrationProvider>, Error> {
        check(c)?;
        let target = value(target)?;
        let (config, _) = self.projected_config(&target)?;
        let provider = embedding::planned::build_for_fingerprint(
            &config,
            self.host.clone(),
            &target["fingerprint"],
        )
        .map_err(|_| Error::Provider)?;
        check(c)?;
        Ok(Box::new(ProviderLease::new(provider)))
    }
    fn policy_snapshot(&self, c: &Cancel) -> Result<Option<Json>, Error> {
        check(c)?;
        let policies = self.policy.list().map_err(|_| Error::Host)?;
        check(c)?;
        Ok(Some(raw(&policies)?))
    }
    fn validate_probes(
        &self,
        record: &Json,
        provider: &dyn MigrationProvider,
        c: &Cancel,
    ) -> Result<Json, Error> {
        raw(&validation::validate(record, &self.backend, provider, c)?)
    }
}
/// Read the capacity of the nearest existing trusted ancestor without creating a target directory.
fn available_bytes(path: &Path, c: &Cancel) -> Result<u64, Error> {
    check(c)?;
    assert_trusted_path(path).map_err(|_| Error::Host)?;
    let mut existing = path;
    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                existing = existing.parent().ok_or(Error::Host)?
            }
            Err(_) => return Err(Error::Host),
        }
    }
    let directory = TrustedDirectory::open(existing).map_err(|_| Error::Host)?;
    let available = platform_available(&directory)?;
    directory.assert_unchanged().map_err(|_| Error::Host)?;
    check(c)?;
    Ok(available)
}
#[cfg(unix)]
fn platform_available(directory: &TrustedDirectory) -> Result<u64, Error> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(directory.lance_path().as_os_str().as_bytes())
        .map_err(|_| Error::Host)?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: path is NUL terminated, the directory capability stays alive, and stat is writable.
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(Error::Host);
    }
    // SAFETY: successful statvfs initialized the complete output structure.
    let stat = unsafe { stat.assume_init() };
    let size = if stat.f_frsize == 0 {
        stat.f_bsize
    } else {
        stat.f_frsize
    };
    u64::try_from(u128::from(stat.f_bavail) * u128::from(size)).map_err(|_| Error::Host)
}
#[cfg(windows)]
fn platform_available(directory: &TrustedDirectory) -> Result<u64, Error> {
    use std::os::windows::ffi::OsStrExt;
    let path = directory
        .path()
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut available = 0u64;
    // SAFETY: path is NUL terminated, output points to a live u64, optional outputs are null.
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(Error::Host);
    }
    Ok(available)
}
#[cfg(not(any(unix, windows)))]
fn platform_available(_: &TrustedDirectory) -> Result<u64, Error> {
    Err(Error::Host)
}
#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
