// D109 §4/§6: grants on the shared approvals database, resolved for `decide()` through `GrantSource`.
//
// Authority: the HMAC chain, not the table. A grant's definition is chained when it is created; revocation, end,
// consumption and use are chained when they happen. On every read the row is compared with its chain entries:
//  - a grant whose entry lies at or after the first broken chain position is suspended (fail closed, §6),
//  - a grant whose row no longer matches its chained definition is suspended,
//  - revoked / consumed in the chain wins over a row that says otherwise; `lastUsedAt` is taken from the chain only.
// `list`/`get` therefore never return a grant the chain does not vouch for.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ApprovalChain, ApprovalChainError, type ChainEntry } from "../approvals/chain.ts";
import { transaction } from "../approvals/db.ts";
import { CAPABILITIES, DEFAULTS, GRANT_SCOPES, scopeRank, type GrantScope, type SurfaceTrust } from "../policy/capabilities.ts";
import type { Clock, Grant, GrantMatch, GrantSource } from "../policy/decide.ts";
import type { PolicyAudit, PolicyAuditAction } from "../policy/audit.ts";
import { checkSyntax, isPathRefusal } from "../policy/paths-index.ts";

/** A use is chained at most this often per grant: `always` expiry (90 days) needs no finer granularity, the chain stays small. */
export const USE_RECORD_GRANULARITY_MS = 60 * 60_000;

export type GrantErrorCode = "invalid-grant" | "ceiling-exceeded" | "surface-too-low" | "never-capability" | "duplicate-id";
export class GrantError extends Error {
  readonly code: GrantErrorCode;
  constructor(code: GrantErrorCode, message: string) { super(message); this.name = "GrantError"; this.code = code; }
}

/** The policy `Grant` plus what the store records about its origin and end. */
export interface StoredGrant extends Grant {
  createdBy: string;
  /** The effect the grant was given for (documentation / listing; the policy decides on the capability). */
  effect?: string;
  revokedAt?: number;
  /** `revoked` | `task-ended` | `session-ended`. */
  endReason?: string;
}
export type GrantState = "active" | "revoked" | "consumed" | "suspended";

export interface CreateGrantInput {
  id?: string;
  capability: string;
  person: string;
  agent: string;
  /** Duration: once | task | session | always. */
  scope: GrantScope;
  match: GrantMatch;
  createdBy: string;
  surface: SurfaceTrust;
  effect?: string;
  expiresAt?: number;
  actionHash?: string;
  taskId?: string;
  sessionId?: string;
  projectId?: string;
  jobId?: string;
  delegable?: boolean;
  acknowledgedUnsandboxed?: boolean;
}

export interface GrantStoreOptions {
  db: DatabaseSync;
  chain: ApprovalChain;
  clock: Clock;
  /**
   * D109 §9: every grant change is written to the audit trail inside the same transaction as the change, so a line that cannot be
   * written rolls the change back (no grant exists, and no once grant is consumed, unrecorded). Revocation is the exception: it only
   * narrows, so a failing audit never blocks it.
   */
  audit?: PolicyAudit;
}

interface GrantRow {
  id: string; person: string; agent: string; capability: string; effect: string | null; match_kind: string; match_path: string | null;
  match_access: string | null; match_recursive: number | null; duration: string; created_by: string; created_at: number; expires_at: number | null;
  revoked_at: number | null; end_reason: string | null; last_used_at: number | null; consumed_at: number | null; action_hash: string | null;
  task_id: string | null; session_id: string | null; project_id: string | null; job_id: string | null; delegable: number; surface: number;
  acknowledged_unsandboxed: number; def_hash: string; chain_seq: number;
}

