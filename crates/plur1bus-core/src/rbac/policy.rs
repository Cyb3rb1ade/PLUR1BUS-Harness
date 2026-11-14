//! The RBAC policy as data (`rbac/policy.ts`, ADR-007 "Enforcement": one policy table, zero surface-specific policy code).
//! Deny by default: a role without an entry is denied. `own` is the principal's own resource, `object` an object right on
//! that agent or project (multiplicative with the role), `break-glass` a live grant covering the target user (read only).
//!
//! The table is written the way the TypeScript is (same helpers, same order of rows), and the parity vector `policy.json`
//! dumps every row of the TypeScript table, so a transcription error or a change on either side fails a test.
use super::types::{ActionSpec, AgentRight, Grant, Needs, ProjectRight, ResourceShape, Role};
use serde_json::{Map, Value};
use std::sync::OnceLock;

type Grants = Vec<(Role, Vec<Grant>)>;

const A: &[Grant] = &[Grant::Allow];
const O: &[Grant] = &[Grant::Own];
const U: &[Grant] = &[Grant::Object];
const OB: &[Grant] = &[Grant::Own, Grant::BreakGlass];

use Role::{Admin, Member, Operator, Owner, Viewer};

fn spec(
    action: &str,
    resource: ResourceShape,
    grants: &[(Role, &[Grant])],
    needs: Option<Needs>,
) -> ActionSpec {
    ActionSpec {
        action: action.to_owned(),
        resource,
        needs,
        human_only: false,
        grants: grants
            .iter()
            .map(|(r, g)| (*r, g.to_vec()))
            .collect::<Grants>(),
    }
}

/// D109 D6: an action no agent principal may ever hold, whatever role, right, token scope or break-glass grant it carries.
fn human_only(mut s: ActionSpec) -> ActionSpec {
    s.human_only = true;
    s
}

const OA: &[(Role, &[Grant])] = &[(Owner, A), (Admin, A)];
const READERS: &[(Role, &[Grant])] = &[(Owner, A), (Admin, A), (Operator, A), (Viewer, A)];
const ALL5: &[(Role, &[Grant])] = &[
    (Owner, A),
    (Admin, A),
    (Operator, A),
    (Member, A),
    (Viewer, A),
];
const NO_VIEWER: &[(Role, &[Grant])] = &[(Owner, A), (Admin, A), (Operator, A), (Member, A)];
const OWNER_ONLY: &[(Role, &[Grant])] = &[(Owner, A)];
const OAO: &[(Role, &[Grant])] = &[(Owner, A), (Admin, A), (Operator, A)];

use ResourceShape::{
    Agent, MemoryAgentPrivate, MemoryAgentWorkspace, MemoryUser, Project, System, User,
};

fn use_() -> Option<Needs> {
    Some(Needs::Agent(AgentRight::Use))
}
fn manage() -> Option<Needs> {
    Some(Needs::Agent(AgentRight::Manage))
}

/// ADR-004 "Models, Providers & logins, Channels, Plugins, MCP/ACP/A2A": Operator and Viewer read, Owner/Admin write.
fn catalogue(area: &str) -> Vec<ActionSpec> {
    vec![
        spec(&format!("{area}.read"), System, READERS, None),
        spec(&format!("{area}.write"), System, OA, None),
    ]
}

