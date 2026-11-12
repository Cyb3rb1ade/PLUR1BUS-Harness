//! Private namespace route construction; shared and optional sources belong to T6/RE-07.

use crate::contract::{EngineConfig, StoreError, VectorSpaceIdentity};
use crate::ops::reembedding::backend::{generation, read_generation_manifest};
use crate::store::directory::TrustedDirectory;
use crate::store::paths::{namespace_path, secure_dir};
use crate::store::{OpenMode, Store, StoreIdentityResolver, StorePool, StoreRoute, StoreRoutes};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Immutable pools for the writer, active recall tables and read-only legacy tables.
pub struct NamespaceStores {
    base: PathBuf,
    read: Vec<StoreRoute>,
    writer: StoreRoute,
    root_pins: Vec<Arc<TrustedDirectory>>,
}

impl NamespaceStores {
    /// Resolve `EngineConfig.namespaces` with Node defaults and retain directory pins.
    /// Missing legacy routes are never created; active routes are created lazily by RE-02.
    pub fn open(
        base: &Path,
        config: &EngineConfig,
        identity: &VectorSpaceIdentity,
        capacity: usize,
    ) -> Result<Self, StoreError> {
        Self::open_with_identity_resolver(
            base,
            config,
            identity,
            Arc::new(FixedIdentity(identity.clone())),
            capacity,
        )
    }

    /// Resolve expected identities for all route/agent pairs before opening their stores.
    /// Both lease modes reject mismatches. Missing metadata inherits the expectation.
    pub fn open_with_identity_resolver(
        base: &Path,
        config: &EngineConfig,
        identity: &VectorSpaceIdentity,
        resolver: Arc<dyn StoreIdentityResolver>,
        capacity: usize,
    ) -> Result<Self, StoreError> {
        let layout = Layout::from_config(base, config)?;
        let root_pin = layout.root_pin()?;
        Self::build(
            layout,
            root_pin.as_slice(),
            identity,
            resolver,
            capacity,
            OpenMode::ReadWrite,
        )
    }

    /// Open routes for an existing layout, without establishing a missing root.
    pub(crate) fn open_existing(
        base: &Path,
        config: &EngineConfig,
        identity: &VectorSpaceIdentity,
        capacity: usize,
    ) -> Result<Option<Self>, StoreError> {
        Self::open_existing_mode(base, config, identity, capacity, OpenMode::ReadWrite)
    }

    /// Warming never opens a writable handle or repairs the selected generation.
    pub(crate) fn open_for_warm(
        base: &Path,
        config: &EngineConfig,
        identity: &VectorSpaceIdentity,
        fingerprint: &str,
        capacity: usize,
    ) -> Result<Option<Self>, StoreError> {
        let mode = OpenMode::ReadOnly;
        if config.reembedding.is_some() {
            Self::open_generation_mode(base, config, identity, fingerprint, capacity, mode)
                .map(Some)
        } else {
            Self::open_existing_mode(base, config, identity, capacity, mode)
        }
    }

    fn open_existing_mode(
        base: &Path,
        config: &EngineConfig,
        identity: &VectorSpaceIdentity,
        capacity: usize,
        mode: OpenMode,
    ) -> Result<Option<Self>, StoreError> {
        let layout = Layout::from_config(base, config)?;
        let root = match TrustedDirectory::open(&layout.base) {
            Ok(root) => Arc::new(root),
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => return Ok(None),
            Err(error) => return Err(error),
        };
        Self::build(
            layout,
            std::slice::from_ref(&root),
            identity,
            Arc::new(FixedIdentity(identity.clone())),
            capacity,
            mode,
        )
        .map(Some)
    }

    /// Use the selected generation only after its manifest and active model agree.
    pub(crate) fn open_generation(
        base: &Path,
        config: &EngineConfig,
        identity: &VectorSpaceIdentity,
        fingerprint: &str,
        capacity: usize,
    ) -> Result<Self, StoreError> {
        Self::open_generation_mode(
            base,
            config,
            identity,
            fingerprint,
            capacity,
            OpenMode::ReadWrite,
        )
    }

