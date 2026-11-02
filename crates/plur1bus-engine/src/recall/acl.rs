//! Differentiated memory ACL.
//!
//! Ports `checkAccess`, `resolveOwnershipBindings`, `validateOwnershipTuple` and
//! `enforceDefaultScope` from `lib/acl-middleware.js`. A denial always reaches
//! [`DenialSink`]; the JSONL audit writer stays out.

use crate::{
    context::{
        canonical_stored_workspace, is_user_principal, normalize_aliases, safe_agent_id,
        validated_identity, RequestContext, WorkspaceAliases,
    },
    contract::{
        limits::{AGENT_ID, PRINCIPAL},
        MemoryRow,
    },
    text::js,
};

const CRITICAL_TYPES: &[&str] = &[
    "person",
    "beziehung",
    "geburtstag",
    "geld_konto",
    "gesundheit",
    "zugang_passwort",
];

/// Stable ACL reason. `name` is the Node `reason` string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rule(&'static str);

impl Rule {
    /// The Node reason, for example `acl.agent_private.mismatch`.
    #[must_use]
    pub const fn name(self) -> &'static str {
        self.0
    }
}

/// Receives every denial. RE-08 chooses the log level; the sink is always called.
pub trait DenialSink {
    /// Record one denied row.
    fn denied(&self, row_id: &str, rule: &'static str, ctx: &RequestContext);
}

/// Request side of an ACL check. `aliases == None` is a null snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AclSubject {
    /// Requesting agent id, before `safeAgentId`.
    pub agent_id: String,
    /// Canonical workspace identity. Empty when the request has none.
    pub workspace_identity: String,
    /// User principal as supplied, including surrounding whitespace.
    pub user_principal: String,
    /// Alias snapshot. `None` matches a null Node snapshot.
    pub aliases: Option<WorkspaceAliases>,
}

impl AclSubject {
    /// Subject carried by a built request context.
    #[must_use]
    pub fn from_context(ctx: &RequestContext) -> Self {
        Self {
            agent_id: ctx.agent_id.as_str().to_owned(),
            workspace_identity: ctx.workspace_key.clone(),
            user_principal: ctx.owner_user_id.clone(),
            aliases: Some(ctx.aliases().clone()),
        }
    }
}

/// Memory side of an ACL check. Only the ownership columns are read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AclMemory {
    /// Row id reported to the denial sink.
    pub id: String,
    /// Scope string. Empty defaults to `agent-private`.
    pub scope: String,
    /// Stored `agentId`.
    pub agent_id: String,
    /// Stored `storedBy`.
    pub stored_by: String,
    /// Stored `workspaceId`.
    pub workspace_id: String,
    /// Stored `workspaceKey`.
    pub workspace_key: String,
    /// Stored `ownerUserId`.
    pub owner_user_id: String,
    /// Memory type, used by [`enforce_default_scope`].
    pub type_name: String,
}

impl AclMemory {
    /// Read the ownership columns from a contract row.
    #[must_use]
    pub fn from_row(row: &MemoryRow) -> Option<Self> {
        let value = serde_json::to_value(row).ok()?;
        Some(Self {
            id: json_str(&value, "id"),
            scope: json_str(&value, "scope"),
            agent_id: json_str(&value, "agentId"),
            stored_by: json_str(&value, "storedBy"),
            workspace_id: json_str(&value, "workspaceId"),
            workspace_key: json_str(&value, "workspaceKey"),
            owner_user_id: json_str(&value, "ownerUserId"),
            type_name: json_str(&value, "type"),
        })
    }
}

/// Whether `ctx` may read `row`.
///
/// # Errors
///
/// Returns the denying [`Rule`]. Incognito is not a recall rule: the Node engine allows
/// an otherwise visible row.
pub fn allowed(row: &MemoryRow, ctx: &RequestContext) -> Result<(), Rule> {
    let Some(memory) = AclMemory::from_row(row) else {
        return deny("acl.no_memory");
    };
    check_access(Some(&AclSubject::from_context(ctx)), Some(&memory))
}

/// `checkAccess` over an optional subject and memory.
///
/// # Errors
///
/// Returns the denying [`Rule`]. `Ok(())` is Node's `allowed: true`.
pub fn check_access(ctx: Option<&AclSubject>, memory: Option<&AclMemory>) -> Result<(), Rule> {
    let Some(ctx) = ctx else {
        return deny("acl.no_context");
    };
    let Some(memory) = memory else {
        return deny("acl.no_memory");
    };
    let scope = if memory.scope.is_empty() {
        "agent-private"
    } else {
        memory.scope.as_str()
    };
    if !matches!(scope, "agent-private" | "workspace" | "user") {
        return deny("acl.unknown_scope");
    }
    let requester = requester_agent(&ctx.agent_id)?;
    let bindings = ownership(memory, ctx.aliases.as_ref())?;
    match scope {
        "agent-private" => agent_private(&requester, &bindings.agent_id),
        "workspace" => workspace_rule(&ctx.workspace_identity, &bindings.workspace_identity),
        _ => user_rule(&ctx.user_principal, &bindings.owner_user_id),
    }
}