// One `push` per TypeScript row keeps the table reviewable line by line against `policy.ts`.
#[allow(clippy::vec_init_then_push)]
fn build() -> Vec<ActionSpec> {
    let mut p: Vec<ActionSpec> = Vec::new();
    p.push(human_only(spec(
        "a2a.peers.manage",
        System,
        OWNER_ONLY,
        None,
    )));
    p.push(spec("chat:read", System, ALL5, None));
    p.push(spec("chat:write", System, NO_VIEWER, None));
    p.push(spec("chat:delete", System, NO_VIEWER, None));
    // Personal inbox: every human role, own entries only.
    p.push(human_only(spec("inbox.read", System, ALL5, None)));
    p.push(human_only(spec("inbox.write", System, ALL5, None)));
    p.push(spec("project.board.read", System, ALL5, None));
    p.push(spec("project.board.move", System, NO_VIEWER, None));
    p.push(spec("project.board.comment", System, NO_VIEWER, None));
    p.push(human_only(spec(
        "project.board.write",
        System,
        NO_VIEWER,
        None,
    )));
    p.push(human_only(spec(
        "project.board.manage",
        System,
        NO_VIEWER,
        None,
    )));
    // Memory: `user` only for the owning user (others by break-glass, read only), `agent-private` only with `manage` on
    // that agent, the workspace scope with at least `use`.
    p.push(spec(
        "memory.user.read",
        MemoryUser,
        &[
            (Owner, OB),
            (Admin, OB),
            (Operator, O),
            (Member, O),
            (Viewer, O),
        ],
        None,
    ));
    p.push(spec(
        "memory.user.write",
        MemoryUser,
        &[(Owner, O), (Admin, O), (Operator, O), (Member, O)],
        None,
    ));
    p.push(spec(
        "memory.agent-private.read",
        MemoryAgentPrivate,
        &[(Owner, A), (Admin, A), (Member, U)],
        manage(),
    ));
    p.push(spec(
        "memory.agent-private.write",
        MemoryAgentPrivate,
        &[(Owner, A), (Admin, A), (Member, U)],
        manage(),
    ));
    p.push(spec(
        "memory.workspace.read",
        MemoryAgentWorkspace,
        &[
            (Owner, A),
            (Admin, A),
            (Operator, U),
            (Member, U),
            (Viewer, U),
        ],
        use_(),
    ));
    p.push(spec(
        "memory.workspace.write",
        MemoryAgentWorkspace,
        &[(Owner, A), (Admin, A), (Operator, U), (Member, U)],
        use_(),
    ));
    // RPC level: forgetting in an agent's store.
    p.push(spec(
        "memory.forget",
        Agent,
        &[(Owner, A), (Admin, A), (Operator, U), (Member, U)],
        use_(),
    ));
    // M6-A: Memory sensitivity mark/unmark/get.
    p.push(spec(
        "memory.sensitivity.read",
        Agent,
        &[
            (Owner, A),
            (Admin, A),
            (Operator, U),
            (Member, U),
            (Viewer, U),
        ],
        use_(),
    ));
    p.push(spec(
        "memory.sensitivity.write",
        Agent,
        &[(Owner, A), (Admin, A), (Operator, U), (Member, U)],
        manage(),
    ));

    // Agents.
    p.push(spec("agent.list", System, ALL5, None));
    p.push(spec(
        "agent.read",
        Agent,
        &[
            (Owner, A),
            (Admin, A),
            (Operator, A),
            (Member, U),
            (Viewer, U),
        ],
        use_(),
    ));
    p.push(spec(
        "agent.use",
        Agent,
        &[(Owner, A), (Admin, A), (Operator, U), (Member, U)],
        use_(),
    ));
    p.push(spec("agent.operate", Agent, OAO, None));
    p.push(spec(
        "agent.manage",
        Agent,
        &[(Owner, A), (Admin, A), (Member, U)],
        manage(),
    ));
    p.push(spec("agent.create", System, OA, None));
    p.push(spec("agent.delete", Agent, OA, None));

    // Operations pages.
    p.push(spec("dreaming.read", System, READERS, None));
    p.push(spec("dreaming.operate", System, OAO, None));
    p.push(spec("cron.read", System, READERS, None));
    p.push(spec("cron.operate", System, OAO, None));
    p.push(spec("jobs.run", System, OAO, None));
    p.push(spec("sessions.read", System, READERS, None));
    p.push(spec("logs.read", System, READERS, None));
    p.push(spec("audit.read", System, OA, None));
    // D4 logs.query / logs.tail: Owner/Admin only, narrower than `logs.read`.
    p.push(spec("logs.query", System, OA, None));

    for area in ["models", "providers", "channels", "plugins", "mcp"] {
        p.extend(catalogue(area));
    }
    // M v2 decision 2: extension inventory and changes are human Owner/Admin operations.
    p.push(human_only(spec("extensions.read", System, OA, None)));
    p.push(human_only(spec("extensions.manage", System, OA, None)));
    p.push(human_only(spec("imports.read", System, OA, None)));
    p.push(human_only(spec("imports.manage", System, OA, None)));

    // Users & roles, break-glass, ownership.
    p.push(spec("users.read", System, OA, None));
    p.push(spec("users.manage", System, OA, None));
    p.push(spec("users.delete", User, OWNER_ONLY, None));
    p.push(spec("ownership.transfer", System, OWNER_ONLY, None));
    p.push(spec("breakglass.request", User, OA, None));
    p.push(spec("breakglass.log.read", System, OA, None));
    p.push(spec("licence.confirm", System, OWNER_ONLY, None));

    // Surface gates.
    p.push(human_only(spec("media.read", System, ALL5, None)));
    p.push(human_only(spec("media.write", System, NO_VIEWER, None)));
    p.push(spec("media.index.read", System, ALL5, None));
    p.push(human_only(spec("media.index.operate", System, OA, None)));
    p.push(human_only(spec(
        "media.caption.write",
        System,
        NO_VIEWER,
        None,
    )));
    p.push(human_only(spec(
        "team.surface.read",
        System,
        NO_VIEWER,
        None,
    )));
    p.push(human_only(spec(
        "team.surface.write",
        System,
        NO_VIEWER,
        None,
    )));
    p.push(human_only(spec("project.surface.read", System, ALL5, None)));
    p.push(human_only(spec(
        "project.surface.write",
        System,
        NO_VIEWER,
        None,
    )));
    p.push(human_only(spec("project.create", System, OA, None)));
    p.push(human_only(spec("identity.self.read", System, ALL5, None)));
    p.push(human_only(spec(
        "identity.self.write",
        System,
        NO_VIEWER,
        None,
    )));
    // R2 provider login: ChatGPT-plan credentials are owner-only.
    p.push(human_only(spec(
        "auth.credentials.read",
        System,
        OWNER_ONLY,
        None,
    )));
    p.push(human_only(spec(
        "auth.credentials.write",
        System,
        OWNER_ONLY,
        None,
    )));

    // R3 channel management.
    p.push(human_only(spec("channel.read", System, OA, None)));
    p.push(human_only(spec("channel.write", System, OA, None)));

    // F39-F42/F44: admin backends, people only.
    p.push(human_only(spec("admin.agent.operate", Agent, OAO, None)));
    p.push(human_only(spec("admin.agent.manage", Agent, OA, None)));
    p.push(human_only(spec("admin.agent.delete", Agent, OA, None)));
    p.push(human_only(spec("admin.agent.rights", Agent, OA, None)));
    p.push(human_only(spec("admin.users.read", System, OA, None)));
    p.push(human_only(spec("admin.users.write", System, OA, None)));
    p.push(human_only(spec("admin.breakglass.read", System, OA, None)));
    p.push(human_only(spec("admin.breakglass.write", System, OA, None)));
    p.push(human_only(spec(
        "admin.sessions.write",
        System,
        NO_VIEWER,
        None,
    )));
    p.push(human_only(spec("admin.sessions.read", System, ALL5, None)));
    p.push(human_only(spec("admin.pairing.read", System, OA, None)));
    p.push(human_only(spec(
        "remote.device.write",
        System,
        NO_VIEWER,
        None,
    )));
    // F44: person/token gate; device-surface reads stored ownership for filtering/revoke/rename.
    for a in ["device.list", "device.revoke", "device.rename"] {
        p.push(human_only(spec(a, System, ALL5, None)));
    }

    p.push(human_only(spec("admin.notices.read", System, ALL5, None)));
    p.push(human_only(spec(
        "admin.sessions.transcript",
        System,
        ALL5,
        None,
    )));
    p.push(human_only(spec("admin.memory.read", System, ALL5, None)));

    // My area and projects.
    p.push(spec(
        "my.read",
        User,
        &[
            (Owner, O),
            (Admin, O),
            (Operator, O),
            (Member, O),
            (Viewer, O),
        ],
        None,
    ));
    p.push(spec(
        "my.write",
        User,
        &[(Owner, O), (Admin, O), (Operator, O), (Member, O)],
        None,
    ));
    p.push(spec("project.read", Project, ALL5, None));
    let member = Some(Needs::Project(ProjectRight::Member));
    let lead = Some(Needs::Project(ProjectRight::Lead));
    p.push(spec(
        "project.write",
        Project,
        &[(Owner, A), (Admin, A), (Operator, U), (Member, U)],
        member,
    ));
    p.push(spec(
        "project.manage",
        Project,
        &[(Owner, A), (Admin, A), (Operator, U), (Member, U)],
        lead,
    ));

    // Settings and secrets.
    p.push(spec("settings.read", System, OA, None));
    p.push(spec("settings.write", System, OA, None));
    p.push(spec("secrets.list", System, OA, None));
    p.push(spec("secrets.reveal", System, OWNER_ONLY, None));
    p.push(spec("secrets.write", System, OWNER_ONLY, None));

    // Outgoing network policy (B4).
    p.push(spec("egress.read", System, OA, None));

    // Import and Doctor.
    p.push(spec("import.run", System, OA, None));
    p.push(spec("doctor.read", System, OAO, None));
    p.push(spec("doctor.run", System, OAO, None));

    // D109 grants and approvals: people only.
    p.push(human_only(spec("grant.read", System, OA, None)));
    p.push(human_only(spec("grant.write", System, OA, None)));
    p.push(human_only(spec("approval.read", System, OAO, None)));
    p.push(human_only(spec("approval.decide", System, OA, None)));

    // The RPC `admin.*` family (obsidian, migrate, embedding): CLI-only for people, Owner/Admin.
    for a in [
        "admin.obsidian.detect",
        "admin.obsidian.prepare",
        "admin.obsidian.confirm",
        "admin.migrate",
        "admin.embedding.probe",
        "admin.embedding.serve",
        "admin.embedding.check",
        "admin.reembed.plan",
        "admin.reembed.run",
        "admin.reembed.status",
        "admin.reembed.abort",
        "admin.backup.snapshot",
    ] {
        p.push(spec(a, System, OA, None));
    }
    p
}

