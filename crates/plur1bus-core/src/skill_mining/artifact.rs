//! Exact-byte attribution and proposal-only gates for self-knowledge artifacts.

use super::review::{scoped_person, Authority};
use super::{open_ledger, text_id, Scope, R};
use crate::budget::Clock;
use crate::collab::{CollabError, CollabErrorCode};
use crate::rbac::{
    audit::{AuditEvent, AuditSink},
    authorize::authorize,
    types::{AuthorizeContext, Principal, Resource, Role},
};
use plur1bus_store::rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;

/// Durable authorship of an exact file version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Author {
    /// A manual file or a version without matching agent provenance.
    Human,
    /// A version explicitly attributed by an owner.
    Agent,
}

/// Root-confined snapshot supplied by the host.
pub struct Snapshot {
    /// Canonical absolute file identity.
    pub canonical: String,
    /// Observed bytes of a regular file.
    pub bytes: Vec<u8>,
}

/// All artifact path access goes through the existing scoped filesystem.
pub trait Files {
    /// Read a project-relative artifact after proving its exact current root and file type.
    fn snapshot(&self, scope: &Scope, path: &str, max_bytes: usize) -> R<Snapshot>;
}

/// Authorship of the exact observed bytes.
#[derive(Serialize)]
pub struct Inspection {
    /// Canonical file identity.
    pub path: String,
    /// Current classification.
    pub author: Author,
    /// SHA-256 of the current bytes.
    pub hash: String,
}

/// Proposed change submitted for explicit review.
pub struct Change<'a> {
    /// Canonical file identity.
    pub path: &'a str,
    /// Proposed replacement text.
    pub text: &'a str,
    /// Old bytes the approved writer must compare.
    pub old_hash: &'a str,
    /// Observed current author.
    pub author: Author,
}

/// The existing additive artifact proposal boundary.
pub trait Queue {
    /// Return an identity for the persisted, inactive review proposal.
    fn propose(&mut self, scope: &Scope, change: Change<'_>) -> R<String>;
}

/// The route the normal dispatcher may take after checking this artifact.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Route {
    /// Manual approval remains required.
    Proposal {
        /// Persisted proposal identity.
        #[serde(rename = "proposalId")]
        proposal_id: String,
    },
    /// The artifact's current version matches agent provenance.
    AgentOwnedWrite {
        /// The normal writer must compare this against current bytes.
        #[serde(rename = "oldHash")]
        old_hash: String,
    },
}

const MAX_BYTES: usize = 16 * 1024 * 1024;
const DDL:&str="CREATE TABLE IF NOT EXISTS artifact_provenance(path TEXT PRIMARY KEY, author TEXT NOT NULL CHECK(author IN ('human','agent')), hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS artifact_policy(key TEXT PRIMARY KEY, value INTEGER NOT NULL)";

/// SQLite owner policy and attribution of exact versions.
pub struct Store {
    db: plur1bus_store::Store,
}

impl Author {
    fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Agent => "agent",
        }
    }
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn denied(reason: &'static str) -> CollabError {
    CollabError::with_reason(
        CollabErrorCode::Unauthorized,
        "artifact authority unavailable",
        reason,
    )
}

fn invalid(reason: &'static str) -> CollabError {
    CollabError::with_reason(CollabErrorCode::Invalid, "invalid artifact input", reason)
}

impl Store {
    /// Open a private attribution database.
    pub fn open(path: &Path) -> R<Self> {
        Self::open_file(path, None)
    }
    /// Open using the host's owner-only file proof.
    pub fn open_with_permissions(path: &Path, secure: &dyn Fn(&Path) -> bool) -> R<Self> {
        Self::open_file(path, Some(secure))
    }

