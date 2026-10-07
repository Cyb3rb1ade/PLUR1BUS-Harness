import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createAuditChain, ACTIVE_NAME } from "../../src/audit/chain.ts";
import { ToolDispatcher, type DispatchContext } from "../../src/tools/dispatcher.ts";
import { ToolRegistry, type ToolDef } from "../../src/tools/registry.ts";
import type { Context, Grant } from "../../src/policy/index.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { rig as baseRig, lastNonce, raw, tick, MIN, HOUR, type Rig } from "../approvals/service-helpers.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { abs } from "../helpers/abs.ts";

const T = { timeout: 20_000 };
const SECRET_BODY = "TOP-SECRET-BODY-4711";

const readTool = (runs: unknown[]): ToolDef => ({
  name: "fs.read", description: "read a file", inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, note: { type: "string" } } },
  capability: "fs.read", effect: "read", risk: "low", trust: "first-party",
  classify: (a) => ({ targets: [(a as { path: string }).path], access: "read", flags: { outsideRoots: !(a as { path: string }).path.startsWith(abs("/work/")) } }),
  execute: async (a) => { runs.push(a); return { content: SECRET_BODY }; },
});
const payTool = (runs: unknown[]): ToolDef => ({
  name: "pay", description: "pay", inputSchema: { type: "object", additionalProperties: false, properties: { amount: { type: "number" } } },
  capability: "money.spend", effect: "money", risk: "critical", trust: "first-party", classify: () => ({ flags: { outsideRoots: true } }),
  execute: async (a) => { runs.push(a); return { paid: true }; },
});

interface Opts { ctx?: Partial<Context>; grants?: { list(q: { person: string; agent: string; capability: string }): readonly Grant[]; get(id: string): Grant | undefined }; noGrantUse?: boolean; auditSink?: Parameters<typeof createPolicyAudit>[0]["sink"] }

async function setup(o: Opts & { rigOpts?: Parameters<typeof baseRig>[0] } = {}) {
  const r = await baseRig(o.rigOpts);
  const runs: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register(readTool(runs));
  registry.register(payTool(runs));
  const audit = createPolicyAudit({ sink: o.auditSink ?? r.audit, clock: r.clock, host: "h" });
  const d = new ToolDispatcher({
    registry, approvals: r.service, grants: o.grants ?? r.stores.grants, ...(o.noGrantUse ? {} : { grantUse: r.stores.grants }), clock: r.clock, timers: r.timers, audit,
    policyContext: r.service.policyContext(() => o.ctx ?? {}),
  });
  const ctx = (c: Partial<DispatchContext> = {}): DispatchContext => ({ agentId: "bernd", principal: "christian", sessionId: "s1", taskId: "t1", surface: 3, signal: new AbortController().signal, ...c });
  let n = 0;
  const call = (name: string, args: unknown, c: Partial<DispatchContext> = {}) => d.call({ id: `c${++n}`, name, args }, ctx(c));
  const approve = (rr: Rig, o2: Record<string, unknown> = {}) => {
    const { id, nonce } = lastNonce(rr);
    return rr.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 3, ...o2 } as never);
  };
  return { r, d, runs, call, approve, ctx, registry };
}
const actions = (r: Rig) => r.audit.events.map((e) => e.action);

