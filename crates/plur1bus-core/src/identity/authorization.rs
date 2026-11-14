//! `identity/authorization.ts`: the identity action gate on top of the typed RBAC decision (P4-12 task 1).
use super::error::{IdentityError, IdentityErrorCode};
use super::service::Actor;
use crate::rbac::authorize::authorize;
use crate::rbac::types::{AuthorizeContext, Principal, PrincipalKind, Resource};

/// `IdentityAction`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityAction {
    /// `create`
    Create,
    /// `link`
    Link,
    /// `unlink`
    Unlink,
    /// `pair`
    Pair,
    /// `confirm`
    Confirm,
    /// `backfill`
    Backfill,
}

impl IdentityAction {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            IdentityAction::Create => "create",
            IdentityAction::Link => "link",
            IdentityAction::Unlink => "unlink",
            IdentityAction::Pair => "pair",
            IdentityAction::Confirm => "confirm",
            IdentityAction::Backfill => "backfill",
        }
    }
    /// The action named exactly `s`.
    pub fn parse(s: &str) -> Option<IdentityAction> {
        [
            IdentityAction::Create,
            IdentityAction::Link,
            IdentityAction::Unlink,
            IdentityAction::Pair,
            IdentityAction::Confirm,
            IdentityAction::Backfill,
        ]
        .into_iter()
        .find(|a| a.as_str() == s)
    }
}

/// `AuthorizePort`: the policy the identity service asks. An injected policy can narrow or extend human rights.
pub trait AuthorizePort {
    /// May `actor` perform `action` on the harness user `harness_user_id`?
    fn authorize(&self, actor: &Actor, action: IdentityAction, harness_user_id: &str) -> bool;
}

/// `rbacAuthorizePort`: reuses the existing RBAC actions. Only a person with a role is ever allowed; `create` and `backfill`
/// need `users.manage` on the system; the others allow `users.manage` or (for the actor's own user) `my.write`.
#[derive(Clone, Copy, Debug, Default)]
pub struct RbacAuthorizePort;

impl AuthorizePort for RbacAuthorizePort {
    fn authorize(&self, actor: &Actor, action: IdentityAction, harness_user_id: &str) -> bool {
        let (Some(PrincipalKind::Person), Some(role)) = (actor.kind, actor.role) else {
            return false;
        };
        let mut principal = Principal::new(actor.user.clone(), role);
        principal.kind = Some(PrincipalKind::Person);
        principal.token_scopes = actor.token_scopes.clone();
        let ctx = AuthorizeContext::default();
        let elevated =
            authorize(Some(&principal), "users.manage", &Resource::System, &ctx).is_allow();
        if matches!(action, IdentityAction::Backfill | IdentityAction::Create) {
            return elevated;
        }
        let own = actor.user == harness_user_id
            && authorize(
                Some(&principal),
                "my.write",
                &Resource::User {
                    user_id: harness_user_id.to_owned(),
                },
                &ctx,
            )
            .is_allow();
        elevated || own
    }
}

/// `requireAuthorization`: an injected policy can narrow or extend human rights, but never authorize an agent. Refused as
/// `denied` ("identity action denied").
pub fn require_authorization(
    port: &dyn AuthorizePort,
    actor: &Actor,
    action: IdentityAction,
    user: &str,
) -> Result<(), IdentityError> {
    if actor.kind != Some(PrincipalKind::Person) || !port.authorize(actor, action, user) {
        return Err(IdentityError::new(
            IdentityErrorCode::Denied,
            "identity action denied",
        ));
    }
    Ok(())
}
