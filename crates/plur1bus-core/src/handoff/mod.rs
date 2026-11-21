//! `packages/core/src/channel-handoff/service.ts` (P4-K K3b, plan P4-22): the rule that decides whether the text of a channel
//! conversation may become visible in Web. The TypeScript code is the specification; a difference is a recorded `K3-D` finding.
//!
//! **This is a security rule.** A session becomes *visible* only when a trusted direct ingress recorded it: a direct message
//! from the linked handle of the person who owns it, in a session that had no history yet. A group or broadcast message in a
//! session taints it for good (`channel_taint`), removes any direct record, and no later message undoes it; a session that
//! already had messages before it was first seen as direct is tainted too, because nothing says who wrote them. A one-use link
//! (`channel_handoffs`, the SHA-256 of a 43-character token, ten minutes, five per person) redeems into a *separate* Web
//! session seeded with quoted, untrusted context; the channel session stays where it is. Every refusal is the same
//! `E_NOT_FOUND`, so a caller learns nothing about which check failed, and an unreadable state (a row that does not parse, a
//! store that fails, a derivation that is refused) is never a reason to show anything: it denies.
//!
//! **Nothing here runs in the product.** No RPC method (`channel.handoff.*`, `channel.history.*`), no Front Door route, no
//! switchboard hook reaches this module; the flip wires it. What it needs from the rest of the core comes in as a port
//! (R-K-2): the session store ([`SessionPort`]), the identity lookup ([`HumanLookup`]), the principal lookup, the clock
//! ([`crate::budget::Clock`]), the random source ([`crate::approvals::Random`]) and the audit sink
//! ([`crate::rbac::audit::AuditSink`]). The store is `state/channel-handoff.sqlite`, opened by [`store::open`] as the
//! TypeScript constructor opens it (private file, WAL, `synchronous = FULL`, four `CREATE TABLE IF NOT EXISTS`, no
//! `user_version`).
//!
//! Differences the types make, not the code: a text the TypeScript code cuts with `slice` is cut at the same UTF-16 unit
//! here, but a cut that would leave half of a surrogate pair drops that half (a Rust string cannot hold it): **K3-D4**.
pub mod service;
pub mod store;

#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

pub use service::{web_base, ChannelHandoff, HandoffOptions};

use crate::rbac::types::Principal;
use std::fmt;

/// `ChatKind` of a channel message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatKind {
    /// `direct`: a one-to-one conversation.
    Direct,
    /// `group`.
    Group,
    /// `broadcast`.
    Broadcast,
}

/// `InboundMessage`: what the hand-off and delivery rules read of one message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboundMessage {
    /// The channel name.
    pub channel: String,
    /// The channel's own id of the conversation.
    pub chat_id: String,
    /// Direct, group or broadcast.
    pub chat_kind: ChatKind,
    /// The channel's own id of the sender.
    pub sender_id: String,
    /// The account (bot, workspace) that received it; absent on a channel that has none.
    pub account_id: Option<String>,
    /// The text.
    pub text: String,
}

/// What the hand-off reads of one session (`SessionStore.getSession`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRecord {
    /// The session id.
    pub id: String,
    /// `channel`, `direct`, and whatever else the store knows.
    pub kind: String,
    /// The owner's principal (`user:v2:...`).
    pub owner: String,
    /// `channel:chatId` of a channel session.
    pub chat_key: Option<String>,
    /// The agent the session talks to.
    pub agent_id: String,
    /// The title, when it has one.
    pub title: Option<String>,
    /// When it last changed.
    pub updated_at: i64,
}

/// One message of a session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageRecord {
    /// `user` or `assistant`.
    pub role: String,
    /// The text.
    pub text: String,
    /// When it was written.
    pub created_at: i64,
}

