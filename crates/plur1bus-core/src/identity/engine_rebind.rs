//! `identity/engine-rebind.ts`: the engine side of the back-fill, [`MetadataRebindPort`] on the engine's
//! `memory.rebind` / `memory.unbind` (engine contract 1.12.0). The engine moves the owner metadata of the user-scope
//! cards of ONE channel identity to the harness user; it never copies card text, never rewrites a vector and keeps its own
//! sidecar of exactly the rows it touched, which is the receipt that makes the step reversible.
//!
//! The engine itself is a seam here ([`EngineMemory`]): the port names the channel identity from the service's ACTIVE
//! link (a removed link resolves to nothing, so it can never be back-filled), calls as the fixed system operator
//! ([`Operator`], [`system_context`]) and maps the engine's refusals.
use super::backfill::{MetadataRebindPort, Rebound};
use super::error::{IdentityError, IdentityErrorCode};
use super::principals::derive_user_principal;
use super::service_impl::{IdentityFailure, IdentityService};
use serde_json::{json, Value};

/// `RebindTarget`: what the engine needs to name a channel identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RebindTarget {
    /// The harness user the link belongs to.
    pub human_id: String,
    /// The channel kind.
    pub channel: String,
    /// The account on that channel.
    pub account_id: String,
    /// The external user id.
    pub user_id: String,
}

/// `rebindLookupFromService(service)(v1Principal)`: the active link behind a `user:v1:` principal, the oldest human and
/// link first.
pub fn rebind_lookup(
    service: &IdentityService,
    v1_principal: &str,
) -> Result<Option<RebindTarget>, IdentityFailure> {
    for (_, links) in service.list(false, false)?.humans {
        for link in links {
            if link.revoked_at.is_none() && link.v1_principal == v1_principal {
                return Ok(Some(RebindTarget {
                    human_id: link.human_id,
                    channel: link.channel,
                    account_id: link.account_id,
                    user_id: link.user_id,
                }));
            }
        }
    }
    Ok(None)
}

/// The principal the port calls the engine as: the agent whose store is back-filled, on the local CLI, proved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Operator {
    /// The agent (the engine rebinds per agent; one port per agent that holds person memories).
    pub agent_id: String,
}

impl Operator {
    /// `{ agentId, channel: "cli", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" }`.
    pub fn to_json(&self) -> Value {
        json!({ "agentId": self.agent_id, "channel": "cli", "accountId": "default", "chat": { "id": "c1", "kind": "direct" }, "trust": "proved" })
    }
}

/// The agent context of the calls: `{ origin: "system", background: false }`.
pub fn system_context() -> Value {
    json!({ "origin": "system", "background": false })
}

/// The request of `memory.rebind`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineRebind {
    /// The agent whose store is touched.
    pub agent_id: String,
    /// `fromIdentity.channel`.
    pub channel: String,
    /// `fromIdentity.identityKey`: the external user id.
    pub identity_key: String,
    /// `fromIdentity.accountId`.
    pub account_id: String,
    /// The harness user the cards go to.
    pub to_user: String,
    /// Count only.
    pub dry_run: bool,
}

impl EngineRebind {
    /// `{ agentId, fromIdentity: { channel, identityKey, accountId }, toUser, dryRun }`.
    pub fn to_json(&self) -> Value {
        json!({ "agentId": self.agent_id, "fromIdentity": { "channel": self.channel, "identityKey": self.identity_key, "accountId": self.account_id },
            "toUser": self.to_user, "dryRun": self.dry_run })
    }
}

/// What `memory.rebind` answers.
#[derive(Clone, Debug, PartialEq)]
pub struct EngineRebound {
    /// Rows that match.
    pub matched: f64,
    /// Rows moved.
    pub rebound: f64,
    /// The id of the engine's sidecar: the receipt.
    pub rebind_id: String,
}