    fn open_file(path: &Path, secure: Option<&dyn Fn(&Path) -> bool>) -> R<Self> {
        Ok(Self {
            db: open_ledger(path, "artifact provenance", DDL, secure)?,
        })
    }
    /// Check the default-on approval policy.
    pub fn approval_required(&self) -> R<bool> {
        let setting: Option<i64> = self
            .db
            .conn()
            .query_row(
                "SELECT value FROM artifact_policy WHERE key='self-knowledge'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(setting != Some(0))
    }

    fn inspect_snapshot(&self, snapshot: Snapshot) -> R<Inspection> {
        let digest = hash(&snapshot.bytes);
        let tx = plur1bus_store::begin_immediate(self.db.conn())?;
        let row = tx
            .query_row(
                "SELECT author,hash FROM artifact_provenance WHERE path=?",
                [&snapshot.canonical],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        let exact = row.as_ref().is_some_and(|(_, old)| old == &digest);
        let author = if exact && row.as_ref().is_some_and(|(author, _)| author == "agent") {
            Author::Agent
        } else {
            Author::Human
        };
        if !exact {
            tx.execute(
                "INSERT OR REPLACE INTO artifact_provenance(path,author,hash) VALUES(?,?,?)",
                params![snapshot.canonical, author.as_str(), digest],
            )?;
        }
        tx.commit()?;
        Ok(Inspection {
            path: snapshot.canonical,
            author,
            hash: digest,
        })
    }

    fn set_author(&self, data: &Inspection, author: Author) -> R<()> {
        let changed = self.db.conn().execute(
            "UPDATE artifact_provenance SET author=? WHERE path=? AND hash=?",
            params![author.as_str(), data.path, data.hash],
        )?;
        if changed != 1 {
            return Err(CollabError::with_reason(
                CollabErrorCode::Conflict,
                "artifact changed during attribution",
                "artifact-changed",
            ));
        }
        Ok(())
    }

    fn set_policy(&self, enabled: bool) -> R<()> {
        self.db.conn().execute(
            "INSERT OR REPLACE INTO artifact_policy(key,value) VALUES('self-knowledge',?)",
            [enabled],
        )?;
        Ok(())
    }
}

fn relative(path: &str) -> bool {
    text_id(path, 4096)
        && !path.contains(['\\', ':'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

/// Authenticated self-knowledge service over scoped storage and file ports.
pub struct Service<'a> {
    /// Private attribution and policy.
    pub store: &'a Store,
    /// Existing rooted filesystem checks.
    pub files: &'a dyn Files,
    /// Current scope proof.
    pub authority: &'a dyn Authority,
    /// Trusted clock.
    pub clock: &'a dyn Clock,
    /// Proposal-only review queue.
    pub queue: &'a mut dyn Queue,
    /// Metadata-only audit.
    pub audit: &'a mut dyn AuditSink,
}

impl Service<'_> {
    fn owner(&self, scope: &Scope, who: &Principal) -> R<()> {
        let now = self.clock.now();
        let live = scoped_person(scope, who, self.authority, now)?;
        let ctx = AuthorizeContext {
            now: Some(now as f64),
        };
        if [who, &live].into_iter().all(|p| {
            p.role == Role::Owner
                && authorize(Some(p), "settings.write", &Resource::System, &ctx).is_allow()
        }) {
            return Ok(());
        }
        Err(denied("owner-required"))
    }

    fn audited(
        &mut self,
        who: &Principal,
        action: &str,
        target: &str,
        enabled: Option<bool>,
    ) -> R<()> {
        self.audit
            .append(&AuditEvent {
                user: who.user_id.clone(),
                at: self.clock.now(),
                host: String::new(),
                action: action.into(),
                target: target.into(),
                detail: enabled
                    .into_iter()
                    .map(|v| ("enabled".into(), json!(v)))
                    .collect(),
            })
            .map_err(|_| denied("audit-unavailable"))
    }

    /// Inspect current bytes after a scope check.
    pub fn inspect(&self, scope: &Scope, who: &Principal, path: &str) -> R<Inspection> {
        if !relative(path) {
            return Err(invalid("artifact-path"));
        }
        scoped_person(scope, who, self.authority, self.clock.now())?;
        let snapshot = self.files.snapshot(scope, path, MAX_BYTES)?;
        if !text_id(&snapshot.canonical, 4096)
            || !Path::new(&snapshot.canonical).is_absolute()
            || snapshot.bytes.len() > MAX_BYTES
        {
            return Err(invalid("artifact-snapshot"));
        }
        scoped_person(scope, who, self.authority, self.clock.now())?;
        self.store.inspect_snapshot(snapshot)
    }

    /// Only an authenticated owner can attribute a specific file version.
    pub fn attribute(
        &mut self,
        scope: &Scope,
        who: &Principal,
        path: &str,
        author: Author,
    ) -> R<()> {
        self.owner(scope, who)?;
        let before = self.inspect(scope, who, path)?;
        self.owner(scope, who)?;
        self.store.set_author(&before, author)
    }

    /// Audit and change the default-on policy under a current owner grant.
    pub fn set_approval(&mut self, scope: &Scope, who: &Principal, enabled: bool) -> R<()> {
        self.owner(scope, who)?;
        self.audited(
            who,
            "self-knowledge.write-approval",
            "self-knowledge",
            Some(enabled),
        )?;
        self.owner(scope, who)?;
        self.store.set_policy(enabled)
    }

    /// Compute a proposal or a compare-current-bytes route.
    pub fn request(&mut self, scope: &Scope, who: &Principal, path: &str, text: &str) -> R<Route> {
        if text.len() > MAX_BYTES {
            return Err(invalid("artifact-size"));
        }
        let current = self.inspect(scope, who, path)?;
        let safe_target = hash(current.path.as_bytes());
        if current.author == Author::Human || self.store.approval_required()? {
            self.audited(who, "self-knowledge.propose", &safe_target, None)?;
            scoped_person(scope, who, self.authority, self.clock.now())?;
            let id = self.queue.propose(
                scope,
                Change {
                    path: &current.path,
                    text,
                    old_hash: &current.hash,
                    author: current.author,
                },
            )?;
            scoped_person(scope, who, self.authority, self.clock.now())?;
            if !text_id(&id, 256) {
                return Err(invalid("artifact-receipt"));
            }
            return Ok(Route::Proposal { proposal_id: id });
        }
        self.audited(who, "self-knowledge.agent-write", &safe_target, None)?;
        let fresh = self.inspect(scope, who, path)?;
        if fresh.hash != current.hash
            || fresh.path != current.path
            || fresh.author != Author::Agent
            || self.store.approval_required()?
        {
            return Err(CollabError::with_reason(
                CollabErrorCode::Conflict,
                "artifact changed during review",
                "artifact-changed",
            ));
        }
        Ok(Route::AgentOwnedWrite {
            old_hash: fresh.hash,
        })
    }
}

#[cfg(test)]
#[path = "artifact_vectors.rs"]
mod vectors;
