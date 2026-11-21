//! `packages/core/src/delivery/{policy,service}.ts` (P4-K K3b, plan P4-22): which channel destinations may receive a message
//! the core sends on its own (a result, a job outcome), and how a person proves that a destination is theirs. The TypeScript
//! code is the specification; a difference is a recorded `K3-D` finding.
//!
//! **What the rule is.** A destination is one linked channel handle of one person (`delivery_targets`, at most 32 per person).
//! It becomes usable only after a code was sent to *that* handle's own direct chat and came back from it: the exact
//! `/delivery <32 hex>` text, in a direct message, from the same channel, bot account, sender and chat, within ten minutes and
//! five tries. Every use re-checks the whole chain, because any link of it can change after the confirmation: the person still
//! exists, the handle is still linked to that person (an active link only), the configuration still allows the handle
//! ([`policy::delivery_allowed`]), the person still holds the right to use the agent, and the channel still resolves the
//! target to the chat that was confirmed. Anything else is the one refusal, `E_DENIED` "delivery destination denied", which
//! says nothing about which check failed; a refused use of a validated destination is audited (`delivery.denied`).
//!
//! **Nothing here runs in the product.** No RPC method, no Front Door route, no scheduler or job hook calls this module; the
//! flip wires it. What it needs from the rest of the core comes in as a port (R-K-2): the clock ([`crate::budget::Clock`]),
//! the id source ([`crate::budget::IdSource`]), the random source ([`crate::approvals::Random`]), the audit sink
//! ([`crate::rbac::audit::AuditSink`]), the identity lookup ([`DeliveryIdentity`]), the principal lookup, the configuration's
//! allowlist check, and the channel (`target` resolves the chat, `send` delivers). TypeScript's `async` ports are plain
//! callbacks here; the places where the TypeScript code awaits (and another caller can change the state) are the places where
//! this code calls a port *outside* a write transaction and re-reads afterwards, so the recheck stays meaningful.
//!
//! The store is `state/delivery.sqlite`, opened by [`store::open`] as the TypeScript constructor opens it (private file, WAL,
//! `synchronous = FULL`, one `CREATE TABLE IF NOT EXISTS`, no `user_version`). A row holds the target as JSON; a row that does
//! not parse fails the call (never a reason to allow anything).
//!
//! Differences the types make, not the code: the member order of a row written after a second challenge differs from
//! `JSON.stringify` of the mutated object (`attempts` before `codeHash`); readers parse the JSON, so nothing observes it.
pub mod policy;
pub mod service;
pub mod store;

#[cfg(test)]
mod testing;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

pub use policy::delivery_allowed;
pub use service::{DeliveryOptions, DeliveryTargets};

use serde::{Deserialize, Serialize};
use std::fmt;

/// `allowed`: whether the configuration still allows a handle.
pub type AllowedPort = Box<dyn Fn(&ChannelIdentity) -> bool>;
/// `target`: the chat the channel resolves for a handle; empty when it has none.
pub type TargetPort = Box<dyn FnMut(&ChannelIdentity) -> String>;
/// `send(channel, chatId, text)`: whether the channel took the message.
pub type SendPort = Box<dyn FnMut(&str, &str, &str) -> bool>;
/// The host's owner-only file hook. On Windows a successful result verifies
/// the database ACL and its private parent, including access inherited by
/// SQLite's journal and sidecars. It runs before database creation or open.
pub type SecurePath = Box<dyn Fn(&std::path::Path) -> bool>;

/// `ChannelIdentity`: one handle on one channel account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelIdentity {
    /// The channel name.
    pub channel: String,
    /// The bot or workspace account.
    pub account_id: String,
    /// The channel's own id of the person.
    pub user_id: String,
}

/// One subscription of a target to the outcome of a job.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    /// `system` or `dreams`.
    pub source: String,
    /// The job name.
    pub job: String,
    /// The agent the job runs for.
    pub agent_id: String,
}

/// A stored target, with its confirmation state (what `validate` returns).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRow {
    /// The target id.
    pub id: String,
    /// The person it belongs to.
    pub person: String,
    /// The handle.
    pub identity: ChannelIdentity,
    /// The chat the channel resolved for the handle; empty until it did.
    pub chat_id: String,
    /// Whether the code came back.
    pub validated: bool,
    /// When it was added.
    pub created_at: i64,
    /// SHA-256 (hex) of the outstanding code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_hash: Option<String>,
    /// When the outstanding code stops working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<i64>,
    /// Tries made against the outstanding code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<i64>,
    /// The jobs whose outcome goes here, at most 32.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscriptions: Option<Vec<Subscription>>,
}

/// A target as a person sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryTarget {
    /// The target id.
    pub id: String,
    /// The person.
    pub person: String,
    /// The handle.
    pub identity: ChannelIdentity,
    /// The confirmed chat.
    pub chat_id: String,
    /// Whether it is confirmed *and* still passes every live check.
    pub validated: bool,
    /// When it was added.
    pub created_at: i64,
}

/// A handle as the identity service lists it (`list({}).humans[].identities[]`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkedIdentity {
    /// The handle.
    pub identity: ChannelIdentity,
    /// The person it is linked to.
    pub human_id: String,
    /// The link was revoked (`revokedAt !== null`).
    pub revoked: bool,
}

/// The identity service as delivery uses it. Both answers are empty while the service is not up (`identity()` is `null`).
pub trait DeliveryIdentity {
    /// `resolve(identity)?.humanId`: the person of an *active* link.
    fn resolve(&self, identity: &ChannelIdentity) -> Option<String>;
    /// Every handle of every person, in the service's order.
    fn linked(&self) -> Vec<LinkedIdentity>;
}

/// What `challenge` returns: the code is never part of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenged {
    /// The code went out on the channel; the answer comes back through [`DeliveryTargets::confirm_message`].
    pub awaiting_channel: bool,
}

/// Why a delivery call failed.
#[derive(Debug)]
pub enum DeliveryError {
    /// `RpcError`: the code (`E_DENIED`, `E_NOT_AVAILABLE`) and its text.
    Rpc {
        /// The error code.
        code: &'static str,
        /// The text.
        message: &'static str,
    },
    /// The audit sink could not record the event; nothing was done.
    Audit(String),
    /// SQLite failed or a row does not parse. The call did nothing that is visible.
    Store(String),
}

impl DeliveryError {
    /// `denied()`: the one refusal.
    pub(crate) fn denied() -> Self {
        Self::Rpc {
            code: "E_DENIED",
            message: "delivery destination denied",
        }
    }
    pub(crate) fn not_available(message: &'static str) -> Self {
        Self::Rpc {
            code: "E_NOT_AVAILABLE",
            message,
        }
    }
    /// Whether this is the refusal [`DeliveryError::denied`] makes.
    pub fn is_denied(&self) -> bool {
        matches!(
            self,
            Self::Rpc {
                code: "E_DENIED",
                ..
            }
        )
    }
}

impl fmt::Display for DeliveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rpc { message, .. } => f.write_str(message),
            Self::Audit(m) | Self::Store(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for DeliveryError {}

impl From<plur1bus_store::rusqlite::Error> for DeliveryError {
    fn from(e: plur1bus_store::rusqlite::Error) -> Self {
        Self::Store(e.to_string())
    }
}

impl From<plur1bus_store::StoreError> for DeliveryError {
    fn from(e: plur1bus_store::StoreError) -> Self {
        Self::Store(e.to_string())
    }
}
