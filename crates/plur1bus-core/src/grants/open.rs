//! `grants/open.ts`: the one approvals database with the stores that share its chain. Grants and approvals use ONE
//! [`ApprovalChain`] (its verified-view cache is per connection), and this struct owns the one connection: every write goes
//! through `Store::write_with` (`BEGIN IMMEDIATE`), so there is one writer per file in this process.
//!
//! It is also the [`GrantSource`] of `policy::decide`: [`GrantSource::list`] and [`GrantSource::get`] read through the grant
//! store's verified views. A read that fails (SQLite, an unreadable row) yields no grant, so `decide` falls back to asking
//! (TypeScript throws there and the dispatcher reports an error; neither runs the call).
use super::store::{AutoJobReason, CreateGrantInput, GrantError, GrantStore, View};
use crate::approvals::chain::{ApprovalChain, VerifyResult};
use crate::approvals::db::{self, OpenOptions};
use crate::approvals::keys::{ChainKeySource, KeyError, SigningKeySource};
use crate::approvals::signing::{DecisionSigner, Ed25519Signer};
use crate::approvals::store::{
    ApprovalRecord, ApprovalStore, Binding, DecideInput, Denial, RequestInput, Requested, Status,
};
use crate::approvals::{ApprovalError, AuditPort, Clock, Random};
use crate::policy::decide::GrantSource;
use plur1bus_store::Store;
use serde_json::Value;
use std::fmt;
use std::path::Path;
use std::sync::Arc;

/// Why the stores could not be opened.
#[derive(Debug)]
pub enum OpenError {
    /// The file (`ApprovalsDbError`).
    Db(db::DbError),
    /// A key source or the signing identity (`SecretError`, `RangeError`).
    Key(KeyError),
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpenError::Db(e) => write!(f, "{e}"),
            OpenError::Key(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for OpenError {}

/// The signing side of `OpenPermissionStoresOptions`: a source to load the identity from, or a signer given directly.
pub enum Signing<'a> {
    /// No signatures (unsigned legacy entries).
    None,
    /// `signing`: loaded once at open.
    Source(&'a dyn SigningKeySource),
    /// `signer`: injected (tests).
    Signer(Arc<dyn DecisionSigner>),
}

/// `OpenPermissionStoresOptions`.
pub struct OpenPermissionStores<'a> {
    /// The file.
    pub path: &'a Path,
    /// `securePath` and `busyTimeoutMs`.
    pub db: OpenOptions<'a>,
    /// The chain key.
    pub keys: &'a dyn ChainKeySource,
    /// The clock.
    pub clock: Arc<dyn Clock>,
    /// Ids and nonces.
    pub random: Arc<dyn Random>,
    /// `requestTtlMs`.
    pub request_ttl_ms: Option<i64>,
    /// `maxGrantDays`.
    pub max_grant_days: Option<Box<dyn Fn() -> f64>>,
    /// The home directory for the system-tree rule (`os.homedir()` when `None`).
    pub home: Option<String>,
    /// The signer.
    pub signing: Signing<'a>,
}

/// `PermissionStores`.
pub struct PermissionStores {
    db: Store,
    /// The approval store (owns the chain).
    pub approvals: ApprovalStore,
    /// The grant store.
    pub grants: GrantStore,
}

impl fmt::Debug for PermissionStores {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PermissionStores").finish_non_exhaustive()
    }
}

