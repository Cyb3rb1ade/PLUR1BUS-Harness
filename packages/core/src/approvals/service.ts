// D109 §5/§6 (D4): the approval service. It implements the dispatcher's `ApprovalPort`: a call whose decision is `ask` is parked
// here, a request is stored (nonce, bound to action hash / principal / subject / session / task), `approval.requested` goes out,
// and the call waits for a person's decision. The first valid answer wins. NOTHING is ever approved automatically: a timeout, an
// abort, a headless run, a broken chain, a failing audit line or any other error ends as "not approved".
//
// Timing (all through the injected `Timers` and `Clock`): the foreground waits `foregroundWaitMs` (10 min), then the call gets a
// "parked" not-approved answer and the request stays open until the store's TTL (24 h) is over; then it is expired = denied.
//
// What a decision does: `decide` checks the surface (`surfaceMayDecide`), records the decision in the chain, creates the grant the
// person chose (a once grant bound to the action hash by default; a path or capability grant for a wider scope, narrowed to the
// call's own targets) and writes the audit line, all in ONE transaction, so an unrecordable decision does not exist. `begin` is the
// execution start: it consumes the approval and its once grant atomically; a replay is refused.
import type { DatabaseSync } from "node:sqlite";
import { createRedactor, type Redactor } from "../logs/redact.ts";
import {
  CAPABILITIES, GRANT_SCOPES, maxScopeFor, scopeRank, surfaceMayDecide,
  type Context, type GrantOption, type GrantScope, type SurfaceTrust,
} from "../policy/index.ts";
import type { Clock } from "../policy/decide.ts";
import { hashAndSize, type HeldRejection, type PolicyAudit, type PolicyAuditAction, type PolicyAuditFields } from "../policy/audit.ts";
import { GrantError, type GrantStore } from "../grants/store.ts";
import type { ApprovalAnswer, ApprovalAsk, ApprovalPort } from "../tools/approval.ts";
import { canonicalJson, type DispatchContext } from "../tools/dispatcher.ts";
import { transaction } from "./db.ts";
import { ApprovalChainError, type VerifyResult } from "./chain.ts";
import type { ApprovalBinding, ApprovalDenial, ApprovalRecord, ApprovalStatus, ApprovalStore } from "./store.ts";

/** §5: a foreground turn waits this long before the task parks. */
export const DEFAULT_FOREGROUND_WAIT_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;
const MAX_SUMMARY = 2048;
const MAX_TARGETS = 50;

export interface Timers { set(fn: () => void, ms: number): () => void }
const realTimers: Timers = { set(fn, ms) { const t = setTimeout(fn, ms); return () => clearTimeout(t); } };

/** What a surface or RPC handler is shown about a request. Never carries the nonce or the raw arguments (the summary is redacted). */
export interface ApprovalView {
  id: string;
  status: ApprovalStatus;
  capability: string;
  tool?: string;
  effect?: string;
  risk?: string;
  reversible?: boolean;
  principal: string;
  subject: { kind: string; id: string };
  actionHash: string;
  turnId: string;
  taskId: string;
  sessionId: string;
  requiredSurface?: SurfaceTrust;
  originSurface?: SurfaceTrust;
  grantOptions?: readonly GrantOption[];
  tainted?: boolean;
  taintSuspended?: boolean;
  flags?: Record<string, boolean>;
  targets?: readonly string[];
  summary?: string;
  createdAt: number;
  expiresAt: number;
  delegable: boolean;
  decidedAt?: number;
  decidedBy?: string;
  decisionSurface?: SurfaceTrust;
  usedAt?: number;
  cancelledAt?: number;
}