/// Keep the rows `ctx` may read and report every denial.
pub fn retain_visible<'a, S: DenialSink + ?Sized>(
    rows: &'a [MemoryRow],
    ctx: &RequestContext,
    sink: &S,
) -> Vec<&'a MemoryRow> {
    let subject = AclSubject::from_context(ctx);
    let mut kept = Vec::new();
    for row in rows {
        let Some(memory) = AclMemory::from_row(row) else {
            sink.denied("", Rule("acl.no_memory").name(), ctx);
            continue;
        };
        match check_access(Some(&subject), Some(&memory)) {
            Ok(()) => kept.push(row),
            Err(rule) => sink.denied(&memory.id, rule.name(), ctx),
        }
    }
    kept
}

/// Default scope for a critical type when none is set.
///
/// A non-empty scope is kept. A non-critical type with an empty scope returns `None`,
/// which is Node's "leave the field unset".
#[must_use]
pub fn enforce_default_scope(scope: Option<&str>, type_name: &str) -> Option<String> {
    if let Some(scope) = scope.filter(|value| !value.is_empty()) {
        return Some(scope.to_owned());
    }
    CRITICAL_TYPES
        .contains(&type_name)
        .then(|| "agent-private".to_owned())
}

fn requester_agent(agent_id: &str) -> Result<String, Rule> {
    let validated = validated_identity(Some(agent_id), AGENT_ID, "agentId", true)
        .map_err(|_| Rule("acl.request.missing_agent"))?;
    safe_agent_id(&validated).map_err(|_| Rule("acl.request.missing_agent"))
}

struct Bindings {
    agent_id: String,
    workspace_identity: String,
    owner_user_id: String,
}

fn ownership(memory: &AclMemory, aliases: Option<&WorkspaceAliases>) -> Result<Bindings, Rule> {
    resolve_ownership(memory, aliases).map_err(|message| Rule(classify(&message)))
}

fn resolve_ownership(
    memory: &AclMemory,
    aliases: Option<&WorkspaceAliases>,
) -> Result<Bindings, String> {
    let agent_id = owned_agent(&memory.agent_id, "memory.agentId")?;
    let stored_by = owned_agent(&memory.stored_by, "memory.storedBy")?;
    if !agent_id.is_empty() && !stored_by.is_empty() && agent_id != stored_by {
        return Err("conflicting agent ownership binding".to_owned());
    }
    let (workspace_id, workspace_key) = stored_workspaces(memory, aliases)?;
    let owner_user_id = validated_identity(
        Some(&memory.owner_user_id),
        PRINCIPAL,
        "memory.ownerUserId",
        false,
    )?;
    if !owner_user_id.is_empty() && !is_user_principal(&owner_user_id) {
        return Err("invalid user ownership principal".to_owned());
    }
    Ok(Bindings {
        agent_id: if agent_id.is_empty() {
            stored_by
        } else {
            agent_id
        },
        workspace_identity: if workspace_id.is_empty() {
            workspace_key
        } else {
            workspace_id
        },
        owner_user_id,
    })
}

fn owned_agent(value: &str, name: &str) -> Result<String, String> {
    let validated = validated_identity(Some(value), AGENT_ID, name, false)?;
    if validated.is_empty() {
        Ok(String::new())
    } else {
        safe_agent_id(&validated)
    }
}

fn stored_workspaces(
    memory: &AclMemory,
    aliases: Option<&WorkspaceAliases>,
) -> Result<(String, String), String> {
    if memory.workspace_id.is_empty() && memory.workspace_key.is_empty() {
        return Ok((String::new(), String::new()));
    }
    let Some(aliases) = aliases else {
        return Err("invalid workspace alias snapshot".to_owned());
    };
    let snapshot = normalize_aliases(aliases)?;
    let workspace_id = canonical_stored_workspace(&memory.workspace_id, &snapshot)?;
    let workspace_key = canonical_stored_workspace(&memory.workspace_key, &snapshot)?;
    if !workspace_id.is_empty() && !workspace_key.is_empty() && workspace_id != workspace_key {
        return Err("conflicting workspace ownership binding".to_owned());
    }
    Ok((workspace_id, workspace_key))
}

fn classify(message: &str) -> &'static str {
    let workspace = message.contains("workspace");
    if workspace && message.contains("conflicting") {
        "acl.workspace.conflicting_binding"
    } else if workspace {
        "acl.workspace.invalid_binding"
    } else {
        "acl.invalid_binding"
    }
}

fn agent_private(requester: &str, owner: &str) -> Result<(), Rule> {
    if owner.is_empty() {
        return deny("acl.agent_private.missing_owner");
    }
    if requester == owner {
        Ok(())
    } else {
        deny("acl.agent_private.mismatch")
    }
}

fn workspace_rule(request: &str, memory: &str) -> Result<(), Rule> {
    if memory.is_empty() {
        return deny("acl.workspace.missing_workspace");
    }
    if !request.is_empty() && request == memory {
        Ok(())
    } else {
        deny("acl.workspace.mismatch")
    }
}

fn user_rule(principal: &str, owner: &str) -> Result<(), Rule> {
    let request = js::js_trim(principal);
    if !is_user_principal(request) {
        return deny("acl.user.missing_principal");
    }
    if owner.is_empty() {
        return deny("acl.user.missing_owner");
    }
    if request == owner {
        Ok(())
    } else {
        deny("acl.user.mismatch")
    }
}

fn deny(reason: &'static str) -> Result<(), Rule> {
    Err(Rule(reason))
}

fn json_str(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned()
}
