//! `memory-exposure/resolve.ts`: what a principal may read and capture of an agent's memory on a channel.
use super::config::channel_switches;
use super::types::{
    Disclose, Exposure, ExposureChannel, ExposurePrincipal, MemoryOverride, ScopeAccess, NO_SCOPES,
};
use crate::rbac::authorize::authorize;
use crate::rbac::types::{AuthorizeContext, MemoryAgentScope, Resource};
use serde_json::Value;

/// Bound personal API tokens keep kind=agent for human-only RBAC, but Core verifies their backing person. True agents without
/// a personal token id cannot acquire that person's user scope or capture attribution.
fn person_backed(p: &ExposurePrincipal, agent_id: &str) -> bool {
    p.principal.kind != Some(crate::rbac::types::PrincipalKind::Agent)
        || (p.token_id.as_deref().is_some_and(|t| !t.is_empty())
            && p.binding.as_ref().is_some_and(|b| b.agent_id == agent_id))
}

fn allowed(p: &ExposurePrincipal, action: &str, resource: &Resource) -> bool {
    authorize(
        Some(&p.principal),
        action,
        resource,
        &AuthorizeContext::default(),
    )
    .is_allow()
}

fn memory_agent(scope: MemoryAgentScope, agent_id: &str) -> Resource {
    Resource::MemoryAgent {
        scope,
        agent_id: agent_id.to_owned(),
    }
}

/// Capture writes must retain a current memory write grant, including any token action narrowing.
pub fn can_capture(p: &ExposurePrincipal, agent_id: &str) -> bool {
    if !person_backed(p, agent_id) {
        return false;
    }
    let user = Resource::MemoryUser {
        owner_user_id: p.principal.user_id.clone(),
    };
    allowed(
        p,
        "memory.workspace.write",
        &memory_agent(MemoryAgentScope::Workspace, agent_id),
    ) || allowed(p, "memory.user.write", &user)
        || allowed(
            p,
            "memory.agent-private.write",
            &memory_agent(MemoryAgentScope::AgentPrivate, agent_id),
        )
}

/// What the principal may read of the agent's memory, by the RBAC table (`memory.*.read`, ADR-007 "Privacy"): the user scope
/// only its own, the workspace scope with at least `use` on the agent, the agent-private scope with `manage`.
pub fn read_rights(principal: Option<&ExposurePrincipal>, agent_id: &str) -> ScopeAccess {
    let Some(p) = principal else {
        return NO_SCOPES;
    };
    ScopeAccess {
        workspace: allowed(
            p,
            "memory.workspace.read",
            &memory_agent(MemoryAgentScope::Workspace, agent_id),
        ),
        // A true agent has no user scope; a personal token remains narrowed by its explicit action scopes.
        user: person_backed(p, agent_id)
            && allowed(
                p,
                "memory.user.read",
                &Resource::MemoryUser {
                    owner_user_id: p.principal.user_id.clone(),
                },
            ),
        agent_private: allowed(
            p,
            "memory.agent-private.read",
            &memory_agent(MemoryAgentScope::AgentPrivate, agent_id),
        ),
    }
}

/// The effective memory exposure of `agent_id` on `channel` for the person (or agent) who asked: a scope is read only when the
/// agent's switch is on and the principal holds the right. A switch can narrow, never widen.
pub fn resolve_exposure(
    channel: ExposureChannel,
    agent_id: &str,
    principal: Option<&ExposurePrincipal>,
    config: &Value,
) -> Exposure {
    let switches = channel_switches(config, agent_id, channel);
    let rights = read_rights(principal, agent_id);

    let binding = principal.and_then(|p| p.binding.as_ref());
    let over: Option<MemoryOverride> = binding.and_then(|b| b.memory);
    let groups_allow_memory = binding
        .and_then(|b| b.groups.as_ref())
        .is_none_or(|g| g.iter().any(|x| x == "memory"));
    let disclose_never = over.and_then(|o| o.disclose) == Some(Disclose::Never);
    let recall = over.and_then(|o| o.recall);
    let open = groups_allow_memory && !disclose_never;

    let effective_workspace = open
        && switches.recall.workspace
        && rights.workspace
        && recall.and_then(|r| r.workspace).unwrap_or(true);
    let effective_user =
        open && switches.recall.user && rights.user && recall.and_then(|r| r.user).unwrap_or(true);
    let effective_agent_private = open
        && switches.recall.agent_private
        && rights.agent_private
        && recall.and_then(|r| r.agent_private).unwrap_or(true);

    let effective_capture = groups_allow_memory
        && switches.capture
        && principal.is_some_and(|p| can_capture(p, agent_id))
        && over.and_then(|o| o.capture).unwrap_or(true);

    Exposure {
        channel,
        agent_id: agent_id.to_owned(),
        switches,
        rights,
        recall: ScopeAccess {
            workspace: effective_workspace,
            user: effective_user,
            agent_private: effective_agent_private,
        },
        // A capture is attributed to a person; without one there is nothing to attribute it to.
        capture: effective_capture,
    }
}