/** The immutable definition that is chained at creation. Fixed key order: it is compared as a string. */
function definitionOf(r: GrantRow): string {
  return JSON.stringify({
    id: r.id, person: r.person, agent: r.agent, capability: r.capability, effect: r.effect, scope: r.duration,
    match: { kind: r.match_kind, path: r.match_path, access: r.match_access, recursive: r.match_recursive === null ? null : r.match_recursive === 1 },
    createdBy: r.created_by, createdAt: Number(r.created_at), expiresAt: r.expires_at === null ? null : Number(r.expires_at), actionHash: r.action_hash,
    taskId: r.task_id, sessionId: r.session_id, projectId: r.project_id, jobId: r.job_id, delegable: r.delegable === 1, surface: Number(r.surface),
    acknowledgedUnsandboxed: r.acknowledged_unsandboxed === 1,
  });
}

interface View { grant: StoredGrant; state: GrantState }

export class GrantStore implements GrantSource {
  readonly #db: DatabaseSync;
  readonly #chain: ApprovalChain;
  readonly #clock: Clock;
  readonly #audit: PolicyAudit | undefined;

  constructor(o: GrantStoreOptions) {
    this.#audit = o.audit;
    this.#db = o.db;
    this.#chain = o.chain;
    this.#clock = o.clock;
  }

  // ---- GrantSource (read side; verified on every call) ----

