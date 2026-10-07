// Rows: agents cannot reach the permission model (grant.* / approval.* over the real RBAC guard and handlers, tools named like them),
// headless runs (no grant = refusal without waiting; only job-bound standing grants count), and the hand-off `approvalsHeld`
// references (forged, foreign, not delegable, other task, revoked).
import { guardMethods, RPC_RULES } from "../../src/rbac/guard.ts";
import { GrantError } from "../../src/grants/store.ts";
import type { CallContext } from "../../src/rpc/server.ts";
import { AGENT_PRINCIPAL, PERSON, rpcRig, type RpcRig } from "../approvals/rpc-helpers.ts";
import path from "node:path";
import { codeOf, type E2ERow, type Verdict, type World } from "./permission-eval-e2e.fixtures.ts";
import type { Principal } from "../../src/rbac/types.ts";

const WRITE = { content: "x" };

// ---- agent principals vs the eight methods ----

const METHODS = ["grant.list", "grant.create", "grant.revoke", "approval.list", "approval.get", "approval.verify", "approval.decide", "approval.cancel"] as const;
type Method = (typeof METHODS)[number];
const RPC_CTX: CallContext = { requestId: "1", connectionId: "c1", signal: new AbortController().signal };

interface RpcWorld { rr: RpcRig; opened: { n: number }; guarded: ReturnType<typeof guardMethods>; params: Record<Method, unknown>; pendingId: string; snapshot(): string }

async function rpcWorld(): Promise<RpcWorld> {
  const opened = { n: 0 };
  let rr!: RpcRig;
  rr = await rpcRig({ deps: { permissions: async () => { opened.n++; return { service: rr.service, grants: rr.stores.grants }; } } });
  const parked = await rr.park();
  const g = rr.stores.grants.create({ capability: "fs.write", person: "christian", agent: "bernd", scope: "always", match: { kind: "capability" }, createdBy: "christian", surface: 3 });
  opened.n = 0; // setup went around the handlers
  const guarded = guardMethods(rr.methods, { resolve: () => rr.who, now: () => rr.clock.now() });
  const params: Record<Method, unknown> = {
    "grant.list": {}, "grant.create": { capability: "fs.write", agent: "bernd", scope: "always" }, "grant.revoke": { id: g.id },
    "approval.list": {}, "approval.get": { id: parked.id }, "approval.verify": {}, "approval.decide": { id: parked.id, decision: "approve" }, "approval.cancel": { id: parked.id },
  };
  const snapshot = (): string => JSON.stringify([rr.stores.chain.verify(), rr.stores.grants.inspect().map((v) => [v.grant.id, v.state]), rr.stores.approvals.list().map((a) => [a.id, a.status])]);
  return { rr, opened, guarded, params, pendingId: parked.id, snapshot };
}

const outcome = async (h: ((p: unknown, c: CallContext) => Promise<unknown>) | undefined, p: unknown): Promise<string> => {
  try { await h!(p, RPC_CTX); return "resolved"; } catch (e) { const x = e as { error?: string; reason?: string }; return `${x.error ?? "throw"}:${x.reason ?? "-"}`; }
};

/** The attacker's principal calls `method` through the guard AND straight at the handler; nothing may resolve, open a store or change state. */
async function asAgent(method: Method, who: Principal | null): Promise<Verdict> {
  const x = await rpcWorld();
  try {
    const before = x.snapshot();
    x.rr.who = who;
    const viaGuard = await outcome(x.guarded[method], x.params[method]);
    const direct = await outcome(x.rr.methods[method], x.params[method]);
    const changed = x.snapshot() !== before || x.opened.n !== 0;
    return { done: viaGuard === "resolved" || direct === "resolved" || changed, code: changed ? "state-changed" : `${viaGuard}|${direct}` };
  } finally { x.rr.service.dispose(); x.rr.stores.close(); }
}
async function asPerson(method: Method): Promise<Verdict> {
  const x = await rpcWorld();
  try {
    x.rr.who = PERSON;
    const r = await outcome(x.guarded[method], x.params[method]);
    return { done: r === "resolved", code: r };
  } finally { x.rr.service.dispose(); x.rr.stores.close(); }
}

const AGENT_DENIED = "E_DENIED:agent-principal|E_DENIED:agent-principal";
const agentRows: E2ERow[] = METHODS.map((m) => ({
  id: `agent-rpc-${m}`, group: "agent-rpc", what: `an agent principal (role owner) cannot call ${m}, over the guard or the bare handler`, expect: AGENT_DENIED,
  attack: () => asAgent(m, AGENT_PRINCIPAL), benign: () => asPerson(m),
}));

