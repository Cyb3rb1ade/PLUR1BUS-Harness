// D109 §5/§6: the approval store. A request is bound to (request id, action hash, principal, subject, turn/task/session,
// nonce); a decision is a chain entry; `consume` is single-use. The HMAC chain is the authority: the `approvals` table is
// only a projection for listing, and nothing is ever decided from it. A broken chain fails closed (ApprovalIntegrityError).
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Clock, SubjectKind } from "../policy/decide.ts";
import type { SurfaceTrust } from "../policy/capabilities.ts";
import { ApprovalChain, ApprovalChainError, bindingTuple, type ChainEntry, type VerifyResult } from "./chain.ts";
import { transaction } from "./db.ts";
import type { ChainKeySource } from "./keys.ts";

export const DEFAULT_REQUEST_TTL_MS = 24 * 60 * 60_000; // §5: parked up to 24 h, then expired = denied

export interface ApprovalSubject { kind: SubjectKind; id: string }
export interface ApprovalBinding {
  requestId: string;
  actionHash: string;
  /** The person on whose behalf the call runs (and the only one who may decide it). */
  principal: string;
  subject: ApprovalSubject;
  turnId: string;
  taskId: string;
  sessionId: string;
}

/** The closed reasons of E_DENIED (§6); `surface-untrusted` is returned for a decision from a T0 surface only. */
export type ApprovalDenial = "approval-mismatch" | "approval-used" | "approval-expired" | "surface-untrusted";
export type ApprovalResult<T extends object = Record<never, never>> = ({ ok: true } & T) | { ok: false; reason: ApprovalDenial };

export class ApprovalIntegrityError extends ApprovalChainError {}

export type ApprovalStatus = "pending" | "approved" | "denied" | "used" | "expired";
export interface ApprovalRecord {
  id: string;
  status: ApprovalStatus;
  capability: string;
  bound: Omit<ApprovalBinding, "requestId">;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  decidedBy?: string;
  decisionSurface?: SurfaceTrust;
  delegable: boolean;
  usedAt?: number;
}

export interface RequestInput extends Omit<ApprovalBinding, "requestId"> { capability: string }
export interface DecideInput {
  requestId: string;
  nonce: string;
  decision: "approve" | "deny";
  person: string;
  surface: SurfaceTrust;
  /** "allow for this task, including helpers" (§6, D104). */
  delegable?: boolean;
}

export interface ApprovalStore {
  /** Issues a request with a one-time nonce. The nonce goes only to the surfaces that may decide it. */
  request(input: RequestInput): { id: string; nonce: string; expiresAt: number };
  decide(input: DecideInput): ApprovalResult<{ status: "approved" | "denied" }>;
  /** Atomic single use: exactly one caller gets `ok`; the same arguments afterwards are `approval-used`. */
  consume(b: ApprovalBinding): ApprovalResult<{ delegable: boolean }>;
  get(id: string): ApprovalRecord | undefined;
  list(filter?: { status?: ApprovalStatus; principal?: string }): ApprovalRecord[];
  verify(): VerifyResult;
  readonly chain: ApprovalChain;
}

export interface ApprovalStoreOptions {
  db: DatabaseSync;
  keys: ChainKeySource;
  clock: Clock;
  requestTtlMs?: number;
}

const sameStr = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const boundOf = (b: ApprovalBinding): Omit<ApprovalBinding, "requestId"> => ({
  actionHash: b.actionHash, principal: b.principal, subject: { kind: b.subject.kind, id: b.subject.id }, turnId: b.turnId, taskId: b.taskId, sessionId: b.sessionId,
});