/// The session store as the hand-off uses it (`SessionStore`). Every method may fail; the hand-off then denies.
pub trait SessionPort {
    /// `store()` returned a store (it is `null` while the core has none).
    fn available(&self) -> bool;
    /// `getSession`.
    fn get_session(&self, id: &str) -> Result<Option<SessionRecord>, String>;
    /// `listMessages(id, { limit: 1 }).length > 0`: the session has history.
    fn has_messages(&self, id: &str) -> Result<bool, String>;
    /// `listMessages(id, { limit: 200, beforeSeq: Number.MAX_SAFE_INTEGER })`: the last 200 messages, oldest first.
    fn last_messages(&self, id: &str) -> Result<Vec<MessageRecord>, String>;
    /// `activeForChat`: the open session of a chat.
    fn active_for_chat(&self, chat_key: &str) -> Result<Option<SessionRecord>, String>;
    /// `createSession({ kind: "channel", ... })`.
    fn create_channel_session(
        &mut self,
        agent_id: &str,
        owner: &str,
        chat_key: &str,
        title: &str,
    ) -> Result<SessionRecord, String>;
    /// `activeSummaries(listSummaries(id, "applied"), summaryRewinds(id)).map((s) => s.text)`: the applied summaries that no
    /// live rewind hides, oldest first.
    fn active_summary_texts(&self, id: &str) -> Result<Vec<String>, String>;
    /// `contextMessages`: the messages the model would see, oldest first.
    fn context_messages(&self, id: &str) -> Result<Vec<MessageRecord>, String>;
    /// `createContinuation`: a new `direct` Web session seeded with `context`; returns its id.
    fn create_continuation(
        &mut self,
        agent_id: &str,
        owner: &str,
        title: &str,
        context: &str,
    ) -> Result<String, String>;
}

/// `identity()?.resolve({ channel, accountId, userId })?.humanId`: the person a channel handle is linked to, by an active
/// link only. `None` also when the identity service is not up.
pub trait HumanLookup {
    /// The linked person, if any.
    fn human_of(&self, channel: &str, account_id: &str, user_id: &str) -> Option<String>;
}

/// The platform's owner-only hook (`createSecurePath()(path, { mode: 0o600 }).applied`).
pub type SecurePath = Box<dyn Fn(&std::path::Path) -> bool>;

/// `resolve(id)`: the principal of a person, `None` when the person is unknown.
pub type PrincipalLookup = Box<dyn Fn(&str) -> Option<Principal>>;

/// A session as a person sees it in the history list and in `get`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryEntry {
    /// The session id.
    pub id: String,
    /// The agent.
    pub agent_id: String,
    /// The title, when it has one.
    pub title: Option<String>,
    /// The channel it came from.
    pub channel: String,
    /// When it last changed.
    pub updated_at: i64,
}

/// What `list` returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryList {
    /// At most 200 sessions, the newest observed first.
    pub sessions: Vec<HistoryEntry>,
    /// There were more than 200.
    pub truncated: bool,
}

/// What `get` returns: the session and its last 200 messages.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryView {
    /// The session.
    pub session: HistoryEntry,
    /// Oldest first.
    pub messages: Vec<MessageRecord>,
}

/// What `issue` returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issued {
    /// The one-use token; it is never logged and never audited.
    pub token: String,
    /// When it stops working.
    pub expires_at: i64,
    /// `#/chat/handoff/<token>`.
    pub path: String,
}

/// What `redeem` returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Redeemed {
    /// The new Web session.
    pub session_id: String,
    /// The channel session it came from.
    pub from_session_id: String,
    /// The channel it came from.
    pub from_channel: String,
}

/// Why a hand-off call failed.
#[derive(Debug)]
pub enum HandoffError {
    /// `RpcError`: the code (`E_NOT_FOUND`, `E_NOT_AVAILABLE`) and its text. `E_NOT_FOUND` is the one refusal of every
    /// check, so the answer says nothing about which one failed.
    Rpc {
        /// The error code.
        code: &'static str,
        /// The text.
        message: &'static str,
    },
    /// The audit sink could not record the event; nothing was done.
    Audit(String),
    /// The harness user id of a person is not one (`deriveUserPrincipal` refuses it).
    Identity(String),
    /// SQLite or a port failed. The call did nothing that is visible.
    Store(String),
}

impl HandoffError {
    /// `deny()`: the one refusal.
    pub(crate) fn deny() -> Self {
        Self::Rpc {
            code: "E_NOT_FOUND",
            message: "channel conversation or continuation unavailable",
        }
    }
    pub(crate) fn not_available(message: &'static str) -> Self {
        Self::Rpc {
            code: "E_NOT_AVAILABLE",
            message,
        }
    }
    /// Whether this is the refusal [`HandoffError::deny`] makes.
    pub fn is_denied(&self) -> bool {
        matches!(
            self,
            Self::Rpc {
                code: "E_NOT_FOUND",
                ..
            }
        )
    }
}

impl fmt::Display for HandoffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rpc { message, .. } => f.write_str(message),
            Self::Audit(m) | Self::Identity(m) | Self::Store(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for HandoffError {}

impl From<plur1bus_store::rusqlite::Error> for HandoffError {
    fn from(e: plur1bus_store::rusqlite::Error) -> Self {
        Self::Store(e.to_string())
    }
}

impl From<plur1bus_store::StoreError> for HandoffError {
    fn from(e: plur1bus_store::StoreError) -> Self {
        Self::Store(e.to_string())
    }
}