export type ApprovalEvent =
  /** `nonce` is for the surfaces that may decide (channel relays); an RPC notification mapper must drop it. */
  | { name: "approval.requested"; payload: { approval: ApprovalView; nonce: string; foregroundUntil: number } }
  | { name: "approval.parked"; payload: { approval: ApprovalView } }
  | { name: "approval.resolved"; payload: { approval: ApprovalView; outcome: "approved" | "denied" | "expired" | "cancelled"; scope?: GrantScope; grantIds?: readonly string[] } }
  | { name: "grant.changed"; payload: { change: "created"; grantId: string; person: string; agent: string; capability: string; scope: GrantScope } };
export interface ApprovalEvents { emit<E extends ApprovalEvent>(name: E["name"], payload: E["payload"]): void }

export type ServiceDecideDenial = ApprovalDenial | "scope-unavailable";
export interface ServiceDecideInput {
  requestId: string;
  nonce: string;
  decision: "approve" | "deny";
  person: string;
  surface: SurfaceTrust;
  /** Default `once`. Ignored for a denial. */
  scope?: GrantScope;
  /** "allow for this task, including helpers" (D104). */
  delegable?: boolean;
  /** `shell.exec` without a sandbox: the person knowingly accepted "not sandboxed" (Q17). */
  acknowledgedUnsandboxed?: boolean;
}
export type ServiceDecideResult =
  | { ok: true; status: "approved" | "denied"; scope?: GrantScope; grantIds: readonly string[] }
  | { ok: false; reason: ServiceDecideDenial };

export interface ApprovalServiceOptions {
  stores: { db: DatabaseSync; approvals: ApprovalStore; grants: GrantStore };
  clock: Clock;
  timers?: Timers;
  events?: ApprovalEvents;
  audit?: PolicyAudit;
  foregroundWaitMs?: number;
  /** Exact secret values to mask in the redacted summary. */
  secrets?: Iterable<string>;
  redactor?: Redactor;
}

export interface ApprovalService extends ApprovalPort {
  request(ask: ApprovalAsk): Promise<ApprovalAnswer>;
  begin(answer: ApprovalAnswer, ask: ApprovalAsk): boolean;
  /** For a surface that holds the nonce (a channel relay): the decision of a person. */
  decide(input: ServiceDecideInput): ServiceDecideResult;
  /** For an authenticated surface (RPC session, CLI on a TTY): the nonce stays inside the core. The caller vouches for `person` and `surface`. */
  decideForSession(input: Omit<ServiceDecideInput, "nonce">): ServiceDecideResult;
  list(filter?: { status?: ApprovalStatus; principal?: string; taskId?: string; sessionId?: string }): ApprovalView[];
  /** With `principal`, a request of another person is `undefined`, exactly like an unknown id. */
  get(id: string, principal?: string): ApprovalView | undefined;
  cancel(input: { requestId: string; person: string; by?: string }): { ok: true } | { ok: false; reason: ApprovalDenial };
  verify(): VerifyResult;
  /** Context for the dispatcher: `deniedActionHashes`, `promptsThisHour` and a verified `handoff.approvalsHeld`, on top of what `inner` returns. */
  policyContext(inner?: (ctx: DispatchContext) => Partial<Context>): (ctx: DispatchContext) => Partial<Context>;
  /** Every waiting call ends as not approved; timers are cleared. */
  dispose(): void;
}

/** What the harness computed about a request; chained with it so a decision after a restart can be checked without memory. */
interface RequestDetail {
  tool: string; effect: string; risk: string; reversible: boolean; flags: Record<string, boolean>;
  requiredSurface: SurfaceTrust; originSurface: SurfaceTrust; grantOptions: readonly GrantOption[]; tainted: boolean; taintSuspended: boolean;
  agentId: string; callId: string; targets: string[]; targetsMasked: boolean; targetsTotal: number; access?: "read" | "write";
  summary: string; argsBytes: number; payloadHash: string;
  /** Only when the call carried a real one: a task / session grant needs it. */
  taskId?: string; sessionId?: string; projectId?: string;
}

class Refused extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "Refused"; this.code = code; }
}

const taskKeyOf = (taskId: string | undefined, sessionId: string | undefined): string => taskId ?? sessionId ?? "-";

