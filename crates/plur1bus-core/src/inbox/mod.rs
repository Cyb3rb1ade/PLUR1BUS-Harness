//! `packages/core/src/inbox/{store,service,producers,migrate}.ts` (P4-K K3b, plan P4-22): the durable per-person inbox. The
//! TypeScript code is the specification; a difference is a recorded `K3-D` finding. The RPC surface (`inbox/rpc`) is not
//! ported.
//!
//! **What it is.** `state/inbox.sqlite` holds one row per notification (`inbox_entries`, metadata only: an i18n key, a few
//! short scalar parameters, an app route and an object id; never a secret and never message content) and one row per rate
//! limited cause (`inbox_cooldowns`). A person has an entry at most once per `dedupeKey`; publishing it again changes nothing,
//! not even after the person read or dismissed it, until retention (90 days, 1000 entries per person by default) removed the
//! row. Retention runs before a publish (an entry past its age must not hide a repeat event) and after it. A cooldown
//! (`publishRateLimited`) is committed with the entry and does not depend on the entry staying. Lists page by a cursor that is
//! the base64url of a sequence number.
//!
//! **Producers never hurt their source.** [`service::InboxService`] is the port the producers write to: every `publish` and
//! `settle` is best effort, an inbox failure is logged and never reaches the module that announced the event, and a listener
//! that throws never undoes a write. [`producers`] maps what the other modules already announce (approvals, failed jobs, the
//! media index, pairing, a misconfigured channel, break-glass grants, old always-grants) to notices; every free-text parameter
//! goes through `param`, which masks token-shaped words, folds whitespace and clips to what the store accepts.
//!
//! **Nothing here runs in the product.** No RPC method, no producer hook, no Front Door route calls this module; the flip wires
//! it. What it needs from the rest of the core is a port (R-K-2): the clock ([`crate::budget::Clock`]), the id source
//! ([`crate::budget::IdSource`]), the administrator list, the change and metric listeners and the log sink.
//!
//! The store is opened by [`store::InboxStore::open`] as the TypeScript constructor opens it: private file, `busy_timeout`,
//! rollback journal (no WAL), `synchronous = FULL` (the SQLite default), the two `STRICT` tables and the index created with
//! `CREATE ... IF NOT EXISTS`, no `user_version`. The `:memory:` path of the TypeScript tests is not ported.
//!
//! Differences the types make, not the code: a text `slice` leaves a lone surrogate in TypeScript where a cut inside a pair
//! drops that half here (**K3-D4**, see `producers::param`); the member order of a `ref` written by a caller that names
//! `objectId` first is `route` first here (readers parse the JSON); a cursor is decoded the way Node decodes `base64url`
//! (invalid characters are skipped, `=` ends the input), see [`store::decode_cursor`].
pub mod migrate;
pub mod producers;
pub mod service;
pub mod store;

#[cfg(test)]
mod testing;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

pub use service::{
    InboxChange, InboxNotice, InboxPort, InboxService, InboxServiceOptions, InboxTarget,
    SettleTarget,
};
pub use store::{InboxStore, InboxStoreOptions};

use serde_json::Value;
use std::fmt;

/// The eight kinds of entry, in the order of `INBOX_KINDS`.
pub const INBOX_KINDS: [&str; 8] = [
    "breakglass",
    "approval",
    "job-failed",
    "update",
    "media-index",
    "pairing",
    "channel",
    "system",
];
/// The three severities.
pub const INBOX_SEVERITIES: [&str; 3] = ["info", "warning", "critical"];
/// Ninety days: how long an entry stays.
pub const DEFAULT_MAX_AGE_MS: i64 = 90 * 86_400_000;
/// Entries a person keeps.
pub const DEFAULT_MAX_ENTRIES: i64 = 1000;
/// Entries a page holds unless asked otherwise.
pub const DEFAULT_PAGE: i64 = 50;
/// Entries a page holds at most.
pub const MAX_PAGE: i64 = 200;
/// Ids one call names at most.
pub const MAX_IDS: usize = 500;

/// The parameters of an entry, in the order the caller named them (`JSON.stringify` keeps it). Values are short scalars; the
/// store refuses anything else.
pub type Params = Vec<(String, Value)>;

