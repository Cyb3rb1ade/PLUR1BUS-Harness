//! `rbac/break-glass.ts` (ADR-007, Privacy): the only way Owner and Admin read another user's `user`-scope cards.
//! Mandatory reason, time-boxed, audited (grant, every use, expiry, revocation), the affected user is notified, read only.
//! `authorize` itself stays pure: this registry mints the grants and hands them to it (P4-12 task 6).
//!
//! The registry lives in memory: a restart ends every grant. The clock, the id source, the audit sink and the notice
//! port are parameters. The recorded sequences (`fixtures/parity/rbac-guard/break-glass.json`) are replayed by
//! `guard_vectors.rs`.
use super::audit::{AuditEvent, AuditSink};
use super::authorize::authorize;
use super::types::{
    AllowReason, AuthorizeContext, BreakGlassGrant, Decision, DenyReason, Principal, PrincipalKind,
    Resource, Role,
};
use crate::js::{json_stringify, trim_units, utf16};
use serde_json::{json, Value};

/// `MIN_REASON_CHARS`.
pub const MIN_REASON_CHARS: i64 = 10;
/// `MAX_REASON_CHARS`.
pub const MAX_REASON_CHARS: i64 = 500;
/// `DEFAULT_TTL_MS`: 15 minutes.
pub const DEFAULT_TTL_MS: i64 = 15 * 60_000;
/// `MIN_TTL_MS`: one minute.
pub const MIN_TTL_MS: i64 = 60_000;
/// `MAX_TTL_MS`: one hour.
pub const MAX_TTL_MS: i64 = 60 * 60_000;

/// `BreakGlassNotice` (kind `granted`): what the affected user is told, and what `admin_notices` holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BreakGlassNotice {
    /// The affected user: the one whose cards may now be read.
    pub user_id: String,
    /// The grant.
    pub grant_id: String,
    /// Who holds it.
    pub holder_user_id: String,
    /// The reason given.
    pub reason: String,
    /// When the grant lapses.
    pub expires_at: i64,
}

impl BreakGlassNotice {
    /// `JSON.stringify(notice)`: the members in the order the registry writes them.
    pub fn payload(&self) -> String {
        format!(
            "{{\"kind\":\"granted\",\"userId\":{},\"grantId\":{},\"holderUserId\":{},\"reason\":{},\"expiresAt\":{}}}",
            json_stringify(&self.user_id),
            json_stringify(&self.grant_id),
            json_stringify(&self.holder_user_id),
            json_stringify(&self.reason),
            self.expires_at
        )
    }
    /// The notice as a value.
    pub fn to_json(&self) -> Value {
        json!({ "kind": "granted", "userId": self.user_id, "grantId": self.grant_id, "holderUserId": self.holder_user_id,
            "reason": self.reason, "expiresAt": self.expires_at })
    }
}

/// `BreakGlassErrorCode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BreakGlassErrorCode {
    /// `not-permitted`
    NotPermitted,
    /// `invalid-target`
    InvalidTarget,
    /// `self-target`
    SelfTarget,
    /// `reason-required`
    ReasonRequired,
    /// `ttl-invalid`
    TtlInvalid,
    /// `audit-failed`
    AuditFailed,
    /// `unknown-grant`
    UnknownGrant,
    /// `notification-failed`
    NotificationFailed,
}

impl BreakGlassErrorCode {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            BreakGlassErrorCode::NotPermitted => "not-permitted",
            BreakGlassErrorCode::InvalidTarget => "invalid-target",
            BreakGlassErrorCode::SelfTarget => "self-target",
            BreakGlassErrorCode::ReasonRequired => "reason-required",
            BreakGlassErrorCode::TtlInvalid => "ttl-invalid",
            BreakGlassErrorCode::AuditFailed => "audit-failed",
            BreakGlassErrorCode::UnknownGrant => "unknown-grant",
            BreakGlassErrorCode::NotificationFailed => "notification-failed",
        }
    }
}