  list(q: { person: string; agent: string; capability: string }): readonly Grant[] {
    const rows = this.#db.prepare(
      "SELECT * FROM grants WHERE person = ? AND agent = ? AND capability = ? AND revoked_at IS NULL AND consumed_at IS NULL ORDER BY created_at, id",
    ).all(q.person, q.agent, q.capability) as unknown as GrantRow[];
    return this.#views(rows).filter((v) => v.state === "active").map((v) => v.grant);
  }

  /** For ids a hand-off references (D104). Unknown, foreign or suspended ids resolve to nothing. Revoked/consumed grants are returned flagged. */
  get(id: string): Grant | undefined {
    const row = this.#db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as unknown as GrantRow | undefined;
    if (!row) return undefined;
    const v = this.#views([row])[0]!;
    return v.state === "suspended" ? undefined : v.grant;
  }

  /** Everything the chain vouches for or not, with its state, for `grant list` and the integrity check. */
  inspect(filter: { person?: string; agent?: string } = {}): View[] {
    const rows = this.#db.prepare("SELECT * FROM grants WHERE (? IS NULL OR person = ?) AND (? IS NULL OR agent = ?) ORDER BY created_at, id")
      .all(filter.person ?? null, filter.person ?? null, filter.agent ?? null, filter.agent ?? null) as unknown as GrantRow[];
    return this.#views(rows);
  }

  #viewOf(id: string): View | undefined {
    const row = this.#db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as unknown as GrantRow | undefined;
    return row ? this.#views([row])[0] : undefined;
  }

  #views(rows: readonly GrantRow[]): View[] {
    const snap = this.#chain.snapshot();
    return rows.map((r) => {
      const list: readonly ChainEntry[] = snap.byRef.get(r.id) ?? [];
      const g = this.#toGrant(r);
      const created = list.find((e) => e.kind === "grant.created");
      let vouched = created !== undefined && created.seq < snap.trustedBelow;
      if (vouched) {
        try { vouched = JSON.stringify((JSON.parse(created!.payload) as { def: unknown }).def) === definitionOf(r); } catch { vouched = false; }
      }
      // Chain facts only count while they are themselves proven; a revocation always counts (stricter).
      const ended = list.find((e) => e.kind === "grant.revoked" || e.kind === "grant.ended");
      const consumed = list.find((e) => e.kind === "grant.consumed" && e.seq < snap.trustedBelow);
      const uses = list.filter((e) => e.kind === "grant.used" && e.seq < snap.trustedBelow);
      delete g.lastUsedAt;
      if (uses.length > 0) g.lastUsedAt = Math.max(...uses.map((e) => e.ts));
      if (ended && g.revokedAt === undefined) g.revokedAt = ended.ts;
      if (ended || g.revokedAt !== undefined) g.revoked = true;
      if (consumed && g.consumedAt === undefined) g.consumedAt = consumed.ts;
      const state: GrantState = !vouched ? "suspended" : g.revoked === true ? "revoked" : g.consumedAt !== undefined ? "consumed" : "active";
      return { grant: g, state };
    });
  }

  #toGrant(r: GrantRow): StoredGrant {
    const match: GrantMatch = r.match_kind === "path"
      ? { kind: "path", path: r.match_path!, access: r.match_access as "read" | "write", recursive: r.match_recursive === 1 }
      : { kind: r.match_kind as "action" | "capability" };
    const g: StoredGrant = {
      id: r.id, capability: r.capability, person: r.person, agent: r.agent, scope: r.duration as GrantScope, match,
      createdAt: Number(r.created_at), surface: Number(r.surface) as SurfaceTrust, createdBy: r.created_by,
    };
    if (r.effect !== null) g.effect = r.effect;
    if (r.expires_at !== null) g.expiresAt = Number(r.expires_at);
    if (r.revoked_at !== null) { g.revokedAt = Number(r.revoked_at); g.revoked = true; }
    if (r.end_reason !== null) g.endReason = r.end_reason;
    if (r.last_used_at !== null) g.lastUsedAt = Number(r.last_used_at);
    if (r.consumed_at !== null) g.consumedAt = Number(r.consumed_at);
    if (r.action_hash !== null) g.actionHash = r.action_hash;
    if (r.task_id !== null) g.taskId = r.task_id;
    if (r.session_id !== null) g.sessionId = r.session_id;
    if (r.project_id !== null) g.projectId = r.project_id;
    if (r.job_id !== null) g.jobId = r.job_id;
    if (r.delegable === 1) g.delegable = true;
    if (r.acknowledged_unsandboxed === 1) g.acknowledgedUnsandboxed = true;
    return g;
  }

  #note(action: PolicyAuditAction, g: Grant & { createdBy?: string }, extra: { by?: string; reason?: string; actionHash?: string } = {}): void {
    this.#audit?.record(action, {
      person: g.person, agentId: g.agent, capability: g.capability, grantId: g.id, grantScope: g.scope, matchKind: g.match.kind,
      ...(g.match.kind === "path" ? { targets: [g.match.path] } : {}),
      ...(g.jobId !== undefined ? { jobId: g.jobId } : {}), ...(g.taskId !== undefined ? { taskId: g.taskId } : {}), ...(g.sessionId !== undefined ? { sessionId: g.sessionId } : {}),
      ...(action === "grant.created" ? { decisionSurface: g.surface, by: g.createdBy ?? g.person } : {}),
      ...(extra.by !== undefined ? { by: extra.by } : {}), ...(extra.reason !== undefined ? { reason: extra.reason } : {}), ...(extra.actionHash !== undefined ? { actionHash: extra.actionHash } : {}),
    });
  }

  // ---- write side ----

  create(i: CreateGrantInput): StoredGrant {
    const def = CAPABILITIES.get(typeof i.capability === "string" ? i.capability.trim().toLowerCase() : "");
    const bad = (code: GrantErrorCode, msg: string): never => { throw new GrantError(code, msg); };
    const str = (v: unknown) => typeof v === "string" && v.length > 0;
    if (!def) bad("invalid-grant", `unknown capability ${String(i.capability)}`);
    if (def!.base.inside === "never") bad("never-capability", `${def!.id} is a never capability; no grant can exist for it`);
    if (def!.ceiling === null) bad("ceiling-exceeded", `${def!.id} takes no standing grant`);
    if (!str(i.person) || !str(i.agent) || !str(i.createdBy)) bad("invalid-grant", "person, agent and createdBy are required");
    if (!(GRANT_SCOPES as readonly string[]).includes(i.scope)) bad("invalid-grant", `unknown duration ${String(i.scope)}`);
    if (scopeRank(i.scope) > scopeRank(def!.ceiling!)) bad("ceiling-exceeded", `${def!.id} allows at most ${def!.ceiling} grants`);
    if (![1, 2, 3].includes(i.surface)) bad("surface-too-low", "a grant needs a decision from a T1..T3 surface");
    if (def!.minSurface !== null && i.surface < def!.minSurface) bad("surface-too-low", `${def!.id} needs a decision from T${def!.minSurface} or above`);
    if (i.expiresAt !== undefined && !Number.isFinite(i.expiresAt)) bad("invalid-grant", "expiresAt must be a finite number");
    if (i.scope === "once") {
      if (!str(i.actionHash) || i.match.kind !== "action") bad("invalid-grant", "a once grant is bound to an action hash (match.kind = action)");
    } else if (i.match.kind === "action") bad("invalid-grant", "only a once grant can match an action hash");
    if (i.scope === "task" && !str(i.taskId)) bad("invalid-grant", "a task grant needs a taskId");
    if (i.scope === "session" && !str(i.sessionId)) bad("invalid-grant", "a session grant needs a sessionId");
    if (i.jobId !== undefined && (i.scope !== "always" || !str(i.jobId))) bad("invalid-grant", "a job grant is a standing (always) grant");
    if (i.match.kind === "path") {
      const m = i.match;
      if (!str(m.path) || (m.access !== "read" && m.access !== "write") || typeof m.recursive !== "boolean") bad("invalid-grant", "path match needs path, access and recursive");
      const syn = checkSyntax(m.path, { platform: process.platform });
      if (isPathRefusal(syn)) bad("invalid-grant", `grant path refused: ${syn.reason}`);
      else if (!syn.absolute) bad("invalid-grant", "grant path must be absolute and canonical");
    }
    const now = this.#clock.now();
    const id = i.id ?? `grt_${createHash("sha256").update(`${now}:${Math.random()}:${process.pid}`).digest("hex").slice(0, 24)}`;
    const m = i.match;
    return transaction(this.#db, () => {
      if (this.#db.prepare("SELECT 1 FROM grants WHERE id = ?").get(id)) bad("duplicate-id", `grant ${id} exists`);
      const created = this.#insert(id, now, i, m, def!.id);
      this.#note("grant.created", created);
      return created;
    });
  }

  #insert(id: string, now: number, i: CreateGrantInput, m: GrantMatch, capability: string): StoredGrant {
    // The row is written first, read back through definitionOf, then chained: the chained definition is exactly what a
    // later read recomputes from the row. Both happen in the caller's transaction.
    this.#db.prepare(
      `INSERT INTO grants (id, person, agent, capability, effect, match_kind, match_path, match_access, match_recursive, duration, created_by, created_at, expires_at,
        action_hash, task_id, session_id, project_id, job_id, delegable, surface, acknowledged_unsandboxed, def_hash, chain_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0)`,
    ).run(
      id, i.person, i.agent, capability, i.effect ?? null, m.kind, m.kind === "path" ? m.path : null, m.kind === "path" ? m.access : null,
      m.kind === "path" ? (m.recursive ? 1 : 0) : null, i.scope, i.createdBy, now, i.expiresAt ?? null, i.actionHash ?? null, i.taskId ?? null,
      i.sessionId ?? null, i.projectId ?? null, i.jobId ?? null, i.delegable === true ? 1 : 0, i.surface, i.acknowledgedUnsandboxed === true ? 1 : 0,
    );
    const row = this.#db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as unknown as GrantRow;
    const def = definitionOf(row);
    const defHash = createHash("sha256").update(def).digest("hex");
    const e = this.#chain.append("grant.created", id, { def: JSON.parse(def) as unknown, defHash });
    this.#db.prepare("UPDATE grants SET def_hash = ?, chain_seq = ? WHERE id = ?").run(defHash, e.seq, id);
    return this.#toGrant({ ...row, def_hash: defHash, chain_seq: e.seq });
  }

  /** Immediate: the next `list`/`get` no longer yields it. Returns false when it was unknown or already ended. */
  revoke(id: string, by: string, reason = "revoked"): boolean {
    return transaction(this.#db, () => {
      const now = this.#clock.now();
      const r = this.#db.prepare("UPDATE grants SET revoked_at = ?, end_reason = ? WHERE id = ? AND revoked_at IS NULL").run(now, reason, id);
      if (Number(r.changes) !== 1) return false;
      try {
        this.#chain.append(reason === "revoked" ? "grant.revoked" : "grant.ended", id, { by, reason });
      } catch (e) {
        // A broken chain cannot take a new entry, but a revocation only narrows: the row alone ends the grant (views honour it).
        if (!(e instanceof ApprovalChainError)) throw e;
      }
      try {
        const row = this.#db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as unknown as GrantRow;
        this.#note(reason === "revoked" ? "grant.revoked" : "grant.ended", this.#toGrant(row), { by, reason });
      } catch { /* a revocation is never blocked by the audit trail */ }
      return true;
    });
  }

  /** §4: a task grant ends with its task. Returns how many ended. */
  endTask(taskId: string, by = "core"): number {
    return this.#endWhere("task", "task_id", taskId, by, "task-ended");
  }
  /** §4: a session grant ends with its session. */
  endSession(sessionId: string, by = "core"): number {
    return this.#endWhere("session", "session_id", sessionId, by, "session-ended");
  }
  #endWhere(duration: string, col: "task_id" | "session_id", value: string, by: string, reason: string): number {
    return transaction(this.#db, () => {
      const ids = this.#db.prepare(`SELECT id FROM grants WHERE duration = ? AND ${col} = ? AND revoked_at IS NULL`).all(duration, value) as unknown as { id: string }[];
      let n = 0;
      for (const { id } of ids) if (this.revoke(id, by, reason)) n += 1;
      return n;
    });
  }

  /** Records a use of a standing grant (resets the 90-day clock). Chained at most once per `USE_RECORD_GRANULARITY_MS`. */
  markUsed(id: string): void {
    transaction(this.#db, () => {
      const v = this.#viewOf(id);
      if (!v || v.state !== "active" || v.grant.scope === "once") return;
      const now = this.#clock.now();
      if (v.grant.lastUsedAt !== undefined && now - v.grant.lastUsedAt < USE_RECORD_GRANULARITY_MS) return;
      this.#chain.append("grant.used", id, {});
      this.#db.prepare("UPDATE grants SET last_used_at = ? WHERE id = ?").run(now, id);
      this.#note("grant.used", v.grant);
    });
  }

  /**
   * §4/§6: `once` is consumed atomically with execution start. One `UPDATE ... WHERE consumed_at IS NULL` inside an
   * IMMEDIATE transaction decides; `changes` must be exactly 1. Every other caller, in this process or another, gets
   * false. Also false for a revoked, expired (10 min unused), suspended or differently-bound grant.
   */
  consumeOnce(id: string, b: { person: string; agent: string; actionHash: string }): boolean {
    try {
      return this.#consumeOnce(id, b);
    } catch (e) {
      if (e instanceof ApprovalChainError) return false; // a broken chain cannot record the consumption: nothing runs on it
      throw e;
    }
  }
  #consumeOnce(id: string, b: { person: string; agent: string; actionHash: string }): boolean {
    return transaction(this.#db, () => {
      const v = this.#viewOf(id);
      if (!v || v.state !== "active") return false; // chain-derived state first: a reset row cannot resurrect a consumed grant
      const now = this.#clock.now();
      const r = this.#db.prepare(
        `UPDATE grants SET consumed_at = ?, last_used_at = ?
         WHERE id = ? AND duration = 'once' AND consumed_at IS NULL AND revoked_at IS NULL
           AND person = ? AND agent = ? AND action_hash = ?
           AND created_at + ? > ? AND (expires_at IS NULL OR expires_at > ?)`,
      ).run(now, now, id, b.person, b.agent, b.actionHash, DEFAULTS.lifetimes.onceUnusedMs, now, now);
      if (Number(r.changes) !== 1) return false;
      this.#chain.append("grant.consumed", id, { actionHash: b.actionHash });
      this.#note("grant.consumed", v.grant, { actionHash: b.actionHash });
      return true;
    });
  }
}