describe("dispatcher + approval service + grants (D109 D4)", () => {
  it("an outside-roots read asks, waits, runs after a once approval, and consumes approval and grant exactly once", T, async () => {
    const { r, call, approve, runs } = await setup();
    const p = call("fs.read", { path: abs("/outside/dir/a.txt") });
    await tick();
    assert.equal(runs.length, 0, "nothing runs while the request is open");
    assert.ok(approve(r).ok);
    const res = await p;
    assert.equal(res.isError, false);
    assert.equal(res.meta.decision, "approved");
    assert.equal(runs.length, 1);
    const { id } = lastNonce(r);
    assert.equal(r.stores.approvals.get(id)!.status, "used");
    assert.ok(r.stores.grants.inspect().every((v) => v.state === "consumed"));
    // the same call again needs a new approval: the once grant is spent
    const again = call("fs.read", { path: abs("/outside/dir/a.txt") });
    await tick();
    assert.equal(r.stores.approvals.list({ status: "pending" }).length, 1);
    r.service.dispose();
    assert.equal((await again).isError, true);
  });

  it("a denial refuses the call with tool-not-approved and runs nothing", T, async () => {
    const { r, call, runs } = await setup();
    const p = call("fs.read", { path: abs("/outside/dir/a.txt") });
    await tick();
    const { id, nonce } = lastNonce(r);
    r.service.decide({ requestId: id, nonce, decision: "deny", person: "christian", surface: 3 });
    const res = await p;
    assert.equal(res.isError && res.error.code, "tool-not-approved");
    assert.equal(res.meta.decision, "ask-refused");
    assert.equal(runs.length, 0);
  });

  it("a task grant from an approval lets the next call in that directory through without asking, and records the use", T, async () => {
    const { r, call, approve, runs } = await setup();
    const p = call("fs.read", { path: abs("/outside/dir/a.txt") });
    await tick();
    assert.ok(approve(r, { scope: "task" }).ok);
    assert.equal((await p).isError, false);
    const before = r.stores.approvals.list().length;
    const res = await call("fs.read", { path: abs("/outside/dir/b.txt") });
    assert.equal(res.isError, false);
    assert.equal(res.meta.decision, "allow");
    assert.equal(r.stores.approvals.list().length, before, "no second request");
    assert.equal(runs.length, 2);
    const g = r.stores.grants.inspect()[0]!.grant;
    assert.ok(g.lastUsedAt !== undefined, "markUsed ran");
    const dec = r.audit.events.filter((e) => e.action === "policy.decision").at(-1)!;
    assert.equal(dec.detail.outcome, "allowed");
    assert.equal(dec.detail.via, "grant");
    assert.equal(dec.detail.grantId, g.id);
    // another directory still asks
    const other = call("fs.read", { path: abs("/outside/other/c.txt") });
    await tick();
    assert.equal(r.stores.approvals.list({ status: "pending" }).length, 1);
    r.service.dispose();
    await other;
  });

  it("a once grant allows exactly one call: consumeOnce at execution start; a stale list cannot reuse it", T, async () => {
    const hashOf = async () => {
      const probe = await setup();
      const p = probe.call("fs.read", { path: abs("/outside/dir/a.txt") });
      await tick();
      const h = probe.r.service.list()[0]!.actionHash;
      probe.r.service.dispose(); await p;
      return h;
    };
    const actionHash = await hashOf();
    const s = await setup();
    const g = s.r.stores.grants.create({ capability: "fs.read", person: "christian", agent: "bernd", scope: "once", match: { kind: "action" }, actionHash, createdBy: "christian", surface: 3 });
    const snapshot = s.r.stores.grants.get(g.id)!; // what the evaluator saw before the first call consumed it
    const stale = { list: () => [snapshot] as readonly Grant[], get: (id: string) => s.r.stores.grants.get(id) };
    const s2 = await setupWith(s, stale);
    const first = await s2.call("fs.read", { path: abs("/outside/dir/a.txt") });
    assert.equal(first.isError, false);
    assert.equal(first.meta.decision, "allow");
    assert.equal(s.r.stores.grants.get(g.id)!.consumedAt !== undefined, true);
    // the evaluator still sees the grant (stale source) but the atomic consumption refuses it
    const second = await s2.call("fs.read", { path: abs("/outside/dir/a.txt") });
    assert.equal(second.isError && second.error.code, "tool-not-approved");
    assert.match(second.isError ? second.error.message : "", /already used|one-time|consum/i);
    assert.equal(s2.runs.length, 1);
    assert.ok(actions(s.r).includes("grant.consumed"));
  });

  it("a once grant without a way to consume it is refused (fail closed, never replayable)", T, async () => {
    const probe = await setup();
    const p = probe.call("fs.read", { path: abs("/outside/dir/a.txt") });
    await tick();
    const actionHash = probe.r.service.list()[0]!.actionHash;
    probe.r.service.dispose(); await p;
    const s = await setup({ noGrantUse: true });
    s.r.stores.grants.create({ capability: "fs.read", person: "christian", agent: "bernd", scope: "once", match: { kind: "action" }, actionHash, createdBy: "christian", surface: 3 });
    const res = await s.call("fs.read", { path: abs("/outside/dir/a.txt") });
    assert.equal(res.isError && res.error.code, "tool-not-approved");
    assert.equal(s.runs.length, 0);
  });

  it("an approved answer cannot be replayed: begin() refuses a second use of the same approval", T, async () => {
    const { r, call, approve, runs } = await setup();
    const p = call("fs.read", { path: abs("/outside/dir/a.txt") });
    await tick();
    approve(r);
    await p;
    assert.equal(runs.length, 1);
    const { id } = lastNonce(r);
    assert.equal(r.stores.approvals.consume({ actionHash: r.stores.approvals.get(id)!.bound.actionHash, principal: "christian", subject: { kind: "agent", id: "bernd" }, turnId: "c1", taskId: "t1", sessionId: "s1", requestId: id }).ok, false);
  });

  it("the foreground wait ends: the call returns not-approved (parked), the request stays open", T, async () => {
    const { r, call, runs } = await setup();
    const p = call("fs.read", { path: abs("/outside/dir/a.txt") });
    await tick();
    r.timers.advance(10 * MIN);
    const res = await p;
    assert.equal(res.isError && res.error.code, "tool-not-approved");
    assert.match(res.isError ? res.error.message : "", /parked|waiting/);
    assert.equal(runs.length, 0);
    assert.equal(r.stores.approvals.list({ status: "pending" }).length, 1);
  });

  it("an abort while waiting ends the call as aborted and cancels the request", T, async () => {
    const { r, call, runs } = await setup();
    const ac = new AbortController();
    const p = call("fs.read", { path: abs("/outside/dir/a.txt") }, { signal: ac.signal });
    await tick();
    ac.abort();
    const res = await p;
    assert.equal(res.isError && res.error.code, "aborted");
    assert.equal(runs.length, 0);
    assert.equal(r.stores.approvals.list()[0]!.status, "cancelled");
  });

  it("an action the person denied in this task is refused without asking again", T, async () => {
    const { r, call } = await setup();
    const p = call("fs.read", { path: abs("/outside/dir/a.txt") });
    await tick();
    const { id, nonce } = lastNonce(r);
    r.service.decide({ requestId: id, nonce, decision: "deny", person: "christian", surface: 3 });
    await p;
    const again = await call("fs.read", { path: abs("/outside/dir/a.txt") });
    assert.equal(again.isError && again.error.code, "tool-denied");
    assert.match(again.isError ? again.error.message : "", /repeat-denied/);
    assert.equal(r.stores.approvals.list().length, 1, "no second request");
    // a different task is not affected
    const other = call("fs.read", { path: abs("/outside/dir/a.txt") }, { taskId: "t2" });
    await tick();
    assert.equal(r.stores.approvals.list().length, 2);
    r.service.dispose();
    await other;
  });

  it("at 10 prompts per task per hour the next ask is refused, not queued", T, async () => {
    const { r, call } = await setup();
    const ps = Array.from({ length: 10 }, (_, i) => call("fs.read", { path: `/outside/dir/f${i}.txt` }));
    await tick();
    const eleventh = await call("fs.read", { path: abs("/outside/dir/f10.txt") });
    assert.equal(eleventh.isError && eleventh.error.code, "tool-denied");
    assert.match(eleventh.isError ? eleventh.error.message : "", /prompt-cap/);
    r.clock.advance(HOUR + MIN);
    const later = call("fs.read", { path: abs("/outside/dir/f11.txt") });
    await tick();
    assert.equal(r.stores.approvals.list({ status: "pending" }).length, 11);
    r.service.dispose();
    await Promise.all([...ps, later]);
  });

  it("money.spend needs T3: a T2 decision is refused and the call keeps waiting", T, async () => {
    const { r, call, runs } = await setup();
    const p = call("pay", { amount: 5 });
    await tick();
    const { id, nonce } = lastNonce(r);
    assert.deepEqual(r.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 2 }), { ok: false, reason: "surface-untrusted" });
    assert.equal(runs.length, 0);
    assert.ok(r.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 3 }).ok);
    assert.equal((await p).isError, false);
    assert.equal(runs.length, 1);
  });
});