/// Where an entry leads (`InboxRef`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InboxRef {
    /// An app route (starts with `/`).
    pub route: Option<String>,
    /// The id of the thing the entry is about.
    pub object_id: Option<String>,
}

/// What a producer wants stored (`InboxDraft`). `kind` and `severity` are checked at run time: the draft may come from an
/// untyped caller.
#[derive(Clone, Debug, PartialEq)]
pub struct InboxDraft {
    /// The person.
    pub user_id: String,
    /// One of [`INBOX_KINDS`].
    pub kind: String,
    /// One of [`INBOX_SEVERITIES`].
    pub severity: String,
    /// The i18n key the client translates.
    pub title_key: String,
    /// The placeholders of the key.
    pub params: Option<Params>,
    /// Where the entry leads.
    pub reference: Option<InboxRef>,
    /// `kind:objectId`-style key: publishing it again for the same person is a no-op.
    pub dedupe_key: String,
}

/// An entry as a person reads it (`InboxEntry`).
#[derive(Clone, Debug, PartialEq)]
pub struct InboxEntry {
    /// The entry id.
    pub id: String,
    /// The kind.
    pub kind: String,
    /// The severity.
    pub severity: String,
    /// The i18n key.
    pub title_key: String,
    /// The parameters (a JSON object).
    pub params: Value,
    /// The reference (a JSON object), when there is one.
    pub reference: Option<Value>,
    /// When it was created.
    pub created_at: i64,
    /// When it was first read.
    pub read_at: Option<i64>,
    /// When it was dismissed or settled.
    pub dismissed_at: Option<i64>,
}

/// `InboxListQuery`. `limit` is a JavaScript number: a fraction is refused like a number out of range.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InboxListQuery {
    /// Only these kinds; an empty list means all.
    pub kinds: Option<Vec<String>>,
    /// Only entries nobody read.
    pub unread_only: bool,
    /// Also the dismissed ones.
    pub include_dismissed: bool,
    /// Page size, 1 to 200 (default 50).
    pub limit: Option<f64>,
    /// The `next_cursor` of the page before.
    pub cursor: Option<String>,
}

/// One page of a list.
#[derive(Clone, Debug, PartialEq)]
pub struct InboxPage {
    /// Newest first.
    pub entries: Vec<InboxEntry>,
    /// Present when there are more.
    pub next_cursor: Option<String>,
}

/// `InboxCounts`: unread entries per kind (every kind is present, in [`INBOX_KINDS`] order) and the visible entries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboxCounts {
    /// `(kind, unread)`.
    pub unread: Vec<(String, i64)>,
    /// Entries that are not dismissed.
    pub total: i64,
}

/// What `publish` returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Published {
    /// The entry (the existing one when `created` is false).
    pub id: String,
    /// Whether a row was written.
    pub created: bool,
}

/// Which entries a call names.
#[derive(Clone, Copy, Debug)]
pub enum Ids<'a> {
    /// Every entry of the person that the call applies to.
    All,
    /// These ids, one to 500, each up to 64 units.
    List(&'a [String]),
}

/// Why an inbox call failed.
#[derive(Debug)]
pub enum InboxError {
    /// `InboxError("invalid", ...)`: the input is refused.
    Invalid(String),
    /// `InboxError("cursor", "cursor is not valid")`.
    Cursor,
    /// SQLite failed or a row does not parse.
    Store(String),
}

impl InboxError {
    pub(crate) fn invalid(m: &str) -> Self {
        Self::Invalid(m.to_owned())
    }
    /// `error.code` of the TypeScript class (`invalid` or `cursor`); `None` for a storage failure.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Invalid(_) => Some("invalid"),
            Self::Cursor => Some("cursor"),
            Self::Store(_) => None,
        }
    }
}

impl fmt::Display for InboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(m) | Self::Store(m) => f.write_str(m),
            Self::Cursor => f.write_str("cursor is not valid"),
        }
    }
}

impl std::error::Error for InboxError {}

impl From<plur1bus_store::rusqlite::Error> for InboxError {
    fn from(e: plur1bus_store::rusqlite::Error) -> Self {
        Self::Store(e.to_string())
    }
}

impl From<plur1bus_store::StoreError> for InboxError {
    fn from(e: plur1bus_store::StoreError) -> Self {
        Self::Store(e.to_string())
    }
}