export async function createApprovalStore(o: ApprovalStoreOptions): Promise<ApprovalStore> {
  const chain = new ApprovalChain(o.db, await o.keys.load(), o.clock);
  const ttl = o.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;

  /** The verified snapshot, or a thrown integrity error (fail closed). */
  const trusted = () => {
    const snap = chain.snapshot();
    if (!snap.result.ok) throw new ApprovalIntegrityError(snap.result);
    return snap;
  };
  const find = (list: readonly ChainEntry[] | undefined, kind: string): ChainEntry | undefined => list?.find((e) => e.kind === kind);
  const parse = (e: ChainEntry): Record<string, any> => JSON.parse(e.payload) as Record<string, any>;

  function record(id: string, list: readonly ChainEntry[], now: number): ApprovalRecord | undefined {
    const req = find(list, "approval.requested");
    if (!req) return undefined;
    const rp = parse(req);
    const dec = find(list, "approval.decided");
    const use = find(list, "approval.used");
    const dp = dec ? parse(dec) : undefined;
    const expiresAt = Number(rp.expiresAt);
    let status: ApprovalStatus = use ? "used" : dp ? (dp.decision === "approve" ? "approved" : "denied") : "pending";
    if ((status === "pending" || status === "approved") && now >= expiresAt) status = "expired";
    const out: ApprovalRecord = { id, status, capability: String(rp.capability), bound: rp.bound, createdAt: req.ts, expiresAt, delegable: dp?.delegable === true };
    if (dec && dp) { out.decidedAt = dec.ts; out.decidedBy = String(dp.person); out.decisionSurface = dp.surface as SurfaceTrust; }
    if (use) out.usedAt = use.ts;
    return out;
  }

  return {
    chain,
    verify: () => chain.verify(),

    request(input) {
      const id = `apr_${randomBytes(12).toString("hex")}`;
      const nonce = randomBytes(16).toString("hex");
      const bound = boundOf({ ...input, requestId: id });
      if (bindingTuple(bound) === null) throw new TypeError("approval request needs actionHash, principal, subject, turnId, taskId and sessionId");
      return transaction(o.db, () => {
        trusted();
        const now = o.clock.now();
        const expiresAt = now + ttl;
        chain.append("approval.requested", id, { capability: input.capability, expiresAt, bound }, nonce);
        o.db.prepare(
          "INSERT INTO approvals (id, principal, subject_kind, subject_id, capability, action_hash, turn_id, task_id, session_id, nonce, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        ).run(id, bound.principal, bound.subject.kind, bound.subject.id, input.capability, bound.actionHash, bound.turnId, bound.taskId, bound.sessionId, nonce, now, expiresAt);
        return { id, nonce, expiresAt };
      });
    },

    decide(d) {
      if (d.surface === 0) return { ok: false, reason: "surface-untrusted" };
      return transaction(o.db, () => {
        const list = trusted().byRef.get(d.requestId);
        const req = find(list, "approval.requested");
        if (!req) return { ok: false, reason: "approval-mismatch" } as const;
        const rp = parse(req);
        if (rp.bound.principal !== d.person) return { ok: false, reason: "approval-mismatch" } as const;
        if (typeof d.nonce !== "string" || req.nonce === null || !sameStr(d.nonce, req.nonce)) return { ok: false, reason: "approval-mismatch" } as const;
        if (find(list, "approval.decided")) return { ok: false, reason: "approval-used" } as const;
        const now = o.clock.now();
        if (now >= Number(rp.expiresAt)) return { ok: false, reason: "approval-expired" } as const;
        const delegable = d.delegable === true && d.decision === "approve";
        chain.append("approval.decided", d.requestId, { decision: d.decision, person: d.person, surface: d.surface, delegable, bound: rp.bound }, d.nonce);
        const status = d.decision === "approve" ? "approved" : "denied";
        o.db.prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, decision_surface = ?, delegable = ? WHERE id = ?")
          .run(status, now, d.person, d.surface, delegable ? 1 : 0, d.requestId);
        return { ok: true, status } as const;
      });
    },

    consume(b) {
      const tuple = bindingTuple(boundOf(b));
      return transaction(o.db, () => {
        const list = trusted().byRef.get(b.requestId);
        const req = find(list, "approval.requested");
        const dec = find(list, "approval.decided");
        if (!req || !dec || tuple === null) return { ok: false, reason: "approval-mismatch" } as const;
        const rp = parse(req);
        const dp = parse(dec);
        if (dp.decision !== "approve" || bindingTuple(rp.bound) !== tuple) return { ok: false, reason: "approval-mismatch" } as const;
        if (find(list, "approval.used")) return { ok: false, reason: "approval-used" } as const;
        const now = o.clock.now();
        if (now >= Number(rp.expiresAt)) return { ok: false, reason: "approval-expired" } as const;
        chain.append("approval.used", b.requestId, { bound: rp.bound });
        o.db.prepare("UPDATE approvals SET status = 'used', used_at = ? WHERE id = ?").run(now, b.requestId);
        return { ok: true, delegable: dp.delegable === true } as const;
      });
    },

    get(id) {
      return record(id, trusted().byRef.get(id) ?? [], o.clock.now());
    },

    list(filter = {}) {
      const snap = trusted();
      const now = o.clock.now();
      const out: ApprovalRecord[] = [];
      for (const [id, list] of snap.byRef) {
        const r = record(id, list, now);
        if (r && (filter.status === undefined || r.status === filter.status) && (filter.principal === undefined || r.bound.principal === filter.principal)) out.push(r);
      }
      return out.sort((a, b) => a.createdAt - b.createdAt);
    },
  };
}
