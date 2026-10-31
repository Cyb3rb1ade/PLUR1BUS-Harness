//! Configured namespace routes and settle-all recall orchestration.
//! A required table failure rejects the complete recall before any ledger append.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::merge::{merge, MergeOptions, NamespaceResult};
use super::namespace_query::RequestQueries;
use super::stages::StageError;
use crate::contract::{EngineConfig, EngineError, StoreError, VectorSpaceIdentity};
use crate::store::directory::TrustedDirectory;
use crate::store::ledger::JsonlLedger;
use crate::store::ledger_types::RetrievalLedgerLine;
use crate::store::paths::{namespace_path, secure_dir};
use crate::store::state_file::JsonRecord;
use crate::store::{OpenMode, Store, StorePool, StoreRoute, StoreRoutes};
use crate::text::{js::JsString, json::TolerantJsonValue as Json};

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
        let root_pin = if layout.writer.is_some() {
            secure_dir(&layout.base)?;
            Some(Arc::new(TrustedDirectory::open(&layout.base)?))
        } else if layout.base.exists() {
            Some(Arc::new(TrustedDirectory::open(&layout.base)?))
        } else {
            None
        };
        let mut routes = Vec::new();
        let mut configured = layout.read.clone();
        if !configured.contains(&layout.writer) {
            configured.push(layout.writer.clone());
        }
        for namespace in configured {
            let path = match &namespace {
                Some(namespace) => namespace_path(&layout.base, namespace)?,
                None => layout.base.clone(),
            };
            let legacy = namespace
                .as_ref()
                .is_some_and(|name| layout.legacy.contains(name));
            let mut pins = root_pin.iter().cloned().collect::<Vec<_>>();
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_dir() => {
                    pins.push(Arc::new(TrustedDirectory::open(&path)?))
                }
                Ok(_) => return Err(StoreError::UntrustedPath),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let pool = StorePool::open(
                &path,
                if legacy {
                    OpenMode::ReadOnly
                } else {
                    OpenMode::ReadWrite
                },
                Some(identity),
                capacity,
            )?;
            routes.push(StoreRoute {
                namespace,
                pool: Arc::new(pool),
                skip_missing: legacy,
                pins,
            });
        }
        let writer = routes
            .iter()
            .find(|route| route.namespace == layout.writer)
            .cloned()
            .ok_or(StoreError::InvalidInput)?;
        let read = layout
            .read
            .iter()
            .map(|name| {
                routes
                    .iter()
                    .find(|route| &route.namespace == name)
                    .cloned()
                    .ok_or(StoreError::InvalidInput)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { read, writer })
    }

    /// Lease only the active writer; callers remain responsible for row authorization.
    pub fn write_store(&self, agent_id: &str) -> Result<Arc<Store>, StoreError> {
        self.writer.lease(agent_id)?.ok_or(StoreError::Unavailable)
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
        let leaf = base
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        let parent = if leaf == writer {
            base.parent().ok_or(StoreError::InvalidInput)?.to_owned()
        } else if active.iter().chain(&legacy).any(|name| name == leaf) {
            return Err(StoreError::InvalidInput);
        } else {
            base.to_owned()
        };
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

/// One synchronous table pipeline. Implementations share providers but retain no borrowed store past return.
pub trait TableRecall: Sync {
    /// Run one leased table with the shared request query scope; a failure cannot
    /// become a partial global answer.
    fn recall(
        &self,
        namespace: Option<&str>,
        store: &Store,
        canonical: CanonicalSource,
        queries: &RequestQueries,
    ) -> Result<NamespaceResult, NamespaceError>;
}

/// Exactly one private table reads the shared workspace knowledge file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalSource {
    /// The first table may read canonical knowledge when enabled.
    Read,
    /// Other tables must not embed or persist the same knowledge again.
    Skip,
}

/// Dependencies and the already-authorized context for one merged recall.
pub struct NamespaceRequest<'a> {
    /// RE-02 physical routes.
    pub routes: &'a dyn StoreRoutes,
    /// Provider-ACL-aware table pipeline.
    pub pipeline: &'a dyn TableRecall,
    /// Requesting agent.
    pub agent_id: &'a str,
    /// Resolved workspace key, used only in the ledger envelope.
    pub workspace_key: &'a str,
    /// Query, hashed before persistence.
    pub query: &'a str,
    /// Request clock for the global ledger line.
    pub timestamp_ms: i64,
    /// Optional protected Node JSONL retrieval ledger.
    pub ledger: Option<&'a JsonlLedger<RetrievalLedgerLine>>,
    /// Global merge controls.
    pub merge: MergeOptions,
}

