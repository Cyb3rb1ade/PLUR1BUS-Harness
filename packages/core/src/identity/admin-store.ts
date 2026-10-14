// Durable role presets and object rights. One synchronous writer; last-owner changes are checked inside BEGIN IMMEDIATE.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { platformCapabilities } from "../platform.ts";
import { RpcError } from "../rpc/errors.ts";
import { ROLES, type Role, type AgentRight, type Principal } from "../rbac/types.ts";
import { createLimiter, type LimitSpec } from "./ratelimit.ts";

/**
 * Failed redeems per connection and over every connection together; a lock refuses valid tokens too, so it leaks nothing.
 * A token carries 256 bits, so guessing is hopeless and the limits only cap noise. The overall limit is therefore loose and its
 * lock short: tight values would let anyone who can send failures lock every legitimate redeem out.
 */
const REDEEM_SOURCE_LIMIT: LimitSpec = { limit: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };
const REDEEM_GLOBAL_LIMIT: LimitSpec = { limit: 100, windowMs: 15 * 60_000, lockMs: 5 * 60_000 };
const REDEEM_GLOBAL_KEY = "invite-redeem:global";

export interface InviteRow { id: string; userId: string; role: Role; channel: string; expiresAt: number; revoked: number; createdAt: number; shareable: number; redeemedAt: number | null }
/** What `redeem` tells its audit hook. `reason` is for the privileged audit trail only; it never reaches the caller. */
export type RedeemOutcome = { ok: true; invite: InviteRow } | { ok: false; reason: "unknown" | "expired" | "revoked" | "redeemed" | "malformed" | "rate-limited"; inviteId?: string };

