//! Media search policy, bounded indexing, caption ports and backfill planning.

use crate::rbac::{
    authorize::authorize,
    types::{AuthorizeContext, Principal, Resource},
};
use serde::{Deserialize, Serialize};
use std::fmt;

pub mod admission;
pub mod backfill;
pub mod caption;
pub mod codec;
pub mod config;
pub mod hook;
pub mod index;

/// Stable refusal with a machine-readable wire code and reason.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Error {
    /// RPC error code at a future adapter boundary.
    pub code: &'static str,
    /// Bounded, content-free explanation.
    pub reason: &'static str,
}
impl Error {
    pub(super) const fn new(code: &'static str, reason: &'static str) -> Self {
        Self { code, reason }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.reason)
    }
}
impl std::error::Error for Error {}

/// Supported media kinds.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Image.
    Image,
    /// Video.
    Video,
    /// Audio.
    Audio,
}

/// Verified ownership and search partition.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    /// Workspace boundary.
    pub workspace: String,
    /// Agent in the workspace.
    pub agent_id: String,
    /// Optional common owner inside that workspace.
    pub user: Option<String>,
}
impl Scope {
    /// The TypeScript reference index shares visibility inside the same workspace.
    pub fn sees(&self, stored: &Self) -> bool {
        self.workspace == stored.workspace
            && (self.agent_id == stored.agent_id
                || self
                    .user
                    .as_ref()
                    .is_some_and(|user| !user.is_empty() && stored.user.as_ref() == Some(user)))
    }
}

/// Current identity and workspace binding owned by the application.
pub trait Authority {
    /// Current authenticated principal.
    fn principal(&self, user_id: &str) -> Option<Principal>;
    /// Whether the resolver authorizes this exact scope for the given principal.
    fn scope_is_current(&self, principal: &Principal, scope: &Scope) -> bool;
    /// Current epoch milliseconds.
    fn now(&self) -> u64;
}

/// One media operation with snapshot and live authorization.
pub struct Caller<'a> {
    /// Authenticated caller.
    pub who: &'a Principal,
    /// Original workspace binding.
    pub scope: &'a Scope,
    /// Current identity resolver.
    pub authority: &'a dyn Authority,
}
impl Caller<'_> {
    fn authorize(&self, action: &'static str) -> Result<(), Error> {
        let deny = Error::new("E_DENIED", "media-rights-changed");
        let live = self.authority.principal(&self.who.user_id).ok_or(deny)?;
        let ctx = AuthorizeContext {
            now: Some(self.authority.now() as f64),
        };
        if self.who.user_id != live.user_id
            || self.scope.workspace.is_empty()
            || self.scope.agent_id.is_empty()
            || [self.who, &live].into_iter().any(|p| {
                !authorize(Some(p), action, &Resource::System, &ctx).is_allow()
                    || !self.authority.scope_is_current(p, self.scope)
            })
        {
            return Err(deny);
        }
        Ok(())
    }
}
