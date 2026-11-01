//! Private namespace route construction; shared and optional sources belong to T6/RE-07.

use crate::contract::{EngineConfig, StoreError, VectorSpaceIdentity};
use crate::store::directory::TrustedDirectory;
use crate::store::paths::{namespace_path, secure_dir};
use crate::store::{OpenMode, Store, StorePool, StoreRoute, StoreRoutes};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Immutable pools for the writer, active recall tables and read-only legacy tables.
pub struct NamespaceStores {
    read: Vec<StoreRoute>,
    writer: StoreRoute,
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
        let config = serde_json::to_value(config).map_err(|_| StoreError::InvalidInput)?;
        let layout = Layout::resolve(
            base,
            config.get("namespaces").filter(|value| !value.is_null()),
        )?;
        let root_pin = layout.root_pin()?;
        let mut configured = layout.read.clone();
        if !configured.contains(&layout.writer) {
            configured.push(layout.writer.clone());
        }
        let routes = configured
            .into_iter()
            .map(|namespace| open_route(&layout, namespace, root_pin.as_ref(), identity, capacity))
            .collect::<Result<Vec<_>, _>>()?;
        let writer = find_route(&routes, &layout.writer)?;
        let read = layout
            .read
            .iter()
            .map(|name| find_route(&routes, name))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { read, writer })
    }

    /// Lease only the active writer; callers remain responsible for row authorization.
    pub fn write_store(&self, agent_id: &str) -> Result<Arc<Store>, StoreError> {
        self.writer.lease(agent_id)?.ok_or(StoreError::Unavailable)
    }
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
    root: Option<&Arc<TrustedDirectory>>,
    identity: &VectorSpaceIdentity,
    capacity: usize,
) -> Result<StoreRoute, StoreError> {
    let path = match &namespace {
        Some(namespace) => namespace_path(&layout.base, namespace)?,
        None => layout.base.clone(),
    };
    let legacy = namespace
        .as_ref()
        .is_some_and(|name| layout.legacy.contains(name));
    let mut pins = root.cloned().into_iter().collect::<Vec<_>>();
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() => pins.push(Arc::new(TrustedDirectory::open(&path)?)),
        Ok(_) => return Err(StoreError::UntrustedPath),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mode = if legacy {
        OpenMode::ReadOnly
    } else {
        OpenMode::ReadWrite
    };
    let pool = StorePool::open(&path, mode, Some(identity), capacity)?;
    Ok(StoreRoute {
        namespace,
        pool: Arc::new(pool),
        skip_missing: legacy,
        pins,
    })
}

impl Layout {
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