function bindingOf(ask: ApprovalAsk): Omit<ApprovalBinding, "requestId"> {
  return {
    actionHash: ask.request.actionHash, principal: ask.principal, subject: { kind: ask.subjectKind ?? "agent", id: ask.agentId },
    turnId: ask.turnId ?? ask.callId, taskId: taskKeyOf(ask.taskId, ask.sessionId), sessionId: ask.sessionId ?? "-",
  };
}

/** The directory of a canonical path: a path grant is narrowed to the direct children of the target's directory, never wider. */
function parentOf(p: string): string | undefined {
  const m = /^(.*)[\\/][^\\/]+$/.exec(p);
  return m && m[1] !== "" && !/^[A-Za-z]:$/.test(m[1]!) ? m[1]! : undefined;
}

export function createApprovalService(o: ApprovalServiceOptions): ApprovalService {
  const { db, approvals: store, grants } = o.stores;
  const clock = o.clock;
  const timers = o.timers ?? realTimers;
  const foregroundMs = o.foregroundWaitMs ?? DEFAULT_FOREGROUND_WAIT_MS;
  const redactor = o.redactor ?? createRedactor(o.secrets ? { secrets: o.secrets } : {});

  interface Waiter { finish(answer: ApprovalAnswer): void }
  const waiters = new Map<string, Waiter>();
  const expiry = new Map<string, () => void>();

  /** An audit line the caller must not act without: throws when it cannot be written. */
  const rec = (action: PolicyAuditAction, f: PolicyAuditFields): void => { o.audit?.record(action, f); };
  /** An audit line about something already refused: never turns a refusal into a failure. */
  const recSoft = (action: PolicyAuditAction, f: PolicyAuditFields): void => { try { rec(action, f); } catch { /* the refusal stands */ } };
  const emit = <E extends ApprovalEvent>(name: E["name"], payload: E["payload"]): void => { try { o.events?.emit(name, payload); } catch { /* a listener never breaks a decision */ } };

  function integrityFailure(e: unknown): void {
    if (e instanceof ApprovalChainError) recSoft("approvals.integrity-failure", { brokenAt: e.brokenAt, failure: e.reason });
  }

  function viewOf(r: ApprovalRecord): ApprovalView {
    const d = r.detail as Partial<RequestDetail> | undefined;
    return {
      id: r.id, status: r.status, capability: r.capability,
      ...(d?.tool !== undefined ? { tool: d.tool } : {}), ...(d?.effect !== undefined ? { effect: d.effect } : {}), ...(d?.risk !== undefined ? { risk: d.risk } : {}),
      ...(d?.reversible !== undefined ? { reversible: d.reversible } : {}),
      principal: r.bound.principal, subject: { kind: r.bound.subject.kind, id: r.bound.subject.id }, actionHash: r.bound.actionHash,
      turnId: r.bound.turnId, taskId: r.bound.taskId, sessionId: r.bound.sessionId,
      ...(d?.requiredSurface !== undefined ? { requiredSurface: d.requiredSurface } : {}), ...(d?.originSurface !== undefined ? { originSurface: d.originSurface } : {}),
      ...(d?.grantOptions !== undefined ? { grantOptions: d.grantOptions } : {}), ...(d?.tainted !== undefined ? { tainted: d.tainted } : {}),
      ...(d?.taintSuspended !== undefined ? { taintSuspended: d.taintSuspended } : {}), ...(d?.flags !== undefined ? { flags: d.flags } : {}),
      ...(d?.targets !== undefined ? { targets: d.targets } : {}), ...(d?.summary !== undefined ? { summary: d.summary } : {}),
      createdAt: r.createdAt, expiresAt: r.expiresAt, delegable: r.delegable,
      ...(r.decidedAt !== undefined ? { decidedAt: r.decidedAt } : {}), ...(r.decidedBy !== undefined ? { decidedBy: r.decidedBy } : {}),
      ...(r.decisionSurface !== undefined ? { decisionSurface: r.decisionSurface } : {}),
      ...(r.usedAt !== undefined ? { usedAt: r.usedAt } : {}), ...(r.cancelledAt !== undefined ? { cancelledAt: r.cancelledAt } : {}),
    };
  }

  function detailOf(ask: ApprovalAsk): RequestDetail {
    const req = ask.request;
    let summary = "(arguments could not be shown)";
    let payload = { hash: "", bytes: 0 };
    try {
      const json = canonicalJson(ask.args);
      payload = hashAndSize(json);
      summary = redactor.text(json.length > 8192 ? json.slice(0, 8192) : json).slice(0, MAX_SUMMARY);
    } catch { /* an argument object that cannot be serialised is shown as such */ }
    const all = (ask.targets ?? []).filter((t): t is string => typeof t === "string");
    const shown = all.slice(0, MAX_TARGETS);
    const masked = shown.map((t) => redactor.text(t));
    const flags: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(req.flags)) if (typeof v === "boolean") flags[k] = v;
    return {
      tool: ask.tool, effect: req.effect, risk: req.risk, reversible: req.reversible, flags,
      requiredSurface: req.requiredSurface, originSurface: req.originSurface, grantOptions: req.grantOptions.map((g) => ({ scope: g.scope, requiredSurface: g.requiredSurface })),
      tainted: req.tainted, taintSuspended: req.taintSuspended, agentId: ask.agentId, callId: ask.callId,
      targets: masked, targetsMasked: masked.some((t, i) => t !== shown[i]) || all.length > shown.length, targetsTotal: all.length,
      ...(ask.access ? { access: ask.access } : {}), summary, argsBytes: payload.bytes, payloadHash: payload.hash,
      ...(ask.taskId !== undefined ? { taskId: ask.taskId } : {}), ...(ask.sessionId !== undefined ? { sessionId: ask.sessionId } : {}),
      ...(ask.projectId !== undefined ? { projectId: ask.projectId } : {}),
    };
  }

  function auditFieldsOf(ask: ApprovalAsk, extra: PolicyAuditFields = {}): PolicyAuditFields {
    return {
      person: ask.principal, agentId: ask.agentId, subjectKind: ask.subjectKind ?? "agent", ...(ask.sessionId ? { sessionId: ask.sessionId } : {}),
      ...(ask.taskId ? { taskId: ask.taskId } : {}), tool: ask.tool, capability: ask.request.capability, effect: ask.request.effect, risk: ask.request.risk,
      actionHash: ask.request.actionHash, surface: ask.request.originSurface, ...extra,
    };
  }

  // ---- request / park ----

  async function request(ask: ApprovalAsk): Promise<ApprovalAnswer> {
    if (ask.park) {
      recSoft("approval.refused", auditFieldsOf(ask, { reason: "headless" }));
      return { approved: false, reason: "headless run without a job-bound standing grant: nothing is asked and nothing parks" };
    }
    if (ask.signal.aborted) return { approved: false, reason: "aborted" };

    let made: { id: string; nonce: string; expiresAt: number };
    try {
      const bound = bindingOf(ask);
      const detail = detailOf(ask);
      made = transaction(db, () => {
        const r = store.request({ ...bound, capability: ask.request.capability, detail: detail as unknown as Record<string, unknown> });
        rec("approval.requested", auditFieldsOf(ask, {
          requestId: r.id, targets: detail.targets, flags: detail.flags, expiresAt: r.expiresAt, argsBytes: detail.argsBytes, payloadHash: detail.payloadHash, payloadBytes: detail.argsBytes,
          ...(ask.taskId === undefined ? { taskId: bound.taskId } : {}),
        }));
        return r;
      });
    } catch (e) {
      integrityFailure(e);
      return { approved: false, reason: e instanceof ApprovalChainError ? "the approval store failed its integrity check: nothing was approved" : "the approval service is unavailable: nothing was approved" };
    }
    const id = made.id;

    return await new Promise<ApprovalAnswer>((resolve) => {
      let done = false;
      let cancelForeground: () => void = () => {};
      const onAbort = (): void => { w.finish({ approved: false, reason: "aborted", requestId: id }); closeAborted(id); };
      const w: Waiter = {
        finish(answer) {
          if (done) return;
          done = true;
          cancelForeground();
          ask.signal.removeEventListener("abort", onAbort);
          waiters.delete(id);
          resolve(answer);
        },
      };
      waiters.set(id, w);
      cancelForeground = timers.set(() => park(id), foregroundMs);
      expiry.set(id, timers.set(() => onExpiry(id), Math.max(0, made.expiresAt - clock.now())));
      ask.signal.addEventListener("abort", onAbort, { once: true });
      const view = safeView(id);
      if (view) emit<Extract<ApprovalEvent, { name: "approval.requested" }>>("approval.requested", { approval: view, nonce: made.nonce, foregroundUntil: clock.now() + foregroundMs });
      if (ask.signal.aborted) onAbort();
    });
  }

  function safeView(id: string): ApprovalView | undefined {
    try { const r = store.get(id); return r ? viewOf(r) : undefined; } catch { return undefined; }
  }

  function park(id: string): void {
    const w = waiters.get(id);
    if (!w) return;
    w.finish({ approved: false, parked: true, requestId: id, reason: `parked: waiting for the person to approve request ${id}; continue with work that does not need it` });
    const view = safeView(id);
    recSoft("approval.parked", { requestId: id, ...(view ? { person: view.principal, tool: view.tool ?? "", capability: view.capability, actionHash: view.actionHash } : {}) });
    if (view) emit<Extract<ApprovalEvent, { name: "approval.parked" }>>("approval.parked", { approval: view });
  }

  function closeAborted(id: string): void {
    try {
      const r = transaction(db, () => {
        const c = store.cancel(id, "abort");
        if (c.ok) rec("approval.cancelled", { requestId: id, by: "abort" });
        return c;
      });
      expiry.get(id)?.(); expiry.delete(id);
      const view = safeView(id);
      if (r.ok && view) emit<Extract<ApprovalEvent, { name: "approval.resolved" }>>("approval.resolved", { approval: view, outcome: "cancelled" });
    } catch (e) { integrityFailure(e); }
  }

  function onExpiry(id: string): void {
    expiry.delete(id);
    let r: ApprovalRecord | undefined;
    try { r = store.get(id); } catch (e) { integrityFailure(e); waiters.get(id)?.finish({ approved: false, reason: "the approval store failed its integrity check", requestId: id }); return; }
    if (!r) return;
    if (r.status === "pending" && clock.now() < r.expiresAt) { expiry.set(id, timers.set(() => onExpiry(id), r!.expiresAt - clock.now())); return; }
    if (r.status !== "expired") return;
    waiters.get(id)?.finish({ approved: false, reason: "the approval request expired; nothing is ever approved automatically", requestId: id });
    recSoft("approval.expired", { requestId: id, person: r.bound.principal, capability: r.capability, actionHash: r.bound.actionHash });
    emit<Extract<ApprovalEvent, { name: "approval.resolved" }>>("approval.resolved", { approval: viewOf(r), outcome: "expired" });
  }

  // ---- decide ----

  function createGrants(r: ApprovalRecord, d: RequestDetail, input: ServiceDecideInput, scope: GrantScope): string[] {
    const b = r.bound;
    const base = {
      capability: r.capability, person: b.principal, agent: b.subject.id, createdBy: input.person, surface: input.surface, effect: d.effect,
      ...(input.delegable === true ? { delegable: true } : {}), ...(d.projectId !== undefined ? { projectId: d.projectId } : {}),
      ...(d.taskId !== undefined ? { taskId: d.taskId } : {}), ...(d.sessionId !== undefined ? { sessionId: d.sessionId } : {}),
      ...(input.acknowledgedUnsandboxed === true ? { acknowledgedUnsandboxed: true } : {}),
    };
    if (scope === "once") {
      try {
        return [grants.create({ ...base, scope: "once", match: { kind: "action" }, actionHash: b.actionHash }).id];
      } catch (e) {
        // A capability that takes no standing grant (ceiling null) is still approvable for this one call: the request itself is the single-use record.
        if (e instanceof GrantError && e.code === "ceiling-exceeded") return [];
        throw e;
      }
    }
    if (scope === "task" && d.taskId === undefined) throw new GrantError("invalid-grant", "a task grant needs a task id");
    if (scope === "session" && d.sessionId === undefined) throw new GrantError("invalid-grant", "a session grant needs a session id");
    const withScope = { ...base, scope };
    if (d.targets.length === 0) return [grants.create({ ...withScope, match: { kind: "capability" } }).id];
    // §8: narrowed to the call's own targets. Never from a masked or truncated list: that is not what the person was shown.
    if (d.targetsMasked) throw new GrantError("invalid-grant", "the targets were masked or truncated; only a once grant is possible");
    const access: "read" | "write" = d.access ?? (d.effect === "read" ? "read" : "write");
    const dirs = [...new Set(d.targets.map((t) => parentOf(t)))];
    if (dirs.some((x) => x === undefined)) throw new GrantError("invalid-grant", "a target has no directory to grant");
    return dirs.map((dir) => grants.create({ ...withScope, match: { kind: "path", path: dir!, access, recursive: false } }).id);
  }

  function decideCore(input: ServiceDecideInput): ServiceDecideResult {
    const refuse = (reason: ServiceDecideDenial): ServiceDecideResult => {
      recSoft("approval.refused", { person: input.person, requestId: input.requestId, decision: input.decision, ...(input.scope ? { scope: input.scope } : {}), decisionSurface: input.surface, reason });
      return { ok: false, reason };
    };
    let r: ApprovalRecord | undefined;
    try { r = store.get(input.requestId); } catch (e) { integrityFailure(e); failAll("the approval store failed its integrity check"); throw e; }
    if (!r || r.bound.principal !== input.person) return refuse("approval-mismatch");
    const scope: GrantScope = input.scope ?? "once";
    const d = r.detail as Partial<RequestDetail> | undefined;
    if (input.decision === "approve") {
      const def = CAPABILITIES.get(r.capability);
      if (!(GRANT_SCOPES as readonly string[]).includes(scope)) return refuse("scope-unavailable");
      if (!def || !d || typeof d.risk !== "string" || d.flags === undefined) return refuse("surface-untrusted"); // fail closed: no detail, no approval
      if (input.surface !== 1 && input.surface !== 2 && input.surface !== 3) return refuse("surface-untrusted");
      if (scopeRank(scope) > scopeRank(maxScopeFor(def, d.flags as never))) return refuse("scope-unavailable");
      if (!surfaceMayDecide({ capability: r.capability, risk: d.risk as never, flags: d.flags as never }, input.surface, scope)) return refuse("surface-untrusted");
    }
    let out: { res: ReturnType<ApprovalStore["decide"]>; grantIds: string[] };
    try {
      out = transaction(db, () => {
        const res = store.decide({
          requestId: input.requestId, nonce: input.nonce, decision: input.decision, person: input.person, surface: input.surface,
          ...(input.delegable === true ? { delegable: true } : {}),
        });
        if (!res.ok) return { res, grantIds: [] };
        const grantIds = input.decision === "approve" ? createGrants(r!, d as RequestDetail, input, scope) : [];
        rec("approval.decided", {
          person: input.person, requestId: input.requestId, decision: input.decision, ...(input.decision === "approve" ? { scope } : {}), decisionSurface: input.surface,
          capability: r!.capability, actionHash: r!.bound.actionHash, agentId: r!.bound.subject.id, subjectKind: r!.bound.subject.kind, taskId: r!.bound.taskId,
          sessionId: r!.bound.sessionId, ...(d?.tool ? { tool: d.tool } : {}), ...(d?.risk ? { risk: d.risk } : {}), ...(grantIds[0] ? { grantId: grantIds[0] } : {}),
        });
        return { res, grantIds };
      });
    } catch (e) {
      if (e instanceof GrantError) return refuse("scope-unavailable");
      if (e instanceof ApprovalChainError) { integrityFailure(e); failAll("the approval store failed its integrity check"); }
      throw e;
    }
    if (!out.res.ok) return refuse(out.res.reason);

    expiry.get(input.requestId)?.(); expiry.delete(input.requestId);
    const approved = out.res.status === "approved";
    waiters.get(input.requestId)?.finish(approved
      ? { approved: true, requestId: input.requestId, scope, grantIds: out.grantIds }
      : { approved: false, requestId: input.requestId, reason: "denied by the person" });
    const view = safeView(input.requestId);
    if (view) emit<Extract<ApprovalEvent, { name: "approval.resolved" }>>("approval.resolved", { approval: view, outcome: approved ? "approved" : "denied", ...(approved ? { scope, grantIds: out.grantIds } : {}) });
    for (const gid of out.grantIds) {
      const g = grants.get(gid);
      if (g) emit<Extract<ApprovalEvent, { name: "grant.changed" }>>("grant.changed", { change: "created", grantId: g.id, person: g.person, agent: g.agent, capability: g.capability, scope: g.scope });
    }
    return { ok: true, status: out.res.status, ...(approved ? { scope } : {}), grantIds: out.grantIds };
  }

  function failAll(reason: string): void {
    for (const [id, w] of [...waiters]) w.finish({ approved: false, reason, requestId: id });
  }

  // ---- execution start ----

  function begin(answer: ApprovalAnswer, ask: ApprovalAsk): boolean {
    if (!answer || answer.approved !== true || typeof answer.requestId !== "string") return false;
    const requestId = answer.requestId;
    try {
      return transaction(db, () => {
        const used = store.consume({ ...bindingOf(ask), requestId });
        if (!used.ok) throw new Refused(used.reason);
        for (const gid of answer.grantIds ?? []) {
          const g = grants.get(gid);
          if (!g || g.person !== ask.principal || g.agent !== ask.agentId) throw new Refused("grant-mismatch");
          if (g.scope === "once") {
            if (!grants.consumeOnce(gid, { person: ask.principal, agent: ask.agentId, actionHash: ask.request.actionHash })) throw new Refused("grant-used");
          } else grants.markUsed(gid);
        }
        rec("approval.consumed", auditFieldsOf(ask, { requestId, ...(answer.grantIds?.[0] ? { grantId: answer.grantIds[0] } : {}), ...(answer.scope ? { scope: answer.scope } : {}) }));
        return true;
      });
    } catch (e) {
      integrityFailure(e);
      recSoft("approval.refused", auditFieldsOf(ask, { requestId, reason: e instanceof Refused ? e.code : "error" }));
      return false;
    }
  }

  // ---- reads / cancel / verify ----

  function list(filter: { status?: ApprovalStatus; principal?: string; taskId?: string; sessionId?: string } = {}): ApprovalView[] {
    const rows = store.list({ ...(filter.status ? { status: filter.status } : {}), ...(filter.principal ? { principal: filter.principal } : {}) });
    return rows
      .filter((r) => (filter.taskId === undefined || r.bound.taskId === filter.taskId) && (filter.sessionId === undefined || r.bound.sessionId === filter.sessionId))
      .map(viewOf);
  }

  function get(id: string, principal?: string): ApprovalView | undefined {
    const r = store.get(id);
    if (!r || (principal !== undefined && r.bound.principal !== principal)) return undefined;
    return viewOf(r);
  }

  function cancel(input: { requestId: string; person: string; by?: string }): { ok: true } | { ok: false; reason: ApprovalDenial } {
    const r = store.get(input.requestId);
    if (!r || r.bound.principal !== input.person) return { ok: false, reason: "approval-mismatch" };
    const res = transaction(db, () => {
      const c = store.cancel(input.requestId, input.by ?? input.person);
      if (c.ok) rec("approval.cancelled", { person: input.person, requestId: input.requestId, by: input.by ?? input.person, capability: r.capability, actionHash: r.bound.actionHash });
      return c;
    });
    if (!res.ok) return res;
    expiry.get(input.requestId)?.(); expiry.delete(input.requestId);
    waiters.get(input.requestId)?.finish({ approved: false, reason: "cancelled", requestId: input.requestId });
    const view = safeView(input.requestId);
    if (view) emit<Extract<ApprovalEvent, { name: "approval.resolved" }>>("approval.resolved", { approval: view, outcome: "cancelled" });
    return { ok: true };
  }

  function verify(): VerifyResult {
    const v = store.verify();
    if (!v.ok) recSoft("approvals.integrity-failure", { brokenAt: v.brokenAt, failure: v.reason });
    return v;
  }

  // ---- dispatcher context ----

  function verifyHeld(held: readonly string[], handoffTaskId: string, person: string): { valid: string[]; rejected: { id: string; reason: HeldRejection }[] } {
    const valid: string[] = []; const rejected: { id: string; reason: HeldRejection }[] = [];
    for (const id of held) {
      const g = typeof id === "string" ? grants.get(id) : undefined;
      const reason: HeldRejection | null =
        !g ? "unknown" : g.revoked === true || g.consumedAt !== undefined ? "revoked" : g.person !== person ? "foreign-person"
        : g.delegable !== true ? "not-delegable" : g.taskId !== handoffTaskId ? "task-mismatch" : null;
      if (reason) rejected.push({ id: String(id), reason }); else valid.push(id);
    }
    return { valid, rejected };
  }

  function policyContext(inner?: (ctx: DispatchContext) => Partial<Context>): (ctx: DispatchContext) => Partial<Context> {
    return (ctx) => {
      const base = inner?.(ctx) ?? {};
      const key = taskKeyOf(base.taskId ?? ctx.taskId, base.sessionId ?? ctx.sessionId);
      const now = clock.now();
      const denied: string[] = [];
      let prompts = 0;
      try {
        for (const r of store.list({ principal: ctx.principal })) {
          if (r.bound.taskId !== key) continue;
          if (r.status === "denied") denied.push(r.bound.actionHash);
          if (r.createdAt > now - HOUR_MS) prompts += 1;
        }
      } catch (e) { integrityFailure(e); throw e; }
      const out: Partial<Context> = {
        ...base,
        deniedActionHashes: [...new Set([...(base.deniedActionHashes ?? []), ...denied])],
        promptsThisHour: Math.max(base.promptsThisHour ?? 0, prompts),
      };
      if (base.handoff) {
        const { valid, rejected } = verifyHeld(base.handoff.approvalsHeld, base.handoff.taskId, ctx.principal);
        if (rejected.length > 0) {
          rec("approvals.held-rejected", { person: ctx.principal, agentId: ctx.agentId, taskId: base.handoff.taskId, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), rejected });
        }
        out.handoff = { ...base.handoff, approvalsHeld: valid };
      }
      return out;
    };
  }

  function dispose(): void {
    for (const [id, w] of [...waiters]) w.finish({ approved: false, reason: "the approval service is shutting down", requestId: id });
    for (const cancelTimer of expiry.values()) cancelTimer();
    expiry.clear();
  }

  return {
    request, begin,
    decide: decideCore,
    decideForSession(input) {
      const row = db.prepare("SELECT nonce FROM approvals WHERE id = ?").get(input.requestId) as { nonce: string } | undefined;
      return decideCore({ ...input, nonce: row?.nonce ?? "" });
    },
    list, get, cancel, verify, policyContext, dispose,
  };
}