    fn open_generation_mode(
        base: &Path,
        config: &EngineConfig,
        identity: &VectorSpaceIdentity,
        fingerprint: &str,
        capacity: usize,
        mode: OpenMode,
    ) -> Result<Self, StoreError> {
        let selected = config
            .reembedding
            .as_ref()
            .ok_or(StoreError::InvalidInput)?;
        let id = &selected.active_generation;
        generation(id).map_err(|_| StoreError::InvalidInput)?;
        if selected.fingerprint_id != fingerprint
            || selected.dimensions.as_f64() != identity.dimension.as_f64()
        {
            return Err(StoreError::IdentityMismatch);
        }

        let mut layout = Layout::from_config(base, config)?;
        let base = Arc::new(TrustedDirectory::open(&layout.base)?);
        let generations = Arc::new(base.open_child("generations")?);
        let root = Arc::new(generations.open_child(id)?);
        let manifest = read_generation_manifest(&root, id)?;
        if manifest["fingerprintId"] != fingerprint
            || manifest["dimensions"].as_f64() != selected.dimensions.as_f64()
        {
            return Err(StoreError::IdentityMismatch);
        }

        // New generation data is always below the selected directory. A generation
        // ID that happens to equal a namespace does not redefine the layout root.
        layout.base = root.path().to_owned();
        Self::build(
            layout,
            &[base, generations, root],
            identity,
            Arc::new(FixedIdentity(identity.clone())),
            capacity,
            mode,
        )
    }

    fn build(
        layout: Layout,
        root_pins: &[Arc<TrustedDirectory>],
        identity: &VectorSpaceIdentity,
        resolver: Arc<dyn StoreIdentityResolver>,
        capacity: usize,
        mode: OpenMode,
    ) -> Result<Self, StoreError> {
        let mut configured = layout.read.clone();
        if !configured.contains(&layout.writer) {
            configured.push(layout.writer.clone());
        }
        let resolved_layout = &layout;
        let routes = configured
            .into_iter()
            .map(move |namespace| {
                open_route(
                    resolved_layout,
                    namespace,
                    root_pins,
                    identity,
                    resolver.clone(),
                    capacity,
                    mode,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        let writer = find_route(&routes, &layout.writer)?;
        let read = layout
            .read
            .iter()
            .map(|name| find_route(&routes, name))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            base: layout.base,
            read,
            writer,
            root_pins: root_pins.to_vec(),
        })
    }

    /// Common private and shared root after resolving an explicit writer leaf.
    pub(crate) fn base(&self) -> &Path {
        &self.base
    }

    /// Outer directory capabilities also retained by the selected shared pools.
    pub(crate) fn root_pins(&self) -> &[Arc<TrustedDirectory>] {
        &self.root_pins
    }

    /// Lease only the active writer; callers remain responsible for row authorization.
    pub fn write_store(&self, agent_id: &str) -> Result<Arc<Store>, StoreError> {
        self.writer.lease(agent_id)?.ok_or(StoreError::Unavailable)
    }

    /// The active writer's pool itself, so capture shares its per-agent writer handles.
    pub(crate) fn writer_pool(&self) -> Arc<StorePool> {
        self.writer.pool.clone()
    }

    /// Existing active writer for previews/mutations that must not manufacture an empty table.
    pub fn existing_write_store(&self, agent_id: &str) -> Result<Option<Arc<Store>>, StoreError> {
        self.writer.lease_existing(agent_id)
    }
}

/// The namespace parent and active writer namespace these routes resolve, without opening or
/// creating anything; the re-embedding inventory reads the same layout (RE-D166).
pub(crate) fn writer_layout(
    base: &Path,
    config: &EngineConfig,
) -> Result<(PathBuf, Option<String>), StoreError> {
    let layout = Layout::from_config(base, config)?;
    Ok((layout.base, layout.writer))
}

fn find_route(routes: &[StoreRoute], namespace: &Option<String>) -> Result<StoreRoute, StoreError> {
    routes
        .iter()
        .find(|route| &route.namespace == namespace)
        .cloned()
        .ok_or(StoreError::InvalidInput)
}

fn open_route(
    layout: &Layout,
    namespace: Option<String>,
    root_pins: &[Arc<TrustedDirectory>],
    identity: &VectorSpaceIdentity,
    identity_resolver: Arc<dyn StoreIdentityResolver>,
    capacity: usize,
    mode: OpenMode,
) -> Result<StoreRoute, StoreError> {
    let path = match &namespace {
        Some(namespace) => namespace_path(&layout.base, namespace)?,
        None => layout.base.clone(),
    };
    let legacy = namespace
        .as_ref()
        .is_some_and(|name| layout.legacy.contains(name));
    let mut pins = root_pins.to_vec();
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() => pins.push(Arc::new(TrustedDirectory::open(&path)?)),
        Ok(_) => return Err(StoreError::UntrustedPath),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mode = if legacy { OpenMode::ReadOnly } else { mode };
    let pool =
        StorePool::open(&path, mode, Some(identity), capacity)?.with_parent_pins(pins.clone())?;
    Ok(StoreRoute {
        namespace,
        pool: Arc::new(pool),
        identity_resolver,
        skip_missing: mode == OpenMode::ReadOnly,
        pins,
    })
}

impl Layout {
    fn from_config(base: &Path, config: &EngineConfig) -> Result<Self, StoreError> {
        let config = serde_json::to_value(config).map_err(|_| StoreError::InvalidInput)?;
        Self::resolve(
            base,
            config.get("namespaces").filter(|value| !value.is_null()),
        )
    }

