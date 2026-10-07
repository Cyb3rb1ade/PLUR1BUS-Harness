// D109: the wire shapes of grants and approvals (rpc.schema.json $defs/GrantRecord, ApprovalRecord). Everything that leaves the
// core about a grant or an approval goes through here: ISO times, only the schema's keys, no nonce, no raw arguments (the
// service's summary is already redacted). The closed schema (additionalProperties: false) is why this is a projection, not a spread.
import type { ApprovalRecord, GrantMatch, GrantRecord } from "@plur1bus/rpc-schema";
import { RpcError } from "../rpc/errors.ts";
import type { GrantState, StoredGrant } from "../grants/store.ts";
import type { ApprovalView } from "./service.ts";

export const iso = (ms: number): string => new Date(ms).toISOString();
export const parseIso = (s: unknown): number | undefined => {
  if (typeof s !== "string" || s.length === 0) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
};

const MAX_TARGETS = 200;
const MAX_SUMMARY = 8192;
/** The store's "no task / no session" placeholder (`-`) is not an id a client should see. */
const real = (s: string | undefined): string | undefined => (s === undefined || s === "" || s === "-" ? undefined : s);
const RISKS = ["low", "medium", "high", "critical"] as const;
const SUBJECTS = ["agent", "subagent", "acp-agent", "mcp-client", "acp-editor", "a2a-peer", "remote-harness"] as const;

export function approvalRecordOf(v: ApprovalView): ApprovalRecord {
  const turn = real(v.turnId), task = real(v.taskId), session = real(v.sessionId);
  const out: ApprovalRecord = {
    id: v.id, status: v.status, capability: v.capability, principal: v.principal,
    subject: { kind: (SUBJECTS as readonly string[]).includes(v.subject.kind) ? (v.subject.kind as ApprovalRecord["subject"]["kind"]) : "agent", id: v.subject.id },
    actionHash: v.actionHash, createdAt: iso(v.createdAt), expiresAt: iso(v.expiresAt), delegable: v.delegable === true,
  };
  if (v.tool !== undefined) out.tool = v.tool;
  if (v.risk !== undefined && (RISKS as readonly string[]).includes(v.risk)) out.risk = v.risk as ApprovalRecord["risk"] & string;
  if (v.reversible !== undefined) out.reversible = v.reversible;
  if (turn) out.turnId = turn;
  if (task) out.taskId = task;
  if (session) out.sessionId = session;
  if (v.requiredSurface !== undefined) out.requiredSurface = v.requiredSurface;
  if (v.originSurface !== undefined) out.originSurface = v.originSurface;
  if (v.grantOptions !== undefined) out.grantOptions = v.grantOptions.map((g) => ({ scope: g.scope, requiredSurface: g.requiredSurface }));
  if (v.tainted !== undefined) out.tainted = v.tainted;
  if (v.targets !== undefined) out.targets = v.targets.slice(0, MAX_TARGETS);
  if (v.summary !== undefined) out.summary = v.summary.slice(0, MAX_SUMMARY);
  if (v.decidedAt !== undefined) out.decidedAt = iso(v.decidedAt);
  if (v.decidedBy !== undefined) out.decidedBy = v.decidedBy;
  if (v.decisionSurface !== undefined) out.decisionSurface = v.decisionSurface;
  if (v.usedAt !== undefined) out.usedAt = iso(v.usedAt);
  return out;
}

export function grantRecordOf(g: StoredGrant, state: GrantState): GrantRecord {
  const match: GrantMatch = g.match.kind === "path"
    ? { kind: "path", path: g.match.path, access: g.match.access, recursive: g.match.recursive }
    : { kind: g.match.kind };
  const out: GrantRecord = {
    id: g.id, capability: g.capability, person: g.person, agent: g.agent, scope: g.scope, match, state, createdBy: g.createdBy,
    createdAt: iso(g.createdAt), delegable: g.delegable === true, surface: g.surface,
  };
  if (g.effect !== undefined) out.effect = g.effect;
  if (g.lastUsedAt !== undefined) out.lastUsedAt = iso(g.lastUsedAt);
  if (g.expiresAt !== undefined) out.expiresAt = iso(g.expiresAt);
  if (g.revokedAt !== undefined) out.revokedAt = iso(g.revokedAt);
  if (g.endReason !== undefined) out.endReason = g.endReason;
  if (g.actionHash !== undefined) out.actionHash = g.actionHash;
  if (g.taskId !== undefined) out.taskId = g.taskId;
  if (g.sessionId !== undefined) out.sessionId = g.sessionId;
  if (g.projectId !== undefined) out.projectId = g.projectId;
  if (g.jobId !== undefined) out.jobId = g.jobId;
  return out;
}

// ---- paging: newest first, a keyset cursor bound to the filters it was made with ----

export const DEFAULT_LIMIT = 100;
const MAX_CURSOR = 512;
interface Cursor { k: "g" | "a"; f: string; t: number; i: string }
const badCursor = (): RpcError => new RpcError("E_INVALID_PARAMS", "the cursor is not valid for this request", { reason: "bad-cursor", detail: "cursor" });

export function page<T extends { createdAt: number; id: string }>(
  kind: "g" | "a", items: readonly T[], o: { filter: Record<string, unknown>; limit?: number; cursor?: string },
): { items: T[]; nextCursor?: string } {
  const f = JSON.stringify(Object.keys(o.filter).sort().map((k) => [k, o.filter[k] ?? null]));
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  let from = 0;
  if (o.cursor !== undefined) {
    let c: Cursor;
    try {
      if (o.cursor.length > MAX_CURSOR) throw new Error("long");
      c = JSON.parse(Buffer.from(o.cursor, "base64url").toString("utf8")) as Cursor;
    } catch { throw badCursor(); }
    if (c === null || typeof c !== "object" || c.k !== kind || c.f !== f || !Number.isFinite(c.t) || typeof c.i !== "string") throw badCursor();
    from = sorted.findIndex((x) => x.createdAt < c.t || (x.createdAt === c.t && x.id < c.i));
    if (from < 0) from = sorted.length;
  }
  const limit = o.limit ?? DEFAULT_LIMIT;
  const slice = sorted.slice(from, from + limit);
  const more = from + limit < sorted.length;
  const last = slice[slice.length - 1];
  return { items: slice, ...(more && last ? { nextCursor: Buffer.from(JSON.stringify({ k: kind, f, t: last.createdAt, i: last.id } satisfies Cursor)).toString("base64url") } : {}) };
}