export const AGENT_ROWS: E2ERow[] = [
  ...agentRows,
  {
    id: "agent-rpc-principal-without-kind", group: "agent-rpc", what: "a principal that does not say it is a person is treated as an agent (decide, create)", expect: AGENT_DENIED,
    attack: async () => {
      const a = await asAgent("approval.decide", { userId: "christian", role: "owner" } as Principal);
      const b = await asAgent("grant.create", { userId: "christian", role: "owner" } as Principal);
      return { done: a.done || b.done, code: a.code === b.code ? a.code : `${a.code} / ${b.code}` };
    },
  },
  {
    id: "agent-rpc-unauthenticated", group: "agent-rpc", what: "no principal at all is refused before any handler runs", expect: "E_UNAUTHORIZED:no-principal|E_UNAUTHORIZED:no-principal",
    attack: () => asAgent("approval.decide", null),
  },
  {
    id: "agent-tool-named-grant-create", group: "agent-rpc", what: "a tool called grant.create is never allowed (harness.admin = never), not even with an override or a token scope", expect: "denied:never",
    attack: async (w) => {
      const r1 = await w.probeCall("grant.create", { capability: "fs.write" });
      w.policy = { overrides: { "harness.admin": "allowed" }, tokenScopes: ["harness.admin"] };
      const r2 = await w.probeCall("grant.create", { capability: "fs.write" });
      return { done: r1.done || r2.done, code: r1.code === r2.code ? r1.code : `${r1.code}/${r2.code}` };
    },
    benign: (w) => w.probe("fs.read", w.f.wsA),
  },
  {
    id: "agent-tool-named-approval-decide", group: "agent-rpc", what: "a tool called approval.decide is never allowed", expect: "denied:never",
    attack: (w) => w.probeCall("approval.decide", { id: "apr_x", decision: "approve" }, { surface: 3 }),
    benign: (w) => w.probe("fs.read", w.f.wsA),
  },
  {
    id: "agent-grant-for-never-capability", group: "agent-rpc", what: "no grant can exist for a never capability (store level)", expect: "never-capability",
    attack: async (w) => {
      try {
        w.r.stores.grants.create({ capability: "harness.admin", person: "christian", agent: "bernd", scope: "always", match: { kind: "capability" }, createdBy: "christian", surface: 3 });
        return { done: true, code: "created" };
      } catch (e) { return { done: false, code: e instanceof GrantError ? e.code : "throw" }; }
    },
    benign: async (w) => { w.grant({ dir: w.f.other }); return { done: w.r.stores.grants.inspect().length === 1, code: "created" }; },
  },
];

// ---- headless ----

const JOB = { headless: { jobId: "j1" } };
const noWait = (w: World): boolean => w.r.timers.pending === 0 && w.r.stores.approvals.list().length === 0;

export const HEADLESS_ROWS: E2ERow[] = [
  {
    id: "headless-no-grant-refused-at-once", group: "headless", what: "an unattended run without a job grant is refused immediately: no request, no timer, no wait", expect: "denied:headless:no-job-grant",
    attack: async (w) => {
      w.policy = JOB;
      const v = await w.probe("fs.write", w.f.otherB, WRITE);
      return noWait(w) ? v : { done: true, code: "waited" };
    },
    benign: async (w) => { w.policy = JOB; return w.probe("fs.read", w.f.wsA); },
  },
  {
    id: "headless-job-grant-of-another-job", group: "headless", what: "a job cannot use another job's standing grant", expect: "denied:headless:no-job-grant",
    attack: async (w) => { w.grant({ dir: w.f.other, jobId: "j2" }); w.policy = JOB; return w.probe("fs.write", w.f.otherB, WRITE); },
    benign: async (w) => { w.grant({ dir: w.f.other, jobId: "j1" }); w.policy = JOB; return w.probe("fs.write", w.f.otherB, WRITE); },
  },
  {
    id: "headless-job-grant-other-folder", group: "headless", what: "a job grant covers its folder only", expect: "denied:headless:no-job-grant",
    attack: async (w) => { w.grant({ dir: w.f.other, jobId: "j1" }); w.policy = JOB; return w.probe("fs.write", w.f.appJson, WRITE); },
    benign: async (w) => { w.grant({ dir: w.f.other, jobId: "j1" }); w.policy = JOB; return w.probe("fs.write", w.f.otherB, WRITE); },
  },
  {
    id: "headless-session-grant-does-not-carry", group: "headless", what: "the creator's session grant does not carry over to the job", expect: "denied:headless:no-job-grant",
    attack: async (w) => { w.grant({ dir: w.f.other, scope: "session" }); w.policy = JOB; return w.probe("fs.write", w.f.otherB, WRITE); },
    benign: async (w) => { w.grant({ dir: w.f.other, scope: "session" }); return w.probe("fs.write", w.f.otherB, WRITE); },
  },
  {
    id: "headless-task-grant-does-not-carry", group: "headless", what: "the creator's task grant does not carry over to the job", expect: "denied:headless:no-job-grant",
    attack: async (w) => { w.grant({ dir: w.f.other, scope: "task" }); w.policy = JOB; return w.probe("fs.write", w.f.otherB, WRITE); },
    benign: async (w) => { w.grant({ dir: w.f.other, scope: "task" }); return w.probe("fs.write", w.f.otherB, WRITE); },
  },
  {
    id: "headless-owner-always-grant-does-not-carry", group: "headless", what: "the owner's own standing (always) grant is not a job grant", expect: "denied:headless:no-job-grant",
    attack: async (w) => { w.grant({ dir: w.f.other }); w.policy = JOB; return w.probe("fs.write", w.f.otherB, WRITE); },
    benign: async (w) => { w.grant({ dir: w.f.other }); return w.probe("fs.write", w.f.otherB, WRITE); },
  },
  {
    id: "job-grant-not-usable-interactively", group: "headless", what: "a grant made for a job is not usable in an interactive session", expect: "pending",
    attack: async (w) => { w.grant({ dir: w.f.other, jobId: "j1" }); return w.probe("fs.write", w.f.otherB, WRITE); },
    benign: async (w) => { w.grant({ dir: w.f.other, jobId: "j1" }); w.policy = JOB; return w.probe("fs.write", w.f.otherB, WRITE); },
  },
];