export class AdminStore {
  readonly db: DatabaseSync;
  constructor(o: { path: string; ownerId: string }) {
    if (o.path !== ":memory:") { mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 }); closeSync(openSync(o.path, "a", 0o600)); platformCapabilities.securePath(o.path); }
    this.db = new DatabaseSync(o.path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS admin_roles (user_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','member','viewer'))) STRICT;
      CREATE TABLE IF NOT EXISTS admin_rights (agent_id TEXT NOT NULL,user_id TEXT NOT NULL,right TEXT NOT NULL CHECK(right IN ('use','manage')),PRIMARY KEY(agent_id,user_id)) STRICT;
      CREATE TABLE IF NOT EXISTS admin_notices (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS admin_invites (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,role TEXT NOT NULL,channel TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL DEFAULT '',token_hash TEXT UNIQUE,redeemed_at INTEGER) STRICT;
      CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY,failures INTEGER NOT NULL,window_start INTEGER NOT NULL,locked_until INTEGER NOT NULL) STRICT;`);
    const columns = new Set(this.db.prepare("PRAGMA table_info(admin_roles)").all().map(r => r.name));
    for (const [name, type] of [["disabled", "INTEGER NOT NULL DEFAULT 0"], ["disabled_at", "INTEGER"], ["disabled_by", "TEXT"], ["version", "INTEGER NOT NULL DEFAULT 1"]])
      if (!columns.has(name)) this.db.exec(`ALTER TABLE admin_roles ADD COLUMN ${name} ${type}`);
    // Seed only an empty installation: demoting the bootstrap owner must survive a restart.
    if (Number((this.db.prepare("SELECT COUNT(*) AS n FROM admin_roles").get() as any).n) === 0)
      this.db.prepare("INSERT INTO admin_roles(user_id,role) VALUES (?, 'owner')").run(o.ownerId);
  }
  close() { this.db.close(); }
  role(id: string, fallback: Role = "member"): Role { return (this.db.prepare("SELECT role FROM admin_roles WHERE user_id=?").get(id) as { role: Role } | undefined)?.role ?? fallback; }
  users(): { id: string; role: Role; disabled: boolean; disabledAt: number | null; disabledBy: string | null; version: number }[] {
    return (this.db.prepare("SELECT user_id AS id, role, disabled, disabled_at AS disabledAt, disabled_by AS disabledBy, version FROM admin_roles ORDER BY user_id").all() as any[]).map(r => ({ ...r, disabled: r.disabled === 1 }));
  }
  person(id: string): (Principal & { disabled: boolean; version: number }) | null {
    const row = this.db.prepare("SELECT role,disabled,version FROM admin_roles WHERE user_id=?").get(id) as { role: Role; disabled: number; version: number } | undefined;
    return row ? { ...this.resolve({ kind: "person", userId: id, role: row.role }), disabled: row.disabled !== 0, version: row.version } : null;
  }
  resolvePerson(id: string): Principal | null { const p = this.person(id); return p && !p.disabled ? this.resolve({ kind: "person", userId: id, role: p.role }) : null; }
  setDisabled(id: string, disabled: boolean, by: string, now: number, beforeCommit: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.person(id);
      if (!row) throw new RpcError("E_NOT_FOUND", "person not found");
      if (disabled && !row.disabled && row.role === "owner" && Number((this.db.prepare("SELECT COUNT(*) AS n FROM admin_roles WHERE role='owner' AND disabled=0").get() as any).n) <= 1)
        throw new RpcError("E_CONFLICT", "the last active Owner cannot be disabled", { reason: "last-owner" });
      if (row.disabled !== disabled) {
        beforeCommit();
        this.db.prepare("UPDATE admin_roles SET disabled=?,disabled_at=?,disabled_by=?,version=version+1 WHERE user_id=?").run(disabled ? 1 : 0, disabled ? now : null, disabled ? by : null, id);
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  validateInvite(hash: string | null, now: number): InviteRow | undefined {
    if (!hash) return undefined;
    return this.db.prepare("SELECT id,user_id AS userId,role,channel,expires_at AS expiresAt,revoked,created_at AS createdAt,1 AS shareable,redeemed_at AS redeemedAt FROM admin_invites WHERE token_hash=? AND revoked=0 AND redeemed_at IS NULL AND expires_at>?").get(hash, now) as InviteRow | undefined;
  }
  setRole(id: string, role: Role, beforeCommit: () => void): void {
    if (!ROLES.includes(role)) throw new RpcError("E_INVALID_PARAMS", "unknown role preset");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.role(id) === "owner" && !this.person(id)?.disabled && role !== "owner" && Number((this.db.prepare("SELECT COUNT(*) AS n FROM admin_roles WHERE role='owner' AND disabled=0").get() as any).n) <= 1)
        throw new RpcError("E_CONFLICT", "the last Owner cannot be demoted", { reason: "last-owner" });
      beforeCommit();
      this.db.prepare("INSERT INTO admin_roles(user_id,role) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,version=version+1").run(id, role);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  rights(agentId: string): { userId: string; right: AgentRight }[] { return this.db.prepare("SELECT user_id AS userId,right FROM admin_rights WHERE agent_id=? ORDER BY user_id").all(agentId) as any[]; }
  setRight(agentId: string, userId: string, right: AgentRight | null) {
    if (right === null) this.db.prepare("DELETE FROM admin_rights WHERE agent_id=? AND user_id=?").run(agentId, userId);
    else { if (right !== "use" && right !== "manage") throw new RpcError("E_INVALID_PARAMS", "invalid agent right"); this.db.prepare("INSERT INTO admin_rights VALUES (?,?,?) ON CONFLICT(agent_id,user_id) DO UPDATE SET right=excluded.right").run(agentId, userId, right); }
    this.db.prepare("UPDATE admin_roles SET version=version+1 WHERE user_id=?").run(userId);
  }
  resolve(p: Principal): Principal {
    // Never turn an agent into a person or widen its role/scopes. Stored rights are authoritative once assigned.
    if (p.kind !== "person") return p;
    const role = this.role(p.userId, p.role);
    const rights = this.db.prepare("SELECT agent_id,right FROM admin_rights WHERE user_id=?").all(p.userId) as { agent_id: string; right: AgentRight }[];
    return { ...p, role, agentRights: Object.fromEntries(rights.map(r => [r.agent_id, r.right])) };
  }
  /** `tokenHash` is present for a shareable link and absent for a plain pairing-code invitation. Never the token itself. */
  invite(i: { id: string; userId: string; role: Role; channel: string; expiresAt: number; createdAt: number; createdBy: string; tokenHash?: string }) {
    this.db.prepare("INSERT INTO admin_invites(id,user_id,role,channel,expires_at,created_at,created_by,token_hash) VALUES (?,?,?,?,?,?,?,?)")
      .run(i.id, i.userId, i.role, i.channel, i.expiresAt, i.createdAt, i.createdBy, i.tokenHash ?? null);
  }
  notice(n: import("../rbac/break-glass.ts").BreakGlassNotice) { this.db.prepare("INSERT INTO admin_notices VALUES (?,?,?)").run(n.grantId, n.userId, JSON.stringify(n)); }
  notices(userId: string) { return this.db.prepare("SELECT payload FROM admin_notices WHERE user_id=? ORDER BY rowid DESC LIMIT 200").all(userId).map(r => JSON.parse(r.payload as string)); }
  allNotices(): import("../rbac/break-glass.ts").BreakGlassNotice[] { return this.db.prepare("SELECT payload FROM admin_notices ORDER BY rowid").all().map(r => JSON.parse(r.payload as string)); }
  invites(): InviteRow[] { return this.db.prepare("SELECT id,user_id AS userId,role,channel,expires_at AS expiresAt,revoked,created_at AS createdAt,token_hash IS NOT NULL AS shareable,redeemed_at AS redeemedAt FROM admin_invites ORDER BY expires_at,id").all() as any[]; }
  revoke(id: string) { this.db.prepare("UPDATE admin_invites SET revoked=1 WHERE id=?").run(id); }
  /**
   * Consumes a shareable invitation's one-time token. The whole decision is one transaction: a single guarded UPDATE
   * (unredeemed, unrevoked, unexpired) either takes the row or not, so two concurrent redeems cannot both win, and
   * `beforeCommit` (the audit write) failing rolls the consumption back. Every refusal is the same `{ ok: false }` to the
   * caller; the specific `reason` is for the audit trail only.
   */
  redeem(tokenHash: string | null, o: { now: number; source: string; beforeCommit: (invite: InviteRow) => void }): RedeemOutcome {
    const limiter = createLimiter(this.db, () => o.now);
    const srcKey = `invite-redeem:src:${o.source}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (limiter.lockedFor([srcKey, REDEEM_GLOBAL_KEY]) > 0) { this.db.exec("COMMIT"); return { ok: false, reason: "rate-limited" }; }
      const row = tokenHash === null ? undefined : this.db.prepare("SELECT id,user_id AS userId,role,channel,expires_at AS expiresAt,revoked,created_at AS createdAt,1 AS shareable,redeemed_at AS redeemedAt FROM admin_invites WHERE token_hash=?").get(tokenHash) as InviteRow | undefined;
      const taken = row ? this.db.prepare("UPDATE admin_invites SET redeemed_at=? WHERE id=? AND redeemed_at IS NULL AND revoked=0 AND expires_at>?").run(o.now, row.id, o.now) : undefined;
      if (row && taken && Number(taken.changes) === 1) {
        o.beforeCommit({ ...row, redeemedAt: o.now });
        limiter.success(srcKey);
        this.db.exec("COMMIT");
        return { ok: true, invite: { ...row, redeemedAt: o.now } };
      }
      limiter.failure(srcKey, REDEEM_SOURCE_LIMIT); limiter.failure(REDEEM_GLOBAL_KEY, REDEEM_GLOBAL_LIMIT);
      this.db.exec("COMMIT");
      const reason = tokenHash === null ? "malformed" : !row ? "unknown" : row.revoked ? "revoked" : row.redeemedAt !== null ? "redeemed" : "expired";
      return { ok: false, reason, ...(row ? { inviteId: row.id } : {}) };
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}