/// `POLICY`: every row, in the order of the TypeScript table.
pub fn policy() -> &'static [ActionSpec] {
    static TABLE: OnceLock<Vec<ActionSpec>> = OnceLock::new();
    TABLE.get_or_init(build)
}

/// `policyFor` for a string action: the row, or `None` for an action the table does not name (including `__proto__`,
/// `constructor`, the empty string and anything with different case or padding).
pub fn policy_for(action: &str) -> Option<&'static ActionSpec> {
    policy().iter().find(|s| s.action == action)
}

/// One row as the parity vectors dump it (`{action, resource, needs?, humanOnly?, grants: {role: [grant...]}}`).
pub fn spec_to_json(s: &ActionSpec) -> Value {
    let mut m = Map::new();
    m.insert("action".into(), Value::String(s.action.clone()));
    m.insert("resource".into(), Value::String(s.resource.as_str().into()));
    if let Some(n) = s.needs {
        m.insert("needs".into(), Value::String(n.as_str().into()));
    }
    if s.human_only {
        m.insert("humanOnly".into(), Value::Bool(true));
    }
    let mut g = Map::new();
    for (role, grants) in &s.grants {
        g.insert(
            role.as_str().into(),
            Value::Array(
                grants
                    .iter()
                    .map(|x| Value::String(x.as_str().into()))
                    .collect(),
            ),
        );
    }
    m.insert("grants".into(), Value::Object(g));
    Value::Object(m)
}