// ---- hand-off: approvalsHeld ----

/** The sub-agent `sub` of `bernd`'s task t1 references `ids`. */
function asSub(w: World, ids: string[]): void {
  w.policy = { subject: { kind: "subagent", agentId: "sub" }, handoff: { scope: ["fs.write"], taskId: "t1", approvalsHeld: ids } };
}
const heldReason = (w: World): string => {
  const e = [...w.audit].reverse().find((x) => x.action === "approvals.held-rejected");
  const rows = e?.detail.rejected as { reason: string }[] | undefined;
  return rows?.[0]?.reason ?? "none";
};
const subWrite = async (w: World, ids: string[]): Promise<Verdict> => {
  asSub(w, ids);
  const v = await w.probe("fs.write", w.f.otherB, WRITE, { agentId: "sub" });
  return { ...v, code: `${v.code}+${heldReason(w)}` };
};
/** Benign twin of every hand-off row: the genuinely delegable task grant of the same task. */
const validHeld = async (w: World): Promise<Verdict> => {
  const g = w.grant({ dir: w.f.other, scope: "task", delegable: true });
  return subWrite(w, [g.id]);
};
const heldRow = (id: string, what: string, expect: string, setup: (w: World) => string): E2ERow => ({
  id, group: "handoff", what, expect, attack: (w) => subWrite(w, [setup(w)]), benign: validHeld,
});

export const HANDOFF_ROWS: E2ERow[] = [
  heldRow("handoff-forged-id", "a hand-off references a grant id that does not exist", "pending+unknown", () => "grt_0123456789abcdef01234567"),
  heldRow("handoff-injection-id", "a hand-off id built to break a query resolves to nothing", "pending+unknown", () => "x' OR '1'='1"),
  heldRow("handoff-foreign-person", "a hand-off references another person's delegable grant", "pending+foreign-person", (w) => w.grant({ dir: w.f.other, scope: "task", delegable: true, person: "anna" }).id),
  heldRow("handoff-not-delegable", "a hand-off references a grant the person did not mark delegable", "pending+not-delegable", (w) => w.grant({ dir: w.f.other, scope: "task", delegable: false }).id),
  heldRow("handoff-other-task", "a hand-off references a delegable grant of another task", "pending+task-mismatch", (w) => w.grant({ dir: w.f.other, scope: "task", delegable: true, taskId: "t9" }).id),
  heldRow("handoff-revoked", "a hand-off references a grant the person revoked", "pending+revoked", (w) => {
    const g = w.grant({ dir: w.f.other, scope: "task", delegable: true });
    w.r.stores.grants.revoke(g.id, "christian");
    return g.id;
  }),
  {
    id: "handoff-callers-grant-does-not-flow", group: "handoff", what: "the caller's own (not delegable) grant never flows to the sub-agent", expect: "pending+none",
    attack: async (w) => { w.grant({ dir: w.f.other, scope: "task" }); return subWrite(w, []); },
    benign: validHeld,
  },
  {
    id: "handoff-scope-limits-the-subagent", group: "handoff", what: "a sub-agent cannot use a capability outside its hand-off scope, even inside the roots", expect: "denied:handoff-scope+none",
    attack: async (w) => { asSub(w, []); const v = await w.probe("fs.read", w.f.wsA, {}, { agentId: "sub" }); return { ...v, code: `${v.code}+${heldReason(w)}` }; },
    benign: async (w) => { asSub(w, []); return w.probe("fs.write", path.join(w.f.ws, "sub-new.txt"), WRITE, { agentId: "sub" }); },
  },
];