/// What `memory.unbind` answers.
#[derive(Clone, Debug, PartialEq)]
pub struct EngineUnbound {
    /// Rows that match.
    pub matched: f64,
    /// Rows moved back.
    pub unbound: f64,
}

/// A failure of the engine; `code` is the engine's error code when it has one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineFailure {
    /// `e.code`.
    pub code: Option<String>,
}

/// `engine.memory`, as far as the back-fill uses it.
pub trait EngineMemory {
    /// `memory.rebind(request, operator, context)`.
    fn rebind(
        &mut self,
        request: &EngineRebind,
        operator: &Operator,
        context: &Value,
    ) -> Result<EngineRebound, EngineFailure>;
    /// `memory.unbind({ rebindId, dryRun }, operator, context)`.
    fn unbind(
        &mut self,
        rebind_id: &str,
        dry_run: bool,
        operator: &Operator,
        context: &Value,
    ) -> Result<EngineUnbound, EngineFailure>;
}

/// `createEngineRebindPort({ engine, agentId, lookup })`, with the lookup of [`rebind_lookup`].
pub struct EngineRebindPort<E> {
    /// The engine.
    pub engine: E,
    /// The agent whose store is back-filled.
    pub agent_id: String,
}

/// What an engine failure is to the caller: a channel identity already bound elsewhere is a conflict, a refused request
/// invalid parameters, everything else storage.
fn guard(e: &EngineFailure) -> IdentityError {
    match e.code.as_deref() {
        Some("identity-already-bound") => IdentityError::new(IdentityErrorCode::Conflict, "this channel identity is already bound to another user in the engine; unlink and relink instead"),
        Some(code @ ("invalid-input" | "denied")) => IdentityError::new(IdentityErrorCode::InvalidParams, format!("the engine refused the back-fill ({code})")),
        Some(code) if !code.is_empty() => IdentityError::new(IdentityErrorCode::Storage, format!("the engine failed the back-fill ({code})")),
        _ => IdentityError::new(IdentityErrorCode::Storage, "the engine failed the back-fill"),
    }
}

impl<E: EngineMemory> MetadataRebindPort for EngineRebindPort<E> {
    fn rebind(
        &mut self,
        links: &IdentityService,
        from: &str,
        to: &str,
        dry_run: bool,
        _operation_id: &str,
    ) -> Result<Rebound, IdentityError> {
        let target = rebind_lookup(links, from).map_err(|e| match e {
            IdentityFailure::Refused(e) => e,
            IdentityFailure::Sqlite(e) => {
                IdentityError::new(IdentityErrorCode::Storage, e.to_string())
            }
        })?;
        let t = target.ok_or_else(|| {
            IdentityError::new(
                IdentityErrorCode::NotFound,
                "no active link for this principal",
            )
        })?;
        if derive_user_principal(&t.human_id)? != to {
            return Err(IdentityError::new(
                IdentityErrorCode::Conflict,
                "the target principal does not belong to the linked user",
            ));
        }
        let request = EngineRebind {
            agent_id: self.agent_id.clone(),
            channel: t.channel,
            identity_key: t.user_id,
            account_id: t.account_id,
            to_user: t.human_id,
            dry_run,
        };
        let operator = Operator {
            agent_id: self.agent_id.clone(),
        };
        let r = self
            .engine
            .rebind(&request, &operator, &system_context())
            .map_err(|e| guard(&e))?;
        Ok(if dry_run {
            Rebound {
                count: r.matched,
                receipt: None,
            }
        } else {
            Rebound {
                count: r.rebound,
                receipt: Some(r.rebind_id),
            }
        })
    }

    fn reverse(
        &mut self,
        receipt: &str,
        dry_run: bool,
        _operation_id: &str,
    ) -> Result<f64, IdentityError> {
        let operator = Operator {
            agent_id: self.agent_id.clone(),
        };
        let r = self
            .engine
            .unbind(receipt, dry_run, &operator, &system_context())
            .map_err(|e| guard(&e))?;
        Ok(if dry_run { r.matched } else { r.unbound })
    }
}