    fn root_pin(&self) -> Result<Option<Arc<TrustedDirectory>>, StoreError> {
        if self.writer.is_some() {
            secure_dir(&self.base)?;
            Ok(Some(Arc::new(TrustedDirectory::open(&self.base)?)))
        } else if self.base.exists() {
            Ok(Some(Arc::new(TrustedDirectory::open(&self.base)?)))
        } else {
            Ok(None)
        }
    }
}
impl StoreRoutes for NamespaceStores {
    fn read_routes(&self) -> Result<Vec<StoreRoute>, StoreError> {
        for route in &self.read {
            route.check_pins()?;
        }
        Ok(self.read.clone())
    }
}

struct Layout {
    base: PathBuf,
    writer: Option<String>,
    read: Vec<Option<String>>,
    legacy: Vec<String>,
}
impl Layout {
    fn resolve(base: &Path, config: Option<&Value>) -> Result<Self, StoreError> {
        let Some(config) = config else {
            return Ok(Self {
                base: base.to_owned(),
                writer: None,
                read: vec![None],
                legacy: Vec::new(),
            });
        };
        validate_fields(config)?;
        let writer = match config.get("activeWriteNamespace") {
            None => "lancedb-namespaced",
            Some(value) => value.as_str().ok_or(StoreError::InvalidInput)?,
        };
        validate_name(writer)?;
        let active =
            names(config.get("activeRecallNamespaces"))?.unwrap_or_else(|| vec![writer.to_owned()]);
        let legacy = names(config.get("legacyReadOnlyNamespaces"))?.unwrap_or_default();
        if active.is_empty()
            || !active.iter().any(|name| name == writer)
            || legacy.iter().any(|name| active.contains(name))
        {
            return Err(StoreError::InvalidInput);
        }
        let cross = match config.get("crossNamespaceRecall") {
            None => false,
            Some(value) => value.as_bool().ok_or(StoreError::InvalidInput)?,
        };
        let parent = namespace_parent(base, writer, &active, &legacy)?;
        let mut read = active.into_iter().map(Some).collect::<Vec<_>>();
        if cross {
            read.extend(legacy.iter().cloned().map(Some));
        }
        Ok(Self {
            base: parent,
            writer: Some(writer.to_owned()),
            read,
            legacy,
        })
    }
}
fn validate_name(name: &str) -> Result<(), StoreError> {
    if name.is_empty()
        || name.len() > 64
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}
fn names(value: Option<&Value>) -> Result<Option<Vec<String>>, StoreError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for value in value.as_array().ok_or(StoreError::InvalidInput)? {
        let name = value.as_str().ok_or(StoreError::InvalidInput)?;
        validate_name(name)?;
        if seen.insert(name) {
            out.push(name.to_owned());
        }
    }
    Ok(Some(out))
}

fn validate_fields(config: &Value) -> Result<(), StoreError> {
    let fields = config.as_object().ok_or(StoreError::InvalidInput)?;
    if fields.keys().any(|key| {
        ![
            "activeWriteNamespace",
            "activeRecallNamespaces",
            "legacyReadOnlyNamespaces",
            "crossNamespaceRecall",
        ]
        .contains(&key.as_str())
    }) {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

fn namespace_parent(
    base: &Path,
    writer: &str,
    active: &[String],
    legacy: &[String],
) -> Result<PathBuf, StoreError> {
    let leaf = base
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if leaf == writer {
        base.parent()
            .map(Path::to_owned)
            .ok_or(StoreError::InvalidInput)
    } else if active.iter().chain(legacy).any(|name| name == leaf) {
        Err(StoreError::InvalidInput)
    } else {
        Ok(base.to_owned())
    }
}

struct FixedIdentity(VectorSpaceIdentity);
impl StoreIdentityResolver for FixedIdentity {
    fn expected_identity(
        &self,
        _: Option<&str>,
        _: &str,
    ) -> Result<VectorSpaceIdentity, StoreError> {
        Ok(self.0.clone())
    }
}