impl PermissionStores {
    /// `openPermissionStores(o)`: opens and migrates the file, loads the key (and the signer), builds both stores.
    pub fn open(o: OpenPermissionStores<'_>) -> Result<Self, OpenError> {
        let db = db::open(o.path, &o.db).map_err(OpenError::Db)?;
        let signer: Option<Arc<dyn DecisionSigner>> = match o.signing {
            Signing::None => None,
            Signing::Signer(s) => Some(s),
            Signing::Source(src) => {
                Some(Arc::new(Ed25519Signer::load(src).map_err(OpenError::Key)?))
            }
        };
        let key = o.keys.load().map_err(OpenError::Key)?;
        let chain =
            ApprovalChain::new(&key, Arc::clone(&o.clock), signer).map_err(OpenError::Key)?;
        let approvals = ApprovalStore::new(
            chain,
            Arc::clone(&o.clock),
            Arc::clone(&o.random),
            o.request_ttl_ms,
        );
        let grants = GrantStore::new(o.clock, o.random, o.max_grant_days, o.home);
        Ok(PermissionStores {
            db,
            approvals,
            grants,
        })
    }

    /// The connection, for reads (and for tests that play the attacker with a second one).
    pub fn conn(&self) -> &plur1bus_store::rusqlite::Connection {
        self.db.conn()
    }

    /// The chain.
    pub fn chain(&self) -> &ApprovalChain {
        &self.approvals.chain
    }

    /// Runs `f` in one `BEGIN IMMEDIATE` transaction on the one connection: committed on `Ok`, rolled back on `Err`. The
    /// service composes a decision, its grants and its audit line in one of these.
    pub fn write<T, E: From<plur1bus_store::StoreError>>(
        &mut self,
        f: impl FnOnce(
            &plur1bus_store::rusqlite::Connection,
            &ApprovalStore,
            &GrantStore,
        ) -> Result<T, E>,
    ) -> Result<T, E> {
        let (approvals, grants) = (&self.approvals, &self.grants);
        self.db.write_with(|tx| f(tx, approvals, grants))
    }

    // ---- approvals ----

    /// `approvals.request(input)`.
    pub fn request(&mut self, input: &RequestInput) -> Result<Requested, ApprovalError> {
        self.write(|tx, a, _| a.request(tx, input))
    }

    /// `approvals.decide(input)`.
    pub fn decide(&mut self, input: &DecideInput) -> Result<Result<bool, Denial>, ApprovalError> {
        self.write(|tx, a, _| a.decide(tx, input))
    }

    /// `approvals.cancel(id, by)`.
    pub fn cancel(&mut self, id: &str, by: &str) -> Result<Result<(), Denial>, ApprovalError> {
        self.write(|tx, a, _| a.cancel(tx, id, by))
    }

    /// `approvals.consume(binding)`.
    pub fn consume(
        &mut self,
        request_id: &str,
        b: &Binding,
    ) -> Result<Result<bool, Denial>, ApprovalError> {
        self.write(|tx, a, _| a.consume(tx, request_id, b))
    }

    /// `approvals.get(id)`.
    pub fn approval(&self, id: &str) -> Result<Option<ApprovalRecord>, ApprovalError> {
        self.approvals.get(self.db.conn(), id)
    }

    /// `approvals.list(filter)`.
    pub fn approvals(
        &self,
        status: Option<Status>,
        principal: Option<&str>,
    ) -> Result<Vec<ApprovalRecord>, ApprovalError> {
        self.approvals.list(self.db.conn(), status, principal)
    }

    /// `verify()`.
    pub fn verify(&self) -> Result<VerifyResult, ApprovalError> {
        self.approvals.verify(self.db.conn())
    }

    // ---- grants ----

    /// `grants.create(input)` with its audit line in the same transaction.
    pub fn create_grant(
        &mut self,
        audit: &mut dyn AuditPort,
        input: &CreateGrantInput,
    ) -> Result<Value, GrantError> {
        self.write(|tx, a, g| g.create(tx, &a.chain, audit, input))
    }

    /// `grants.get(id)`.
    pub fn grant(&self, id: &str) -> Result<Option<Value>, GrantError> {
        self.grants.get(self.db.conn(), &self.approvals.chain, id)
    }