/// `BreakGlassError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BreakGlassError {
    /// What kind of refusal.
    pub code: BreakGlassErrorCode,
    /// The message.
    pub message: String,
}

impl std::fmt::Display for BreakGlassError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for BreakGlassError {}

fn refuse<T>(code: BreakGlassErrorCode, message: impl Into<String>) -> Result<T, BreakGlassError> {
    Err(BreakGlassError {
        code,
        message: message.into(),
    })
}

/// The limits a request is checked against (`limits()` of the options).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BreakGlassLimits {
    /// The shortest reason, in UTF-16 code units after trimming.
    pub reason_min_chars: i64,
    /// The longest reason.
    pub reason_max_chars: i64,
    /// The longest lifetime of a grant, in minutes; also caps the default lifetime.
    pub max_window_minutes: i64,
}

impl Default for BreakGlassLimits {
    fn default() -> Self {
        BreakGlassLimits {
            reason_min_chars: MIN_REASON_CHARS,
            reason_max_chars: MAX_REASON_CHARS,
            max_window_minutes: MAX_TTL_MS / 60_000,
        }
    }
}

/// Tells the affected user of a grant; its error is the text the audit records.
pub type Notify = Box<dyn FnMut(&BreakGlassNotice) -> Result<(), String>>;

/// `BreakGlassOptions`.
pub struct BreakGlassOptions {
    /// The audit sink. A grant, a use or a revocation that cannot be recorded does not happen.
    pub audit: Box<dyn AuditSink>,
    /// The limits of a request, read at every request; `None` is [`BreakGlassLimits::default`].
    pub limits: Option<Box<dyn Fn() -> BreakGlassLimits>>,
    /// Tells the affected user at once. Its error is the text the audit records.
    pub notify: Notify,
    /// A grant whose notice fails is withdrawn and the request refused.
    pub require_notification: bool,
    /// Epoch milliseconds.
    pub clock: Box<dyn Fn() -> i64>,
    /// The id of a new grant.
    pub id_gen: Box<dyn FnMut() -> String>,
    /// The `actor.host` of audit lines; `None` is `local`.
    pub host: Option<String>,
}

/// `BreakGlassRequest`. `ttl_ms` is a JavaScript number: an integer within the limits, or the request is refused.
#[derive(Clone, Debug, PartialEq)]
pub struct BreakGlassRequest {
    /// Whose cards.
    pub target_user_id: String,
    /// Why.
    pub reason: String,
    /// For how long; `None` is 15 minutes, or the window if that is shorter.
    pub ttl_ms: Option<f64>,
}

/// The registry (`createBreakGlass`).
pub struct BreakGlass {
    o: BreakGlassOptions,
    host: String,
    /// The live and the lapsed-but-not-yet-audited grants, oldest first.
    grants: Vec<BreakGlassGrant>,
}

impl BreakGlass {
    /// An empty registry.
    pub fn new(o: BreakGlassOptions) -> BreakGlass {
        let host = o.host.clone().unwrap_or_else(|| "local".to_owned());
        BreakGlass {
            o,
            host,
            grants: Vec::new(),
        }
    }

    fn record(
        &mut self,
        action: &str,
        actor: &str,
        target: &str,
        detail: Vec<(&str, Value)>,
    ) -> Result<(), String> {
        let event = AuditEvent {
            at: (self.o.clock)(),
            user: actor.to_owned(),
            host: self.host.clone(),
            action: action.to_owned(),
            target: target.to_owned(),
            detail: detail.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
        };
        self.o.audit.append(&event)
    }

    /// `sweep()`: writes one `break-glass.expired` event per lapsed grant and drops it; returns how many it wrote. A grant
    /// whose expiry cannot be audited is kept for the next sweep; it is unusable meanwhile.
    pub fn sweep(&mut self) -> usize {
        let now = (self.o.clock)() as f64;
        let mut n = 0;
        for g in self.grants.clone() {
            if g.expires_at > now {
                continue;
            }
            let detail = vec![
                ("grantId", json!(g.id)),
                ("holderUserId", json!(g.holder_user_id)),
                ("expiresAt", json!(g.expires_at as i64)),
            ];
            if self
                .record("break-glass.expired", "system", &g.target_user_id, detail)
                .is_err()
            {
                continue;
            }
            self.grants.retain(|x| x.id != g.id);
            n += 1;
        }
        n
    }

