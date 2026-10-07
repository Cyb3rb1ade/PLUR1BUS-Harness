// The RBAC policy as data (ADR-007 "Enforcement": one policy table, zero surface-specific policy code). Deny by
// default: a role without an entry is denied. `own` = the principal's own resource, `object` = an object right on
// that agent/project (multiplicative with the role: a role without an entry is denied whatever rights it holds),
// `break-glass` = a live grant covering the target user (read only, see break-glass.ts).
import type { ActionSpec, Grant, ResourceShape, Role } from "./types.ts";

type G = readonly Grant[];
const A: G = ["allow"];
const O: G = ["own"];
const U: G = ["object"];
const OB: G = ["own", "break-glass"];

function spec(action: string, resource: ResourceShape, grants: Partial<Record<Role, G>>, needs?: ActionSpec["needs"]): ActionSpec {
  return { action, resource, ...(needs ? { needs } : {}), grants };
}
/** D109 D6: an action no agent principal may ever hold, whatever role, right, token scope or break-glass grant it carries. */
const humanOnly = (s: ActionSpec): ActionSpec => ({ ...s, humanOnly: true });
const OA = { owner: A, admin: A } as const; // owner and admin only
const READERS = { owner: A, admin: A, operator: A, viewer: A } as const; // ADR-004 "read" on the operations/catalogue pages

/** ADR-004 "Models, Providers & logins, Channels, Plugins, MCP/ACP/A2A": Operator and Viewer read, Owner/Admin write. */
const catalogue = (area: string): ActionSpec[] => [
  spec(`${area}.read`, "system", READERS),
  spec(`${area}.write`, "system", OA),
];

export const POLICY: readonly ActionSpec[] = Object.freeze([
  // Memory — scopes follow ADR-007 "Privacy": `user` only for the owning user (others by break-glass, read only),
  // `agent-private` only with `manage` on that agent, the workspace scope with at least `use`.
  spec("memory.user.read", "memory-user", { owner: OB, admin: OB, operator: O, member: O, viewer: O }),
  spec("memory.user.write", "memory-user", { owner: O, admin: O, operator: O, member: O }),
  spec("memory.agent-private.read", "memory-agent:agent-private", { owner: A, admin: A, member: U }, "manage"),
  spec("memory.agent-private.write", "memory-agent:agent-private", { owner: A, admin: A, member: U }, "manage"),
  spec("memory.workspace.read", "memory-agent:workspace", { owner: A, admin: A, operator: U, member: U, viewer: U }, "use"),
  spec("memory.workspace.write", "memory-agent:workspace", { owner: A, admin: A, operator: U, member: U }, "use"),
  // RPC level: forgetting in an agent's store (the engine's own ACL still decides which cards, per principal).
  spec("memory.forget", "agent", { owner: A, admin: A, operator: U, member: U }, "use"),

  // Agents. Operator may read and run/pause (ADR-007 role summary) but uses one only through a `use` right.
  spec("agent.list", "system", { owner: A, admin: A, operator: A, member: A, viewer: A }), // callers filter with `canSee`
  spec("agent.read", "agent", { owner: A, admin: A, operator: A, member: U, viewer: U }, "use"),
  spec("agent.use", "agent", { owner: A, admin: A, operator: U, member: U }, "use"),
  spec("agent.operate", "agent", { owner: A, admin: A, operator: A }),
  spec("agent.manage", "agent", { owner: A, admin: A, member: U }, "manage"),
  spec("agent.create", "system", OA),
  spec("agent.delete", "agent", OA),

  // Operations pages (Dreaming, Cron, Sessions/Logs): Owner/Admin/Operator, Viewer reads.
  spec("dreaming.read", "system", READERS),
  spec("dreaming.operate", "system", { owner: A, admin: A, operator: A }),
  spec("cron.read", "system", READERS),
  spec("cron.operate", "system", { owner: A, admin: A, operator: A }),
  spec("jobs.run", "system", { owner: A, admin: A, operator: A }),
  spec("sessions.read", "system", READERS),
  spec("logs.read", "system", READERS),
  spec("audit.read", "system", OA),
  // D4 logs.query / logs.tail: the protected log files (diagnostic and audit stream) are Owner/Admin only, narrower than `logs.read` (RULING).
  spec("logs.query", "system", OA),

  ...["models", "providers", "channels", "plugins", "mcp"].flatMap(catalogue),

  // Users & roles, break-glass, ownership.
  spec("users.read", "system", OA),
  spec("users.manage", "system", OA),
  spec("users.delete", "user", { owner: A }),
  spec("ownership.transfer", "system", { owner: A }),
  spec("breakglass.request", "user", OA),
  spec("breakglass.log.read", "system", OA),
  spec("licence.confirm", "system", { owner: A }),

  // My area and projects.
  spec("my.read", "user", { owner: O, admin: O, operator: O, member: O, viewer: O }),
  spec("my.write", "user", { owner: O, admin: O, operator: O, member: O }),
  spec("project.read", "project", { owner: A, admin: A, operator: A, member: A, viewer: A }),
  spec("project.write", "project", { owner: A, admin: A, operator: U, member: U }, "member"),
  spec("project.manage", "project", { owner: A, admin: A, operator: U, member: U }, "lead"),

  // Settings and secrets: Admin has no secret reveal (ADR-004), nor write (ADR-007: no secret values).
  spec("settings.read", "system", OA),
  spec("settings.write", "system", OA),
  spec("secrets.list", "system", OA),
  spec("secrets.reveal", "system", { owner: A }),
  spec("secrets.write", "system", { owner: A }),

  // Outgoing network policy (B4): who may read it. Owner/Admin, like the other settings.
  spec("egress.read", "system", OA),

  // Import and Doctor: Operator gets Doctor only.
  spec("import.run", "system", OA),
  spec("doctor.read", "system", { owner: A, admin: A, operator: A }),
  spec("doctor.run", "system", { owner: A, admin: A, operator: A }),

  // D109 grants and approvals (spec 2026-09-28 §4): people only (`humanOnly`). Owner/Admin change and decide; Operator may read the queue and verify the chain.
  humanOnly(spec("grant.read", "system", OA)),
  humanOnly(spec("grant.write", "system", OA)),
  humanOnly(spec("approval.read", "system", { owner: A, admin: A, operator: A })),
  humanOnly(spec("approval.decide", "system", OA)),

  // The RPC `admin.*` family (obsidian, migrate, embedding): CLI-only for people, Owner/Admin.
  ...["admin.obsidian.detect", "admin.obsidian.prepare", "admin.obsidian.confirm", "admin.migrate", "admin.embedding.probe", "admin.embedding.serve",
   "admin.reembed.plan", "admin.reembed.run", "admin.reembed.status", "admin.reembed.abort", "admin.backup.snapshot"]
    .map((a) => spec(a, "system", OA)),
]);

const BY_ACTION: ReadonlyMap<string, ActionSpec> = new Map(POLICY.map((s) => [s.action, s]));
export const policyFor = (action: unknown): ActionSpec | undefined => (typeof action === "string" ? BY_ACTION.get(action) : undefined);