describe("dispatcher: fail closed when the permission machinery fails", () => {
  it("a broken approval chain refuses the call (tool-denied), it does not run and does not throw", T, async () => {
    const { r, call, runs } = await setup();
    const p = call("fs.read", { path: abs("/outside/dir/a.txt") });
    await tick();
    r.service.dispose();
    await p;
    const db = raw(r.path);
    db.prepare("UPDATE approval_chain SET payload = payload || ' ' WHERE seq = 1").run();
    db.close();
    const res = await call("fs.read", { path: abs("/outside/dir/z.txt") });
    assert.equal(res.isError, true);
    assert.equal(runs.length, 0);
    assert.ok(actions(r).includes("approvals.integrity-failure"));
  });

  it("an audit trail that cannot be written refuses every call, allowed ones included", T, async () => {
    let down = false;
    const sink = { append() { if (down) throw new Error("audit down"); } };
    const { call, runs } = await setup({ auditSink: sink });
    assert.equal((await call("fs.read", { path: abs("/work/ok.txt") })).isError, false);
    down = true;
    const res = await call("fs.read", { path: abs("/work/ok.txt") });
    assert.equal(res.isError && res.error.code, "tool-denied");
    assert.match(res.isError ? res.error.message : "", /audit/);
    assert.equal(runs.length, 1);
  });
});