    fn live(&self, holder_user_id: &str) -> Vec<BreakGlassGrant> {
        let now = (self.o.clock)() as f64;
        self.grants
            .iter()
            .filter(|g| g.holder_user_id == holder_user_id && g.expires_at > now)
            .cloned()
            .collect()
    }

    /// `active(holderUserId)`: the holder's live grants.
    pub fn active(&mut self, holder_user_id: &str) -> Vec<BreakGlassGrant> {
        self.sweep();
        self.live(holder_user_id)
    }

    /// `request(holder, req)`. The refusals in order: no target; not a person; not allowed by the policy
    /// (`breakglass.request`: Owner or Admin, narrowed by token scopes); one's own cards; the reason; the lifetime. Then
    /// the grant is audited (or not made), stored, and the affected user notified.
    pub fn request(
        &mut self,
        holder: &Principal,
        req: &BreakGlassRequest,
    ) -> Result<BreakGlassGrant, BreakGlassError> {
        let target = req.target_user_id.as_str();
        if target.is_empty() {
            return refuse(
                BreakGlassErrorCode::InvalidTarget,
                "a target user is required",
            );
        }
        // A principal without a kind is the library-level shape the policy already accepts; an explicit non-person is refused.
        if holder.kind.is_some_and(|k| k != PrincipalKind::Person) {
            return refuse(
                BreakGlassErrorCode::NotPermitted,
                "break-glass is for people only",
            );
        }
        let ctx = AuthorizeContext {
            now: Some((self.o.clock)() as f64),
        };
        if !authorize(
            Some(holder),
            "breakglass.request",
            &Resource::User {
                user_id: target.to_owned(),
            },
            &ctx,
        )
        .is_allow()
        {
            return refuse(
                BreakGlassErrorCode::NotPermitted,
                "break-glass is not permitted for this principal",
            );
        }
        if target == holder.user_id {
            return refuse(
                BreakGlassErrorCode::SelfTarget,
                "break-glass on one's own cards is meaningless",
            );
        }
        let units = utf16(&req.reason);
        let trimmed = trim_units(&units);
        let reason = String::from_utf16_lossy(trimmed);
        let limits = self
            .o
            .limits
            .as_ref()
            .map_or_else(BreakGlassLimits::default, |f| f());
        let length = trimmed.len() as i64;
        if length < limits.reason_min_chars || length > limits.reason_max_chars {
            return refuse(
                BreakGlassErrorCode::ReasonRequired,
                format!(
                    "a reason of {}-{} characters is required",
                    limits.reason_min_chars, limits.reason_max_chars
                ),
            );
        }
        let max_ttl_ms = limits.max_window_minutes * 60_000;
        let ttl = req.ttl_ms.unwrap_or(DEFAULT_TTL_MS.min(max_ttl_ms) as f64);
        if !ttl.is_finite()
            || ttl.fract() != 0.0
            || ttl < MIN_TTL_MS as f64
            || ttl > max_ttl_ms as f64
        {
            return refuse(
                BreakGlassErrorCode::TtlInvalid,
                format!("ttlMs must be an integer between {MIN_TTL_MS} and {max_ttl_ms}"),
            );
        }
        let ttl_ms = ttl as i64;
        self.sweep();
        let issued_at = (self.o.clock)();
        let expires_at = issued_at + ttl_ms;
        let grant = BreakGlassGrant {
            id: (self.o.id_gen)(),
            holder_user_id: holder.user_id.clone(),
            target_user_id: target.to_owned(),
            reason: reason.clone(),
            issued_at: issued_at as f64,
            expires_at: expires_at as f64,
            revoked_at: None,
        };
        let detail = vec![
            ("grantId", json!(grant.id)),
            ("reason", json!(reason)),
            ("issuedAt", json!(issued_at)),
            ("expiresAt", json!(expires_at)),
            ("ttlMs", json!(ttl_ms)),
        ];
        if self
            .record("break-glass.granted", &holder.user_id, target, detail)
            .is_err()
        {
            return refuse(
                BreakGlassErrorCode::AuditFailed,
                "the grant could not be audited, so it was not made",
            );
        }
        // As a `Map` keyed by id: an id handed out twice replaces the earlier grant.
        match self.grants.iter_mut().find(|g| g.id == grant.id) {
            Some(slot) => *slot = grant.clone(),
            None => self.grants.push(grant.clone()),
        }
        let notice = BreakGlassNotice {
            user_id: target.to_owned(),
            grant_id: grant.id.clone(),
            holder_user_id: holder.user_id.clone(),
            reason,
            expires_at,
        };
        if let Err(error) = (self.o.notify)(&notice) {
            if self.o.require_notification {
                self.grants.retain(|g| g.id != grant.id);
            }
            // The grant is already audited; a failure to record this one changes nothing.
            let _ = self.record(
                "break-glass.notify-failed",
                &holder.user_id,
                target,
                vec![("grantId", json!(grant.id)), ("error", json!(error))],
            );
            if self.o.require_notification {
                return refuse(
                    BreakGlassErrorCode::NotificationFailed,
                    "no grant without a durable notice",
                );
            }
        }
        Ok(grant)
    }

