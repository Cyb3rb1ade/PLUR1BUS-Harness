//! The RBAC types (`rbac/types.ts`). Strings are the wire names of the TypeScript unions.
/// The five roles, in the order of `ROLES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Role {
    /// `owner`
    Owner,
    /// `admin`
    Admin,
    /// `operator`
    Operator,
    /// `member`
    Member,
    /// `viewer`
    Viewer,
}

/// `ROLES`.
pub const ROLES: [Role; 5] = [
    Role::Owner,
    Role::Admin,
    Role::Operator,
    Role::Member,
    Role::Viewer,
];

impl Role {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Admin => "admin",
            Role::Operator => "operator",
            Role::Member => "member",
            Role::Viewer => "viewer",
        }
    }
    /// The role named exactly `s` (no trimming, no case folding), as `ROLE_SET.has` does.
    pub fn parse(s: &str) -> Option<Role> {
        ROLES.into_iter().find(|r| r.as_str() == s)
    }
}

/// A right on one agent: `use` < `manage`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentRight {
    /// `use`
    Use,
    /// `manage`
    Manage,
}

impl AgentRight {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentRight::Use => "use",
            AgentRight::Manage => "manage",
        }
    }
}

/// A right on one project: `member` (= `worker` = `reviewer`) < `lead`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectRight {
    /// `member`
    Member,
    /// `lead`
    Lead,
    /// `worker`
    Worker,
    /// `reviewer`
    Reviewer,
}

impl ProjectRight {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectRight::Member => "member",
            ProjectRight::Lead => "lead",
            ProjectRight::Worker => "worker",
            ProjectRight::Reviewer => "reviewer",
        }
    }
}

/// What an `object` grant needs on the agent or project (`ActionSpec.needs`, a string in TypeScript that may name a right of
/// either family).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Needs {
    /// An agent right.
    Agent(AgentRight),
    /// A project right.
    Project(ProjectRight),
}

impl Needs {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Needs::Agent(r) => r.as_str(),
            Needs::Project(r) => r.as_str(),
        }
    }
}

/// A live break-glass grant (`BreakGlassGrant`). The numbers are epoch ms.
#[derive(Clone, Debug, PartialEq)]
pub struct BreakGlassGrant {
    /// The grant id (returned in the decision).
    pub id: String,
    /// The holder; the grant counts only for a principal with this user id.
    pub holder_user_id: String,
    /// The user whose `user`-scope cards the holder may read.
    pub target_user_id: String,
    /// The reason given at the request.
    pub reason: String,
    /// First millisecond the grant is live.
    pub issued_at: f64,
    /// First millisecond the grant is no longer live.
    pub expires_at: f64,
    /// Set when the grant was revoked (any value, even 0, revokes it).
    pub revoked_at: Option<f64>,
}

/// Who is calling: a person or an agent acting through a tool, MCP, ACP or A2A path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrincipalKind {
    /// `person`
    Person,
    /// `agent`
    Agent,
}

impl PrincipalKind {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            PrincipalKind::Person => "person",
            PrincipalKind::Agent => "agent",
        }
    }
    /// The kind named exactly `s`, as `KIND_SET.has` does.
    pub fn parse(s: &str) -> Option<PrincipalKind> {
        [PrincipalKind::Person, PrincipalKind::Agent]
            .into_iter()
            .find(|k| k.as_str() == s)
    }
}

/// `PRINCIPAL_KINDS`.
pub const PRINCIPAL_KINDS: [PrincipalKind; 2] = [PrincipalKind::Person, PrincipalKind::Agent];

/// A well-formed RBAC principal. Input that is not (a role that is not one of the five, a user id that is not a string,
/// rights tables of the wrong type) cannot be built here: it goes through [`super::authorize::authorize_js`], which gives it
/// the decision (or the throw) TypeScript gives it.
#[derive(Clone, Debug, PartialEq)]
pub struct Principal {
    /// The opaque harness user id; empty is an invalid principal.
    pub user_id: String,
    /// Only the resolver that authenticated a *person* sets `Person`; `None` counts as not-a-person for `humanOnly`.
    pub kind: Option<PrincipalKind>,
    /// The role.
    pub role: Role,
    /// Rights on agents by agent id.
    pub agent_rights: Option<Vec<(String, AgentRight)>>,
    /// Rights on projects by project id.
    pub project_rights: Option<Vec<(String, ProjectRight)>>,
    /// API-token scopes: exact action names or `prefix.*`. `None` is a session (no narrowing).
    pub token_scopes: Option<Vec<String>>,
    /// Live and past break-glass grants of this holder.
    pub break_glass: Option<Vec<BreakGlassGrant>>,
}

impl Principal {
    /// A principal with only the required members.
    pub fn new(user_id: impl Into<String>, role: Role) -> Principal {
        Principal {
            user_id: user_id.into(),
            kind: None,
            role,
            agent_rights: None,
            project_rights: None,
            token_scopes: None,
            break_glass: None,
        }
    }
}

/// The agent-scoped memory scopes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryAgentScope {
    /// `agent-private`
    AgentPrivate,
    /// `workspace`
    Workspace,
}

impl MemoryAgentScope {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryAgentScope::AgentPrivate => "agent-private",
            MemoryAgentScope::Workspace => "workspace",
        }
    }
}