describe("dispatcher: authority.approvalsHeld in a hand-off (D104)", () => {
  const sub = (held: string[]): Partial<Context> => ({ subject: { kind: "subagent", agentId: "sub1" }, handoff: { scope: ["fs.read"], taskId: "t1", approvalsHeld: held } });

  it("a forged id is dropped and audited, the call asks; a delegable approval of the task lets the helper through", T, async () => {
    const forged = await setup({ ctx: sub(["grt_forged"]) });
    const p = forged.call("fs.read", { path: abs("/outside/dir/a.txt") });
    await tick();
    assert.equal(forged.r.stores.approvals.list({ status: "pending" }).length, 1, "the helper has to ask");
    const ev = forged.r.audit.events.find((e) => e.action === "approvals.held-rejected")!;
    assert.deepEqual(ev.detail.rejected, [{ id: "grt_forged", reason: "unknown" }]);
    forged.r.service.dispose();
    await p;

    const s = await setup();
    const g = s.r.stores.grants.create({ capability: "fs.read", person: "christian", agent: "bernd", scope: "task", taskId: "t1", match: { kind: "path", path: abs("/outside/dir"), access: "read", recursive: false }, createdBy: "christian", surface: 3, delegable: true });
    const helper = new ToolDispatcher({
      registry: s.registry, approvals: s.r.service, grants: s.r.stores.grants, grantUse: s.r.stores.grants, clock: s.r.clock, timers: s.r.timers,
      policyContext: s.r.service.policyContext(() => sub([g.id])),
    });
    const res = await helper.call({ id: "h1", name: "fs.read", args: { path: abs("/outside/dir/a.txt") } }, s.ctx());
    assert.equal(res.isError, false);
    assert.equal(res.meta.decision, "allow");
    assert.equal(s.r.audit.events.filter((e) => e.action === "approvals.held-rejected").length, 0);
  });

  it("a foreign person's grant id handed down is refused and audited", T, async () => {
    const s = await setup();
    const g = s.r.stores.grants.create({ capability: "fs.read", person: "mallory", agent: "bernd", scope: "task", taskId: "t1", match: { kind: "capability" }, createdBy: "mallory", surface: 3, delegable: true });
    const helper = new ToolDispatcher({
      registry: s.registry, approvals: s.r.service, grants: s.r.stores.grants, grantUse: s.r.stores.grants, clock: s.r.clock, timers: s.r.timers,
      policyContext: s.r.service.policyContext(() => sub([g.id])),
    });
    const p = helper.call({ id: "h1", name: "fs.read", args: { path: abs("/outside/dir/a.txt") } }, s.ctx());
    await tick();
    assert.equal(s.runs.length, 0);
    const ev = s.r.audit.events.find((e) => e.action === "approvals.held-rejected")!;
    assert.deepEqual(ev.detail.rejected, [{ id: g.id, reason: "foreign-person" }]);
    s.r.service.dispose();
    await p;
  });
});