    /// `revoke(actor, grantId)`: the holder or an Owner; audited, or not revoked.
    pub fn revoke(&mut self, actor: &Principal, grant_id: &str) -> Result<(), BreakGlassError> {
        let Some(g) = self.grants.iter().find(|g| g.id == grant_id).cloned() else {
            return refuse(BreakGlassErrorCode::UnknownGrant, "no such live grant");
        };
        if actor.kind.is_some_and(|k| k != PrincipalKind::Person) {
            return refuse(
                BreakGlassErrorCode::NotPermitted,
                "break-glass is for people only",
            );
        }
        if actor.user_id != g.holder_user_id && actor.role != Role::Owner {
            return refuse(
                BreakGlassErrorCode::NotPermitted,
                "only the holder or an Owner may revoke",
            );
        }
        let detail = vec![
            ("grantId", json!(g.id)),
            ("holderUserId", json!(g.holder_user_id)),
        ];
        if self
            .record(
                "break-glass.revoked",
                &actor.user_id,
                &g.target_user_id,
                detail,
            )
            .is_err()
        {
            return refuse(
                BreakGlassErrorCode::AuditFailed,
                "the revocation could not be audited",
            );
        }
        self.grants.retain(|x| x.id != g.id);
        Ok(())
    }

    /// `authorize(principal, action, resource)`: `authorize` with the registry's own live grants for this principal (any
    /// grants on the principal are ignored). A use of a grant is audited; one that cannot be is denied as `audit-failed`.
    pub fn authorize(
        &mut self,
        principal: Option<&Principal>,
        action: &str,
        resource: &Resource,
    ) -> Decision {
        self.sweep();
        let ctx = AuthorizeContext {
            now: Some((self.o.clock)() as f64),
        };
        let with_grants = principal.map(|p| Principal {
            break_glass: Some(self.live(&p.user_id)),
            ..p.clone()
        });
        let d = authorize(with_grants.as_ref(), action, resource, &ctx);
        let (
            Decision::Allow {
                reason: AllowReason::BreakGlass,
                break_glass_id,
            },
            Some(p),
        ) = (&d, principal)
        else {
            return d;
        };
        let target = match resource {
            Resource::MemoryUser { owner_user_id } => owner_user_id.clone(),
            _ => String::new(),
        };
        let detail = vec![
            ("grantId", json!(break_glass_id)),
            ("action", json!(action)),
        ];
        if self
            .record("break-glass.used", &p.user_id, &target, detail)
            .is_err()
        {
            return Decision::Deny {
                reason: DenyReason::AuditFailed,
            };
        }
        d
    }
}