/// Successful merged output and the independent, bounded ledger delivery diagnostic.
pub struct NamespaceOutput {
    /// Global candidates and trace.
    pub result: NamespaceResult,
    /// A failed ledger append does not replace an otherwise successful Node recall.
    pub ledger_error: Option<StoreError>,
}

/// Bounded failures from a required namespace, never containing row text or paths.
#[derive(Debug)]
pub enum NamespaceError {
    /// Route, lease or store failure.
    Store(StoreError),
    /// Stage 1–7 failure.
    Stage(StageError),
    /// Reranker/finalisation failure.
    Finalise(EngineError),
    /// A child worker failed to return normally.
    WorkerFailed,
}
impl std::fmt::Display for NamespaceError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(out, "{error}"),
            Self::Stage(error) => write!(out, "{error}"),
            Self::Finalise(error) => write!(out, "{error}"),
            Self::WorkerFailed => out.write_str("namespace worker failed"),
        }
    }
}
impl std::error::Error for NamespaceError {}

/// Run every namespace concurrently, join every worker, then merge and emit one ledger line.
/// Required failures are selected in configured order only after all leases have settled.
pub fn recall(request: &NamespaceRequest<'_>) -> Result<NamespaceOutput, NamespaceError> {
    let routes = request
        .routes
        .read_routes()
        .map_err(NamespaceError::Store)?;
    let query_scope = RequestQueries::new(request.query);
    let queries = &query_scope;
    let settled = std::thread::scope(|scope| {
        let handles = routes
            .into_iter()
            .enumerate()
            .map(|(index, route)| {
                scope.spawn(move || {
                    let Some(store) = route
                        .lease(request.agent_id)
                        .map_err(NamespaceError::Store)?
                    else {
                        return Ok(None);
                    };
                    request
                        .pipeline
                        .recall(
                            route.namespace.as_deref(),
                            &store,
                            if index == 0 {
                                CanonicalSource::Read
                            } else {
                                CanonicalSource::Skip
                            },
                            queries,
                        )
                        .map(Some)
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap_or(Err(NamespaceError::WorkerFailed)))
            .collect::<Vec<_>>()
    });
    let mut children = Vec::new();
    let mut failure = None;
    for outcome in settled {
        match outcome {
            Ok(Some(child)) => children.push(child),
            Ok(None) => {}
            Err(error) => {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    let result = merge(&children, &request.merge);
    let ledger_error = if children.is_empty() {
        None
    } else {
        request.ledger.and_then(|ledger| {
            retrieval_line(request, &result)
                .and_then(|line| ledger.append(&line))
                .err()
        })
    };
    Ok(NamespaceOutput {
        result,
        ledger_error,
    })
}

fn retrieval_line(
    request: &NamespaceRequest<'_>,
    result: &NamespaceResult,
) -> Result<RetrievalLedgerLine, StoreError> {
    let nullable = |value: &str| {
        if value.is_empty() {
            Json::Null
        } else {
            Json::String(JsString::from(value))
        }
    };
    let hash = if request.query.is_empty() {
        Json::Null
    } else {
        Json::String(JsString::from(
            format!("{:x}", Sha256::digest(request.query.as_bytes())).as_str(),
        ))
    };
    let values = vec![
        (
            "id",
            Json::String(JsString::from(uuid::Uuid::new_v4().to_string().as_str())),
        ),
        ("agentId", nullable(request.agent_id)),
        ("workspaceKey", nullable(request.workspace_key)),
        ("queryHash", hash),
        (
            "resultsCount",
            Json::Number(result.memories.len().to_string()),
        ),
        (
            "selectedIds",
            Json::Array(
                result
                    .memories
                    .iter()
                    .map(|memory| {
                        Json::String(JsString::from(memory["entry"]["id"].as_str().unwrap_or("")))
                    })
                    .collect(),
            ),
        ),
        ("timestamp", Json::Number(request.timestamp_ms.to_string())),
    ];
    RetrievalLedgerLine::from_json(Json::Object(
        values
            .into_iter()
            .map(|(key, value)| (JsString::from(key), value))
            .collect(),
    ))
}
