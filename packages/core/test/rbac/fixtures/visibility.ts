// The expected matrix, written down independently of src/rbac/policy.ts from the documents:
//   ADR-004 §"Pages" "Visibility by role" (PAGES below, cell for cell), and
//   ADR-007 §"Roles" / §"Privacy" for what ADR-004's page rows do not split (the `Extra` entries).
// The matrix test fails when a policy action is missing here, when this lists an action the policy lacks, and when
// any role × action cell differs.
import type { Role } from "../../../src/rbac/types.ts";

export const ORDER: readonly Role[] = ["owner", "admin", "operator", "member", "viewer"];

/** ADR-004 cells. "yes" = ✔, "read" = ✔ (read) / read, "none" = –, plus the page-specific ones. */
export type Cell = "yes" | "read" | "none" | "use-only" | "doctor-only" | "no-secret-reveal";
export type Verb = "read" | "write" | "operate" | "crud" | "use" | "doctor" | "reveal" | "import";

const cells = (owner: Cell, admin: Cell, operator: Cell, member: Cell, viewer: Cell): Record<Role, Cell> => ({ owner, admin, operator, member, viewer });

/** One row of the ADR-004 "Visibility by role" table (the quoted page-group text is the key). */
export const PAGES = {
  "Memory (own user scope)": cells("yes", "yes", "yes", "yes", "read"),
  "Dreaming, Cron, Sessions/Logs": cells("yes", "yes", "yes", "none", "read"),
  "Models, Providers & logins, Channels, Plugins, MCP/ACP/A2A": cells("yes", "yes", "read", "none", "read"),
  "Agents CRUD": cells("yes", "yes", "none", "use-only", "read"),
  "Users & roles": cells("yes", "yes", "none", "none", "none"),
  "Settings / Secrets": cells("yes", "no-secret-reveal", "none", "none", "none"),
  "Import, Doctor": cells("yes", "yes", "doctor-only", "none", "none"),
  "My area, Projects": cells("yes", "yes", "yes", "yes", "read"),
} as const;
export type Page = keyof typeof PAGES;

/** Does the ADR-004 cell let the role perform `verb` at all? */
export function cellAllows(cell: Cell, verb: Verb): boolean {
  switch (cell) {
    case "yes": return true;
    case "read": return verb === "read";
    case "none": return false;
    case "use-only": return verb === "use" || verb === "read";
    case "doctor-only": return verb === "doctor";
    case "no-secret-reveal": return verb !== "reveal";
  }
}

/** What a role needs beyond the role itself: `O` own resource, `U`/`M` use/manage right, `P`/`L` project member/lead. */
export type Gate = "O" | "U" | "M" | "P" | "L" | "OB";
export interface Entry { action: string; page: Page; verb: Verb; gate?: Partial<Record<Role, Gate>>; cells?: Partial<Record<Role, Cell>> }

const ALL_O: Partial<Record<Role, Gate>> = { owner: "O", admin: "O", operator: "O", member: "O", viewer: "O" };
const catalogue = (area: string): Entry[] => [
  { action: `${area}.read`, page: "Models, Providers & logins, Channels, Plugins, MCP/ACP/A2A", verb: "read" },
  { action: `${area}.write`, page: "Models, Providers & logins, Channels, Plugins, MCP/ACP/A2A", verb: "write" },
];
const owner = cells("yes", "none", "none", "none", "none"); // ADR-007 role table: owner-only capabilities
const ownerAdmin = cells("yes", "yes", "none", "none", "none");

