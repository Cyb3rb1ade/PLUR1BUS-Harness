import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { headlessGate } from "../../src/policy/headless.ts";
import type { Decision } from "../../src/policy/index.ts";
import { ToolDispatcher, type DispatchContext } from "../../src/tools/dispatcher.ts";
import { ToolRegistry, type ToolDef } from "../../src/tools/registry.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { DAY, rig as baseRig, tick } from "../approvals/service-helpers.ts";
import type { Context } from "../../src/policy/index.ts";

const T = { timeout: 20_000 };

const ask: Decision = {
  kind: "ask", park: true, why: "approval-class",
  request: { capability: "fs.read", tool: "fs.read", effect: "read", flags: { outsideRoots: true, denyListHit: false }, risk: "low", reversible: true, actionHash: "h", grantOptions: [], requiredSurface: 1, tainted: false, taintSuspended: false, originSurface: 3 },
};

describe("headlessGate (D109 §9, D5)", () => {
  it("turns an ask of a headless run into a refusal: nothing is asked, nothing parks", () => {
    const d = headlessGate(ask, { headless: { jobId: "job1" } });
    assert.deepEqual(d, { kind: "deny", reason: "policy-never", rule: "headless:no-job-grant" });
  });
  it("leaves allow and deny alone, and an interactive ask alone", () => {
    const allow: Decision = { kind: "allow", via: "default" };
    const deny: Decision = { kind: "deny", reason: "deny-list", rule: "deny-list" };
    assert.equal(headlessGate(allow, { headless: { jobId: "j" } }), allow);
    assert.equal(headlessGate(deny, { headless: { jobId: "j" } }), deny);
    assert.equal(headlessGate({ ...ask, park: false }, {}).kind, "ask");
  });
  it("a headless ask is refused even if the evaluator did not flag it (park false but a job is set)", () => {
    assert.equal(headlessGate({ ...ask, park: false }, { headless: { jobId: "j" } }).kind, "deny");
  });
});

const readTool = (runs: unknown[]): ToolDef => ({
  name: "fs.read", description: "read", inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } },
  capability: "fs.read", effect: "read", risk: "low", trust: "first-party",
  classify: (a) => ({ targets: [(a as { path: string }).path], access: "read", flags: { outsideRoots: !(a as { path: string }).path.startsWith("/work/") } }),
  execute: async (a) => { runs.push(a); return { ok: true }; },
});

async function jobRig(headless: Context["headless"]) {
  const r = await baseRig();
  const runs: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register(readTool(runs));
  const d = new ToolDispatcher({
    registry, approvals: r.service, grants: r.stores.grants, grantUse: r.stores.grants, clock: r.clock, timers: r.timers,
    audit: createPolicyAudit({ sink: r.audit, clock: r.clock, host: "h" }),
    policyContext: r.service.policyContext(() => (headless ? { headless } : {})),
  });
  const ctx: DispatchContext = { agentId: "bernd", principal: "christian", sessionId: "s1", taskId: "t1", surface: 3, signal: new AbortController().signal };
  const read = (path: string) => d.call({ id: `c${Math.random()}`, name: "fs.read", args: { path } }, ctx);
  const dirGrant = { capability: "fs.read", person: "christian", agent: "bernd", match: { kind: "path" as const, path: "/outside/dir", access: "read" as const, recursive: false }, createdBy: "christian", surface: 3 as const };
  return { r, runs, read, dirGrant };
}

describe("headless jobs use only standing grants created for that job (D109 §9, D5)", () => {
  it("the requester's session, task and ordinary standing grants do not carry over: refused at once, no prompt, no park", T, async () => {
    const { r, read, runs, dirGrant } = await jobRig({ jobId: "job1" });
    r.stores.grants.create({ ...dirGrant, scope: "session", sessionId: "s1" });
    r.stores.grants.create({ ...dirGrant, scope: "task", taskId: "t1" });
    r.stores.grants.create({ ...dirGrant, scope: "always" });
    r.stores.grants.create({ ...dirGrant, scope: "always", jobId: "job2" });
    let settled = false;
    const p = read("/outside/dir/a.txt").then((x) => { settled = true; return x; });
    await tick();
    assert.equal(settled, true, "no waiting");
    const res = await p;
    assert.equal(res.isError && res.error.code, "tool-denied");
    assert.match(res.isError ? res.error.message : "", /headless:no-job-grant/);
    assert.equal(runs.length, 0);
    assert.equal(r.stores.approvals.list().length, 0, "no request, so nothing to notify or park");
    assert.equal(r.events.length, 0);
    assert.equal(r.timers.pending, 0);
    const dec = r.audit.events.find((e) => e.action === "policy.decision")!;
    assert.equal(dec.detail.outcome, "never");
    assert.equal(dec.detail.rule, "headless:no-job-grant");
    assert.equal(dec.detail.jobId, "job1");
  });

  it("a standing grant created for this job lets the call run, and records the use", T, async () => {
    const { r, read, runs, dirGrant } = await jobRig({ jobId: "job1" });
    const g = r.stores.grants.create({ ...dirGrant, scope: "always", jobId: "job1" });
    const res = await read("/outside/dir/a.txt");
    assert.equal(res.isError, false);
    assert.equal(res.meta.decision, "allow");
    assert.equal(runs.length, 1);
    assert.ok(r.stores.grants.get(g.id)!.lastUsedAt !== undefined);
    // the grant is for that directory only
    assert.equal((await read("/outside/other/b.txt")).isError, true);
    assert.equal(runs.length, 1);
  });

  it("a job grant past its own expiry no longer counts", T, async () => {
    const { r, read, dirGrant } = await jobRig({ jobId: "job1" });
    r.stores.grants.create({ ...dirGrant, scope: "always", jobId: "job1", expiresAt: r.clock.t + DAY });
    assert.equal((await read("/outside/dir/a.txt")).isError, false);
    r.clock.advance(DAY + 1);
    assert.equal((await read("/outside/dir/a.txt")).isError, true);
  });

  it("a job grant never applies in an interactive session: the call asks", T, async () => {
    const { r, read, dirGrant } = await jobRig(undefined);
    r.stores.grants.create({ ...dirGrant, scope: "always", jobId: "job1" });
    const p = read("/outside/dir/a.txt");
    await tick();
    assert.equal(r.stores.approvals.list({ status: "pending" }).length, 1);
    r.service.dispose();
    await p;
  });

  it("calls that need no approval (inside the roots) still run headless", T, async () => {
    const { read, runs } = await jobRig({ jobId: "job1" });
    assert.equal((await read("/work/in.txt")).isError, false);
    assert.equal(runs.length, 1);
  });

  it("an `ask` that is never answered cannot be approved by silence: no timer decides anything for a headless call", T, async () => {
    const { r, read } = await jobRig({ jobId: "job1" });
    const res = await read("/outside/dir/a.txt");
    r.timers.advance(2 * DAY);
    assert.equal(res.isError, true);
    assert.equal(r.stores.grants.inspect().length, 0);
  });
});