/// What an action is asked about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resource {
    /// The installation itself.
    System,
    /// A user.
    User {
        /// The user id.
        user_id: String,
    },
    /// An agent.
    Agent {
        /// The agent id.
        agent_id: String,
    },
    /// A project.
    Project {
        /// The project id.
        project_id: String,
    },
    /// The `user`-scope cards of one user.
    MemoryUser {
        /// The owning user.
        owner_user_id: String,
    },
    /// An agent-scoped memory store.
    MemoryAgent {
        /// The scope.
        scope: MemoryAgentScope,
        /// The agent id.
        agent_id: String,
    },
}

/// What an action's resource must look like (`ResourceShape`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResourceShape {
    /// `system`
    System,
    /// `user`
    User,
    /// `agent`
    Agent,
    /// `project`
    Project,
    /// `memory-user`
    MemoryUser,
    /// `memory-agent:agent-private`
    MemoryAgentPrivate,
    /// `memory-agent:workspace`
    MemoryAgentWorkspace,
}

impl ResourceShape {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            ResourceShape::System => "system",
            ResourceShape::User => "user",
            ResourceShape::Agent => "agent",
            ResourceShape::Project => "project",
            ResourceShape::MemoryUser => "memory-user",
            ResourceShape::MemoryAgentPrivate => "memory-agent:agent-private",
            ResourceShape::MemoryAgentWorkspace => "memory-agent:workspace",
        }
    }
}

/// How a role may satisfy an action; a role may list several and the first that holds wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grant {
    /// `allow`
    Allow,
    /// `own`
    Own,
    /// `object`
    Object,
    /// `break-glass`
    BreakGlass,
}

impl Grant {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Grant::Allow => "allow",
            Grant::Own => "own",
            Grant::Object => "object",
            Grant::BreakGlass => "break-glass",
        }
    }
}

/// One row of the policy table (`ActionSpec`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionSpec {
    /// The action name.
    pub action: String,
    /// The resource shape the action accepts.
    pub resource: ResourceShape,
    /// The right `object` grants need.
    pub needs: Option<Needs>,
    /// D109 D6: only a principal of kind `person` may hold it.
    pub human_only: bool,
    /// The grants by role; a role without an entry is denied.
    pub grants: Vec<(Role, Vec<Grant>)>,
}

impl ActionSpec {
    /// The grants of `role` (`Object.hasOwn(spec.grants, role) ? spec.grants[role] : []`).
    pub fn grants_of(&self, role: Role) -> &[Grant] {
        self.grants
            .iter()
            .find(|(r, _)| *r == role)
            .map_or(&[], |(_, g)| g.as_slice())
    }
}

/// Why a decision allows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AllowReason {
    /// `role`
    Role,
    /// `own`
    Own,
    /// `object-right`
    ObjectRight,
    /// `break-glass`
    BreakGlass,
}

impl AllowReason {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            AllowReason::Role => "role",
            AllowReason::Own => "own",
            AllowReason::ObjectRight => "object-right",
            AllowReason::BreakGlass => "break-glass",
        }
    }
}

/// Why a decision denies. `AuditFailed` is produced by the guard (T6), never by `authorize`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DenyReason {
    /// `unauthenticated`
    Unauthenticated,
    /// `invalid-principal`
    InvalidPrincipal,
    /// `unknown-action`
    UnknownAction,
    /// `resource-mismatch`
    ResourceMismatch,
    /// `token-scope`
    TokenScope,
    /// `role-denied`
    RoleDenied,
    /// `not-owner`
    NotOwner,
    /// `object-right-required`
    ObjectRightRequired,
    /// `break-glass-required`
    BreakGlassRequired,
    /// `audit-failed`
    AuditFailed,
    /// `agent-principal`
    AgentPrincipal,
}

impl DenyReason {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            DenyReason::Unauthenticated => "unauthenticated",
            DenyReason::InvalidPrincipal => "invalid-principal",
            DenyReason::UnknownAction => "unknown-action",
            DenyReason::ResourceMismatch => "resource-mismatch",
            DenyReason::TokenScope => "token-scope",
            DenyReason::RoleDenied => "role-denied",
            DenyReason::NotOwner => "not-owner",
            DenyReason::ObjectRightRequired => "object-right-required",
            DenyReason::BreakGlassRequired => "break-glass-required",
            DenyReason::AuditFailed => "audit-failed",
            DenyReason::AgentPrincipal => "agent-principal",
        }
    }
}

/// The outcome of `authorize`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Allowed.
    Allow {
        /// Why.
        reason: AllowReason,
        /// The break-glass grant that allowed it (only with `AllowReason::BreakGlass`).
        break_glass_id: Option<String>,
    },
    /// Denied.
    Deny {
        /// Why.
        reason: DenyReason,
    },
}

impl Decision {
    /// Whether the effect is `allow`.
    pub fn is_allow(&self) -> bool {
        matches!(self, Decision::Allow { .. })
    }
}

/// `AuthorizeContext`: `authorize` never reads a clock.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AuthorizeContext {
    /// Epoch ms. `None`, or a value that is not finite, means no break-glass grant is honoured.
    pub now: Option<f64>,
}