export const ENTRIES: readonly Entry[] = [
  // Memory (own user scope) — and who may read another user's: break-glass for Owner/Admin only.
  { action: "memory.user.read", page: "Memory (own user scope)", verb: "read", gate: { ...ALL_O, owner: "OB", admin: "OB" } },
  { action: "memory.user.write", page: "Memory (own user scope)", verb: "write", gate: ALL_O },
  { action: "memory.forget", page: "Memory (own user scope)", verb: "write", gate: { operator: "U", member: "U" } },
  // ADR-007 §Privacy: agent-private only with `manage` on the agent (Owner/Admin hold it by role, R4); workspace needs `use`.
  { action: "memory.agent-private.read", page: "Agents CRUD", verb: "crud", cells: cells("yes", "yes", "none", "yes", "none"), gate: { member: "M" } },
  { action: "memory.agent-private.write", page: "Agents CRUD", verb: "crud", cells: cells("yes", "yes", "none", "yes", "none"), gate: { member: "M" } },
  { action: "memory.workspace.read", page: "Agents CRUD", verb: "read", cells: cells("yes", "yes", "yes", "yes", "yes"), gate: { operator: "U", member: "U", viewer: "U" } },
  { action: "memory.workspace.write", page: "Agents CRUD", verb: "write", cells: cells("yes", "yes", "yes", "yes", "none"), gate: { operator: "U", member: "U" } },

  // Agents: ADR-004 row "Agents CRUD" for create/update/delete; reads, use and run/pause from ADR-007 (R4, R5).
  { action: "agent.list", page: "Agents CRUD", verb: "read", cells: cells("yes", "yes", "yes", "yes", "yes") },
  { action: "agent.read", page: "Agents CRUD", verb: "read", cells: cells("yes", "yes", "yes", "use-only", "read"), gate: { member: "U", viewer: "U" } },
  { action: "agent.use", page: "Agents CRUD", verb: "use", cells: cells("yes", "yes", "yes", "use-only", "none"), gate: { operator: "U", member: "U" } },
  { action: "agent.operate", page: "Agents CRUD", verb: "operate", cells: cells("yes", "yes", "yes", "none", "none") },
  { action: "agent.manage", page: "Agents CRUD", verb: "crud", cells: cells("yes", "yes", "none", "yes", "none"), gate: { member: "M" } },
  { action: "agent.create", page: "Agents CRUD", verb: "crud" },
  { action: "agent.delete", page: "Agents CRUD", verb: "crud" },

  { action: "dreaming.read", page: "Dreaming, Cron, Sessions/Logs", verb: "read" },
  { action: "dreaming.operate", page: "Dreaming, Cron, Sessions/Logs", verb: "operate" },
  { action: "cron.read", page: "Dreaming, Cron, Sessions/Logs", verb: "read" },
  { action: "cron.operate", page: "Dreaming, Cron, Sessions/Logs", verb: "operate" },
  { action: "jobs.run", page: "Dreaming, Cron, Sessions/Logs", verb: "operate" },
  { action: "sessions.read", page: "Dreaming, Cron, Sessions/Logs", verb: "read" },
  { action: "logs.read", page: "Dreaming, Cron, Sessions/Logs", verb: "read" },
  { action: "audit.read", page: "Users & roles", verb: "read" }, // R7: audit trail with the users page, not the operator's logs
  { action: "logs.query", page: "Users & roles", verb: "read", cells: ownerAdmin }, // D4: logs.query/logs.tail, Owner/Admin only (narrower than logs.read)
  // D109 grants and approvals (spec 2026-09-28 §4): people only. Deciding and changing grants is Owner/Admin; Operator may read the queue and verify the chain.
  { action: "grant.read", page: "Users & roles", verb: "read", cells: ownerAdmin },
  { action: "grant.write", page: "Users & roles", verb: "write", cells: ownerAdmin },
  { action: "approval.read", page: "Users & roles", verb: "read", cells: cells("yes", "yes", "yes", "none", "none") },
  { action: "approval.decide", page: "Users & roles", verb: "write", cells: ownerAdmin },

  ...["models", "providers", "channels", "plugins", "mcp"].flatMap(catalogue),

  { action: "users.read", page: "Users & roles", verb: "read" },
  { action: "users.manage", page: "Users & roles", verb: "write" },
  { action: "users.delete", page: "Users & roles", verb: "write", cells: owner },
  { action: "ownership.transfer", page: "Users & roles", verb: "write", cells: owner },
  { action: "breakglass.request", page: "Users & roles", verb: "write" },
  { action: "breakglass.log.read", page: "Users & roles", verb: "read" },
  { action: "licence.confirm", page: "Settings / Secrets", verb: "write", cells: owner },

  { action: "media.read", page: "My area, Projects", verb: "read" },
  { action: "media.write", page: "My area, Projects", verb: "write" },
  { action: "project.surface.read", page: "My area, Projects", verb: "read" },
  { action: "project.surface.write", page: "My area, Projects", verb: "write" },
  { action: "project.create", page: "My area, Projects", verb: "write", cells: ownerAdmin },
  { action: "identity.self.read", page: "My area, Projects", verb: "read" },
  { action: "identity.self.write", page: "My area, Projects", verb: "write" },
  { action: "auth.credentials.read", page: "Models, Providers & logins, Channels, Plugins, MCP/ACP/A2A", verb: "read", cells: owner }, // R2: plan credentials are the installation owner's
  { action: "channel.read", page: "Models, Providers & logins, Channels, Plugins, MCP/ACP/A2A", verb: "read", cells: ownerAdmin }, // R3: channel.* RPC, people only
  { action: "channel.write", page: "Models, Providers & logins, Channels, Plugins, MCP/ACP/A2A", verb: "write", cells: ownerAdmin },
  { action: "auth.credentials.write", page: "Models, Providers & logins, Channels, Plugins, MCP/ACP/A2A", verb: "write", cells: owner },
  { action: "admin.agent.delete", page: "Users & roles", verb: "read", cells: ownerAdmin },
  { action: "admin.agent.manage", page: "Users & roles", verb: "read", cells: ownerAdmin },
  { action: "admin.agent.operate", page: "Users & roles", verb: "read", cells: cells("yes", "yes", "yes", "none", "none") },
  { action: "admin.agent.rights", page: "Users & roles", verb: "read", cells: ownerAdmin },
  { action: "admin.breakglass.read", page: "Users & roles", verb: "read", cells: ownerAdmin },
  { action: "admin.breakglass.write", page: "Users & roles", verb: "read", cells: ownerAdmin },
  { action: "admin.pairing.read", page: "Users & roles", verb: "read", cells: ownerAdmin },
  { action: "admin.sessions.write", page: "Users & roles", verb: "read", cells: cells("yes", "yes", "yes", "yes", "none") },
  { action: "admin.sessions.read", page: "Users & roles", verb: "read", cells: cells("yes", "yes", "yes", "yes", "yes") },
  { action: "admin.users.read", page: "Users & roles", verb: "read", cells: ownerAdmin },
  { action: "admin.users.write", page: "Users & roles", verb: "read", cells: ownerAdmin },
  { action: "admin.notices.read", page: "Users & roles", verb: "read", cells: cells("yes", "yes", "yes", "yes", "yes") },
  { action: "admin.sessions.transcript", page: "Users & roles", verb: "read", cells: cells("yes", "yes", "yes", "yes", "yes") },
  { action: "admin.memory.read", page: "Users & roles", verb: "read", cells: cells("yes", "yes", "yes", "yes", "yes") },
  { action: "my.read", page: "My area, Projects", verb: "read", gate: ALL_O },
  { action: "my.write", page: "My area, Projects", verb: "write", gate: { owner: "O", admin: "O", operator: "O", member: "O" } },
  { action: "project.read", page: "My area, Projects", verb: "read" },
  { action: "project.write", page: "My area, Projects", verb: "write", gate: { operator: "P", member: "P" } },
  { action: "project.manage", page: "My area, Projects", verb: "write", gate: { operator: "L", member: "L" } },

  { action: "settings.read", page: "Settings / Secrets", verb: "read", cells: ownerAdmin },
  { action: "settings.write", page: "Settings / Secrets", verb: "write", cells: ownerAdmin },
  { action: "egress.read", page: "Settings / Secrets", verb: "read", cells: ownerAdmin },
  { action: "secrets.list", page: "Settings / Secrets", verb: "read", cells: ownerAdmin },
  { action: "secrets.reveal", page: "Settings / Secrets", verb: "reveal", cells: owner }, // ADR-004 "no secret reveal" for Admin; ADR-007 Owner's secret store
  { action: "secrets.write", page: "Settings / Secrets", verb: "write", cells: owner }, // R6

  { action: "import.run", page: "Import, Doctor", verb: "import" },
  { action: "doctor.read", page: "Import, Doctor", verb: "doctor" },
  { action: "doctor.run", page: "Import, Doctor", verb: "doctor" },
  ...["admin.obsidian.detect", "admin.obsidian.prepare", "admin.obsidian.confirm", "admin.migrate", "admin.embedding.probe", "admin.embedding.serve",
   "admin.reembed.plan", "admin.reembed.run", "admin.reembed.status", "admin.reembed.abort", "admin.backup.snapshot"]
    .map((action): Entry => ({ action, page: "Import, Doctor", verb: "import" })),
];

/** The expectation for one role: "A" bare allow, "-" deny whatever else is supplied, else the gate that must be met. */
export function expectation(e: Entry, role: Role): "A" | "-" | Gate {
  const cell = (e.cells ?? PAGES[e.page])[role] as Cell;
  if (!cellAllows(cell, e.verb)) return "-";
  return e.gate?.[role] ?? "A";
}
