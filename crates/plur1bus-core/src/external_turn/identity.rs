//! Authenticated owner derivation and operation-specific RBAC.

use super::{Audience, Error, Runtime, Subject, Target};
use crate::{
    exposure::types::ExposureChannel,
    rbac::{
        guard::{guard, principal_js, CallFacts, Resolved},
        types::{PrincipalKind, Role},
    },
    sessions::SessionOrigin,
};
use serde_json::json;

impl Audience {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Mcp => "mcp",
            Self::A2a => "a2a",
        }
    }

    pub(super) fn origin(self) -> SessionOrigin {
        match self {
            Self::Mcp => SessionOrigin::Mcp,
            Self::A2a => SessionOrigin::A2a,
        }
    }

    pub(super) fn from_origin(origin: Option<SessionOrigin>) -> Option<Self> {
        match origin {
            Some(SessionOrigin::Mcp) => Some(Self::Mcp),
            Some(SessionOrigin::A2a) => Some(Self::A2a),
            _ => None,
        }
    }

    pub(super) fn channel(self) -> ExposureChannel {
        match self {
            Self::Mcp => ExposureChannel::Mcp,
            Self::A2a => ExposureChannel::A2a,
        }
    }
}

impl Subject {
    pub(super) fn user(&self) -> &str {
        &self.exposure.principal.user_id
    }

    pub(super) fn owner(&self, audience: Audience) -> String {
        match &self.exposure.token_id {
            Some(id) => format!("ext:{}:{id}", audience.name()),
            None => format!("ext:{}:person:{}", audience.name(), self.user()),
        }
    }

    fn valid(&self) -> bool {
        id(self.user())
            && match self.exposure.token_id.as_deref() {
                Some(id_value) => id(id_value) && self.audience.is_some() && !self.local_human,
                None => {
                    self.local_human
                        && self.exposure.binding.is_none()
                        && self.exposure.principal.kind == Some(PrincipalKind::Person)
                }
            }
    }

    pub(super) fn local_owner(&self) -> bool {
        self.local_human
            && self.exposure.token_id.is_none()
            && self.exposure.binding.is_none()
            && self.exposure.principal.kind == Some(PrincipalKind::Person)
            && self.exposure.principal.role == Role::Owner
            && self.exposure.principal.token_scopes.is_none()
    }

    fn bound_agent(&self) -> Option<&str> {
        self.exposure
            .binding
            .as_ref()
            .map(|binding| binding.agent_id.as_str())
    }
}

pub(super) fn audience(
    subject: &Subject,
    input: &Target<'_>,
    stored: Option<Audience>,
) -> Result<Audience, Error> {
    if !subject.valid() {
        return Err(Error::new("E_UNAUTHORIZED", "external-identity"));
    }
    if input
        .token_id
        .is_some_and(|id| subject.exposure.token_id.as_deref() != Some(id))
    {
        return Err(Error::new("E_DENIED", "token-mismatch"));
    }
    if let Some(bound) = subject.audience {
        if input.audience.is_some_and(|requested| requested != bound) {
            return Err(Error::new("E_DENIED", "audience-mismatch"));
        }
        return Ok(bound);
    }
    input
        .audience
        .or(stored)
        .ok_or_else(|| Error::invalid("external-audience"))
}

pub(super) fn check(
    subject: &Subject,
    audience: Audience,
    agent: &str,
    method: &str,
    runtime: &dyn Runtime,
) -> Result<Subject, Error> {
    if !subject.valid() {
        return Err(Error::new("E_UNAUTHORIZED", "external-identity"));
    }
    let live = runtime
        .current(subject)
        .filter(|now| {
            now.valid()
                && now.user() == subject.user()
                && now.exposure.token_id == subject.exposure.token_id
                && now.audience == subject.audience
                && now.local_human == subject.local_human
                && now.bound_agent() == subject.bound_agent()
        })
        .ok_or_else(|| Error::new("E_DENIED", "external-rights-changed"))?;
    if !runtime.agent_active(agent) {
        return Err(Error::new("E_AGENT_UNKNOWN", "not-registered"));
    }
    let now = runtime.now();
    if now < 0 {
        return Err(Error::new("E_DENIED", "external-clock"));
    }
    let params = json!({"agentId":agent});
    for principal in [subject, &live] {
        if principal.audience.is_some_and(|bound| bound != audience) {
            return Err(Error::new("E_DENIED", "audience-mismatch"));
        }
        if principal.bound_agent().is_some_and(|bound| bound != agent) {
            return Err(Error::new("E_DENIED", "agent-mismatch"));
        }
        let resolved = principal_js(&principal.exposure.principal, principal.bound_agent());
        let decision = guard(
            method,
            &Resolved::Principal(&resolved),
            Some(&params),
            &CallFacts::default(),
            now,
            "external",
        )
        .ok_or_else(|| Error::new("E_DENIED", "external-rbac-unmapped"))?;
        if let Err(refusal) = decision.outcome {
            return Err(Error {
                code: refusal.code,
                reason: Some(refusal.reason),
            });
        }
    }
    Ok(live)
}

pub(super) fn id(raw: &str) -> bool {
    (1..=128).contains(&raw.len())
        && raw
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
