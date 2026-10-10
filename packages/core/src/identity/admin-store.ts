// Durable role presets and object rights. One synchronous writer; last-owner changes are checked inside BEGIN IMMEDIATE.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { platformCapabilities } from "../platform.ts";
import { RpcError } from "../rpc/errors.ts";
import { ROLES, type Role, type AgentRight, type Principal } from "../rbac/types.ts";

export class AdminStore {
  readonly db: DatabaseSync;
  constructor(o: { path: string; ownerId: string }) {
    if (o.path !== ":memory:") { mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 }); closeSync(openSync(o.path, "a", 0o600)); platformCapabilities.securePath(o.path); }
    this.db = new DatabaseSync(o.path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS admin_roles (user_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','member','viewer'))) STRICT;
      CREATE TABLE IF NOT EXISTS admin_rights (agent_id TEXT NOT NULL,user_id TEXT NOT NULL,right TEXT NOT NULL CHECK(right IN ('use','manage')),PRIMARY KEY(agent_id,user_id)) STRICT;
      CREATE TABLE IF NOT EXISTS admin_notices (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,payload TEXT NOT NULL) STRICT;
      CREATE TEMP TABLE admin_invites (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,role TEXT NOT NULL,channel TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0) STRICT;`);
    // Seed only an empty installation: demoting the bootstrap owner must survive a restart.
    if (Number((this.db.prepare("SELECT COUNT(*) AS n FROM admin_roles").get() as any).n) === 0)
      this.db.prepare("INSERT INTO admin_roles VALUES (?, 'owner')").run(o.ownerId);
  }
  close() { this.db.close(); }
  role(id: string, fallback: Role = "member"): Role { return (this.db.prepare("SELECT role FROM admin_roles WHERE user_id=?").get(id) as { role: Role } | undefined)?.role ?? fallback; }
  users(): { id: string; role: Role }[] { return (this.db.prepare("SELECT user_id AS id, role FROM admin_roles ORDER BY user_id").all() as any[]); }
  setRole(id: string, role: Role, beforeCommit: () => void): void {
    if (!ROLES.includes(role)) throw new RpcError("E_INVALID_PARAMS", "unknown role preset");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.role(id) === "owner" && role !== "owner" && Number((this.db.prepare("SELECT COUNT(*) AS n FROM admin_roles WHERE role='owner'").get() as any).n) <= 1)
        throw new RpcError("E_CONFLICT", "the last Owner cannot be demoted", { reason: "last-owner" });
      beforeCommit();
      this.db.prepare("INSERT INTO admin_roles VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role").run(id, role);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  rights(agentId: string): { userId: string; right: AgentRight }[] { return this.db.prepare("SELECT user_id AS userId,right FROM admin_rights WHERE agent_id=? ORDER BY user_id").all(agentId) as any[]; }
  setRight(agentId: string, userId: string, right: AgentRight | null) {
    if (right === null) this.db.prepare("DELETE FROM admin_rights WHERE agent_id=? AND user_id=?").run(agentId, userId);
    else { if (right !== "use" && right !== "manage") throw new RpcError("E_INVALID_PARAMS", "invalid agent right"); this.db.prepare("INSERT INTO admin_rights VALUES (?,?,?) ON CONFLICT(agent_id,user_id) DO UPDATE SET right=excluded.right").run(agentId, userId, right); }
  }
  resolve(p: Principal): Principal {
    // Never turn an agent into a person or widen its role/scopes. Stored rights are authoritative once assigned.
    if (p.kind !== "person") return p;
    const role = this.role(p.userId, p.role);
    const rights = this.db.prepare("SELECT agent_id,right FROM admin_rights WHERE user_id=?").all(p.userId) as { agent_id: string; right: AgentRight }[];
    return { ...p, role, agentRights: Object.fromEntries(rights.map(r => [r.agent_id, r.right])) };
  }
  invite(i: { id: string; userId: string; role: Role; channel: string; expiresAt: number }) { this.db.prepare("INSERT INTO admin_invites(id,user_id,role,channel,expires_at) VALUES (?,?,?,?,?)").run(i.id, i.userId, i.role, i.channel, i.expiresAt); }
  notice(n: import("../rbac/break-glass.ts").BreakGlassNotice) { this.db.prepare("INSERT INTO admin_notices VALUES (?,?,?)").run(n.grantId, n.userId, JSON.stringify(n)); }
  notices(userId: string) { return this.db.prepare("SELECT payload FROM admin_notices WHERE user_id=? ORDER BY rowid DESC LIMIT 200").all(userId).map(r => JSON.parse(r.payload as string)); }
  invites(): { id: string; userId: string; role: Role; channel: string; expiresAt: number; revoked: number }[] { return this.db.prepare("SELECT id,user_id AS userId,role,channel,expires_at AS expiresAt,revoked FROM admin_invites ORDER BY expires_at,id").all() as any[]; }
  revoke(id: string) { this.db.prepare("UPDATE admin_invites SET revoked=1 WHERE id=?").run(id); }
}