    /// `grants.list({ person, agent, capability })`.
    pub fn grants_for(
        &self,
        person: &str,
        agent: &str,
        capability: &str,
    ) -> Result<Vec<Value>, GrantError> {
        self.grants.list(
            self.db.conn(),
            &self.approvals.chain,
            person,
            agent,
            capability,
        )
    }

    /// `grants.inspect(filter)`.
    pub fn inspect(
        &self,
        person: Option<&str>,
        agent: Option<&str>,
    ) -> Result<Vec<View>, GrantError> {
        self.grants
            .inspect(self.db.conn(), &self.approvals.chain, person, agent)
    }

    /// `grants.announceDue(person)`.
    pub fn announce_due(&self, person: Option<&str>) -> Result<(), GrantError> {
        self.grants
            .announce_due(self.db.conn(), &self.approvals.chain, person)
    }

    /// `grants.revoke(id, by, reason)`.
    pub fn revoke(
        &mut self,
        audit: &mut dyn AuditPort,
        id: &str,
        by: &str,
        reason: &str,
    ) -> Result<bool, GrantError> {
        self.write(|tx, a, g| g.revoke(tx, &a.chain, audit, id, by, reason))
    }

    /// `grants.endTask(taskId, by)`.
    pub fn end_task(
        &mut self,
        audit: &mut dyn AuditPort,
        task_id: &str,
        by: &str,
    ) -> Result<usize, GrantError> {
        self.write(|tx, a, g| g.end_task(tx, &a.chain, audit, task_id, by))
    }

    /// `grants.endSession(sessionId, by)`.
    pub fn end_session(
        &mut self,
        audit: &mut dyn AuditPort,
        session_id: &str,
        by: &str,
    ) -> Result<usize, GrantError> {
        self.write(|tx, a, g| g.end_session(tx, &a.chain, audit, session_id, by))
    }

    /// `grants.markUsed(id)`; the `used` notification goes out after the commit.
    pub fn mark_used(&mut self, audit: &mut dyn AuditPort, id: &str) -> Result<(), GrantError> {
        if let Some(v) = self.write(|tx, a, g| g.mark_used(tx, &a.chain, audit, id))? {
            self.grants.announce_used(&v);
        }
        Ok(())
    }

    /// `grants.consumeOnce(id, binding)`: a broken chain rolls back and answers `false`.
    pub fn consume_once(
        &mut self,
        audit: &mut dyn AuditPort,
        id: &str,
        person: &str,
        agent: &str,
        action_hash: &str,
    ) -> Result<bool, GrantError> {
        match self
            .write(|tx, a, g| g.consume_once(tx, &a.chain, audit, id, person, agent, action_hash))
        {
            Err(GrantError::Integrity { .. }) => Ok(false),
            other => other,
        }
    }

    /// `grants.issueOwnerJobs(person, agent, reason)`.
    pub fn issue_owner_jobs(
        &mut self,
        audit: &mut dyn AuditPort,
        person: &str,
        agent: &str,
        reason: AutoJobReason,
    ) -> Result<Option<Value>, GrantError> {
        self.write(|tx, a, g| g.issue_owner_jobs(tx, &a.chain, audit, person, agent, reason))
    }

    /// `grants.renewJobGrantsFromTurn(person, agent)`.
    pub fn renew_job_grants_from_turn(
        &mut self,
        audit: &mut dyn AuditPort,
        person: &str,
        agent: &str,
    ) -> Result<(), GrantError> {
        self.write(|tx, a, g| g.renew_job_grants_from_turn(tx, &a.chain, audit, person, agent))
    }
}

impl GrantSource for PermissionStores {
    fn max_grant_days(&self) -> Option<f64> {
        Some(self.grants.max_grant_days())
    }
    fn list(&self, person: &str, agent: &str, capability: &str) -> Vec<Value> {
        self.grants_for(person, agent, capability)
            .unwrap_or_default()
    }
    fn get(&self, id: &str) -> Option<Value> {
        self.grant(id).ok().flatten()
    }
}