describe("audit trail of the dispatcher (D109 §9, D9)", () => {
  it("every decision lands in the hash-chained audit file; no contents, no results, secrets masked; the chain verifies", T, async () => {
    const dir = tempDir("d109-audit-");
    const chain = createAuditChain({ dir });
    const { r, call, approve } = await setup({ auditSink: chain, rigOpts: { auditSink: chain } });
    const ghp = `ghp_${"A".repeat(36)}`;
    // allowed inside roots
    assert.equal((await call("fs.read", { path: abs("/work/in.txt"), note: SECRET_BODY })).isError, false);
    // asks outside roots, approved once; the path carries a token-shaped segment
    const p = call("fs.read", { path: `/outside/${ghp}/a.txt` });
    await tick();
    assert.ok(approve(r).ok);
    assert.equal((await p).isError, false);
    // never: unknown capability path -> a tool whose capability is denied by tools.deny
    const v = chain.verify();
    assert.equal(v.ok, true, JSON.stringify(v.findings));
    const raw = readFileSync(path.join(dir, ACTIVE_NAME), "utf8");
    assert.ok(!raw.includes(SECRET_BODY), "no tool argument or result content");
    assert.ok(!raw.includes(ghp), "secret-shaped value masked");
    const recs = raw.trim().split("\n").map((l) => (JSON.parse(l) as { rec: { action: string; actor: { user: string }; detail: Record<string, any> } }).rec);
    const acts = recs.map((x) => x.action);
    for (const a of ["policy.decision", "approval.requested", "approval.decided", "approval.consumed", "grant.created", "grant.consumed", "policy.outcome"]) assert.ok(acts.includes(a), `missing ${a}: ${acts.join(",")}`);
    const decisions = recs.filter((x) => x.action === "policy.decision");
    assert.deepEqual(decisions.map((x) => x.detail.outcome), ["allowed", "approval"]);
    const first = decisions[0]!.detail;
    assert.equal(first.person, "christian");
    assert.equal(first.agentId, "bernd");
    assert.equal(first.tool, "fs.read");
    assert.equal(first.surface, 3);
    assert.match(first.actionHash, /^[0-9a-f]{64}$/);
    assert.equal(typeof first.argsBytes, "number");
    const out = recs.filter((x) => x.action === "policy.outcome");
    assert.deepEqual(out.map((x) => x.detail.outcome), ["executed", "executed"]);
    assert.equal(typeof out[0]!.detail.resultBytes, "number");
  });

  it("a policy refusal is recorded as never, with the rule", T, async () => {
    const s = await setup({ ctx: { toolsDeny: ["fs.read"] } });
    const res = await s.call("fs.read", { path: abs("/work/x") });
    assert.equal(res.isError && res.error.code, "tool-denied");
    const dec = s.r.audit.events.find((e) => e.action === "policy.decision")!;
    assert.equal(dec.detail.outcome, "never");
    assert.equal(dec.detail.rule, "tools.deny");
    assert.equal(s.runs.length, 0);
  });

  it("a failed tool is recorded with its code and no message text", T, async () => {
    const r = await baseRig();
    const registry = new ToolRegistry();
    registry.register({ ...readTool([]), execute: async () => { throw new Error(`boom ${SECRET_BODY}`); } });
    const d = new ToolDispatcher({ registry, approvals: r.service, grants: r.stores.grants, grantUse: r.stores.grants, clock: r.clock, timers: r.timers, audit: createPolicyAudit({ sink: r.audit, clock: r.clock, host: "h" }) });
    const res = await d.call({ id: "x", name: "fs.read", args: { path: abs("/work/a") } }, { agentId: "bernd", principal: "christian", surface: 3, signal: new AbortController().signal });
    assert.equal(res.isError && res.error.code, "tool-failed");
    const out = r.audit.events.find((e) => e.action === "policy.outcome")!;
    assert.equal(out.detail.outcome, "failed");
    assert.equal(out.detail.resultCode, "tool-failed");
    assert.ok(!JSON.stringify(r.audit.events).includes(SECRET_BODY));
  });
});

async function setupWith(s: Awaited<ReturnType<typeof setup>>, grants: { list: (q: { person: string; agent: string; capability: string }) => readonly Grant[]; get(id: string): Grant | undefined }) {
  const runs: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register(readTool(runs));
  const d = new ToolDispatcher({
    registry, approvals: s.r.service, grants, grantUse: s.r.stores.grants, clock: s.r.clock, timers: s.r.timers,
    audit: createPolicyAudit({ sink: s.r.audit, clock: s.r.clock, host: "h" }), policyContext: s.r.service.policyContext(),
  });
  let n = 100;
  return { runs, call: (name: string, args: unknown) => d.call({ id: `x${++n}`, name, args }, s.ctx()) };
}
