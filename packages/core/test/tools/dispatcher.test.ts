import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolDispatcher, canonicalJson, type DispatchContext, type Timers } from "../../src/tools/dispatcher.ts";
import type { ApprovalAsk, ApprovalPort } from "../../src/tools/approval.ts";
import { ToolRegistry, type ToolDef } from "../../src/tools/registry.ts";
import type { Context, Grant } from "../../src/policy/index.ts";

const schema = { type: "object", additionalProperties: false, required: ["q"], properties: { q: { type: "string", maxLength: 20 } } };
const base = (o: Partial<ToolDef> = {}): ToolDef => ({
  name: "demo.echo", description: "echo", inputSchema: schema, capability: "sys.read", effect: "read", risk: "low",
  trust: "operator-vetted", execute: async (a) => ({ echoed: (a as { q: string }).q }), ...o,
});

/** Manual timers: nothing sleeps; a test fires them. */
function fakeTimers() {
  const pending = new Map<number, () => void>(); let n = 0;
  const timers: Timers = { set(fn) { const id = ++n; pending.set(id, fn); return () => void pending.delete(id); } };
  return { timers, fire: () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } }, count: () => pending.size };
}
const NOGRANTS = { list: () => [] as readonly Grant[], get: () => undefined };
const CTX: DispatchContext = { agentId: "bernd", principal: "user:v1:o", sessionId: "s1", surface: 3, signal: new AbortController().signal };

function rig(tools: ToolDef[], o: { approve?: (a: ApprovalAsk) => Promise<{ approved: boolean; reason?: string }>; policyContext?: Partial<Context>; repair?: never } = {}) {
  const registry = new ToolRegistry(); for (const t of tools) registry.register(t);
  const asks: ApprovalAsk[] = [];
  const approvals: ApprovalPort = { async request(a) { asks.push(a); return o.approve ? o.approve(a) : { approved: false }; } };
  const t = fakeTimers(); let clock = 1000;
  const d = new ToolDispatcher({ registry, approvals, grants: NOGRANTS, clock: { now: () => (clock += 5) }, timers: t.timers, ...(o.policyContext ? { policyContext: () => o.policyContext! } : {}) });
  return { d, asks, t, registry };
}
const call = (name: string, args: unknown, id = "c1") => ({ id, name, args });

function assertProvenance(r: { provenance: { origin: { system: string; principal: string; agent: string | null; trust: string }; hops: number; transformedBy: string[] } }, system?: RegExp) {
  assert.equal(r.provenance.origin.principal, "user:v1:o");
  assert.ok(r.provenance.hops >= 1); assert.ok(Array.isArray(r.provenance.transformedBy));
  assert.ok(["first-party", "operator-vetted", "untrusted"].includes(r.provenance.origin.trust));
  if (system) assert.match(r.provenance.origin.system, system);
}

describe("ToolDispatcher", () => {
  it("runs an allowed tool: result, provenance (D19) and meta", async () => {
    const { d, asks } = rig([base()]);
    const r = await d.call(call("demo.echo", { q: "hi" }), CTX);
    assert.equal(r.isError, false); assert.deepEqual(r.isError ? null : r.value, { echoed: "hi" });
    assert.equal(r.callId, "c1"); assert.equal(r.tool, "demo.echo");
    assertProvenance(r, /^tool:demo\.echo$/);
    assert.equal(r.provenance.origin.agent, "bernd"); assert.equal(r.provenance.origin.trust, "operator-vetted");
    assert.equal(r.meta.decision, "allow"); assert.ok(r.meta.durationMs >= 0); assert.ok(r.meta.bytes > 0);
    assert.equal(asks.length, 0);
  });

  it("unknown tool: typed error, provenance from the harness, nothing run", async () => {
    const { d } = rig([base()]);
    const r = await d.call(call("nope", {}), CTX);
    assert.ok(r.isError); assert.equal(r.isError && r.error.code, "tool-unknown");
    assertProvenance(r, /^harness:tools$/);
  });

  it("invalid arguments: not executed, not gated, structured issues; one optional repair round", async () => {
    let ran = 0;
    const { d, asks } = rig([base({ execute: async () => { ran++; return 1; } })]);
    for (const bad of [{}, { q: 5 }, { q: "x", extra: 1 }, { q: "x".repeat(21) }, "str", null]) {
      const r = await d.call(call("demo.echo", bad), CTX);
      assert.ok(r.isError); assert.equal(r.isError && r.error.code, "tool-call-invalid");
      assert.ok(r.isError && (r.error.issues?.length ?? 0) > 0); assertProvenance(r);
    }
    assert.equal(ran, 0); assert.equal(asks.length, 0);
    // repair: one round, then validated again
    const registry = new ToolRegistry(); registry.register(base());
    const repairs: unknown[] = [];
    const dr = new ToolDispatcher({ registry, approvals: { request: async () => ({ approved: false }) }, grants: NOGRANTS, clock: { now: () => 1 }, timers: fakeTimers().timers,
      repair: async (req) => { repairs.push(req.message); return { q: "fixed" }; } });
    const ok = await dr.call(call("demo.echo", { q: 1 }), CTX);
    assert.equal(repairs.length, 1); assert.deepEqual(!ok.isError && ok.value, { echoed: "fixed" });
    const dr2 = new ToolDispatcher({ registry, approvals: { request: async () => ({ approved: false }) }, grants: NOGRANTS, clock: { now: () => 1 }, timers: fakeTimers().timers, repair: async () => ({ q: 2 }) });
    const still = await dr2.call(call("demo.echo", { q: 1 }), CTX);
    assert.ok(still.isError && still.error.code === "tool-call-invalid");
  });

  it("oversized arguments are refused before validation", async () => {
    const { d } = rig([base({ inputSchema: { type: "object", properties: { q: { type: "string" } } } })]);
    const r = await d.call(call("demo.echo", { q: "x".repeat(300 * 1024) }), CTX);
    assert.ok(r.isError && r.error.code === "tool-call-invalid"); assertProvenance(r);
  });

  it("result over the byte limit: tool-result-too-large, no partial value", async () => {
    const { d } = rig([base({ limits: { maxResultBytes: 50 }, execute: async () => ({ blob: "y".repeat(500) }) })]);
    const r = await d.call(call("demo.echo", { q: "a" }), CTX);
    assert.ok(r.isError && r.error.code === "tool-result-too-large"); assert.ok(!("value" in r)); assertProvenance(r, /^tool:demo\.echo$/);
    assert.equal(r.provenance.transformedBy.includes("truncate"), false);
  });

  it("an unserialisable result is an error, not a crash", async () => {
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    const { d } = rig([base({ execute: async () => cyc })]);
    const r = await d.call(call("demo.echo", { q: "a" }), CTX);
    assert.ok(r.isError && r.error.code === "tool-result-invalid");
  });

  it("timeout: the signal is aborted, a tool that ignores it is abandoned", async () => {
    let seen: AbortSignal | undefined;
    const { d, t } = rig([base({ execute: (_a, c) => { seen = c.signal; return new Promise(() => {}); } })]);
    const p = d.call(call("demo.echo", { q: "a" }), CTX);
    await new Promise((r) => setImmediate(r)); t.fire();
    const r = await p;
    assert.ok(r.isError && r.error.code === "tool-timeout"); assert.equal(seen?.aborted, true); assertProvenance(r, /^tool:/);
    assert.equal(t.count(), 0, "no timer left behind");
  });

  it("caller abort: during execution and before it", async () => {
    const ac = new AbortController();
    const { d } = rig([base({ execute: (_a, c) => new Promise((_res, rej) => c.signal.addEventListener("abort", () => rej(new Error("stopped")))) })]);
    const p = d.call(call("demo.echo", { q: "a" }), { ...CTX, signal: ac.signal });
    await new Promise((r) => setImmediate(r)); ac.abort();
    const r = await p; assert.ok(r.isError && r.error.code === "aborted"); assertProvenance(r);
    let ran = 0;
    const r2 = rig([base({ execute: async () => { ran++; return 1; } })]);
    const pre = new AbortController(); pre.abort();
    const rr = await r2.d.call(call("demo.echo", { q: "a" }), { ...CTX, signal: pre.signal });
    assert.ok(rr.isError && rr.error.code === "aborted"); assert.equal(ran, 0);
  });

  it("a throwing tool becomes tool-failed", async () => {
    const { d } = rig([base({ execute: async () => { throw new Error("boom"); } })]);
    const r = await d.call(call("demo.echo", { q: "a" }), CTX);
    assert.ok(r.isError && r.error.code === "tool-failed" && /boom/.test(r.error.message));
  });

  it("policy deny: tools.deny and unknown-capability style refusals never reach the tool or the person", async () => {
    let ran = 0;
    const { d, asks } = rig([base({ execute: async () => { ran++; return 1; } })], { policyContext: { toolsDeny: ["demo.echo"] } });
    const r = await d.call(call("demo.echo", { q: "a" }), CTX);
    assert.ok(r.isError && r.error.code === "tool-denied"); assert.equal(r.meta.decision, "deny"); assertProvenance(r, /^harness:tools$/);
    assert.equal(ran, 0); assert.equal(asks.length, 0);
  });

  const ask = (o: Partial<ToolDef> = {}) => base({ name: "demo.net", capability: "net.submit", effect: "external", risk: "medium", ...o });

  it("policy ask → ApprovalPort; approved runs the tool and the ask carries the action hash and call details", async () => {
    const { d, asks } = rig([ask()], { approve: async () => ({ approved: true }) });
    const r = await d.call(call("demo.net", { q: "a" }), CTX);
    assert.ok(!r.isError, JSON.stringify(r)); assert.equal(r.meta.decision, "approved");
    assert.equal(asks.length, 1); assert.equal(asks[0]!.tool, "demo.net"); assert.equal(asks[0]!.request.capability, "net.submit");
    assert.match(asks[0]!.request.actionHash, /^[0-9a-f]{64}$/); assert.deepEqual(asks[0]!.args, { q: "a" });
    assert.equal(asks[0]!.principal, "user:v1:o");
  });

  it("the action hash is stable across key order and differs across arguments", async () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    const hashes: string[] = [];
    const { d } = rig([ask({ inputSchema: { type: "object", properties: { q: {}, z: {} } } })], { approve: async (a) => { hashes.push(a.request.actionHash); return { approved: false }; } });
    await d.call(call("demo.net", { q: 1, z: 2 }), CTX); await d.call(call("demo.net", { z: 2, q: 1 }), CTX); await d.call(call("demo.net", { q: 2, z: 2 }), CTX);
    assert.equal(hashes[0], hashes[1]); assert.notEqual(hashes[0], hashes[2]);
  });

  it("rejected approval: tool-not-approved, never executed, reason carried", async () => {
    let ran = 0;
    const { d } = rig([ask({ execute: async () => { ran++; return 1; } })], { approve: async () => ({ approved: false, reason: "no thanks" }) });
    const r = await d.call(call("demo.net", { q: "a" }), CTX);
    assert.ok(r.isError && r.error.code === "tool-not-approved" && /no thanks/.test(r.error.message)); assert.equal(r.meta.decision, "ask-refused");
    assert.equal(ran, 0); assertProvenance(r, /^harness:tools$/);
  });

  it("approval port failure or abort while waiting fails closed", async () => {
    let ran = 0;
    const x = rig([ask({ execute: async () => { ran++; return 1; } })], { approve: async () => { throw new Error("store down"); } });
    const r = await x.d.call(call("demo.net", { q: "a" }), CTX);
    assert.ok(r.isError && r.error.code === "tool-not-approved");
    const ac = new AbortController();
    const y = rig([ask({ execute: async () => { ran++; return 1; } })], { approve: () => new Promise(() => {}) });
    const p = y.d.call(call("demo.net", { q: "a" }), { ...CTX, signal: ac.signal });
    await new Promise((r2) => setImmediate(r2)); ac.abort();
    const r2 = await p; assert.ok(r2.isError && r2.error.code === "aborted");
    assert.equal(ran, 0);
  });

  it("a malformed approval answer is a refusal", async () => {
    const { d } = rig([ask()], { approve: async () => ({ approved: "yes" } as never) });
    const r = await d.call(call("demo.net", { q: "a" }), CTX);
    assert.ok(r.isError && r.error.code === "tool-not-approved");
  });

  it("classify() flags reach the policy: a deny-list hit is refused without asking", async () => {
    const { d, asks } = rig([base({ classify: () => ({ flags: { denyListHit: true }, targets: ["/x"], access: "read" }) })]);
    const r = await d.call(call("demo.echo", { q: "a" }), CTX);
    assert.ok(r.isError && r.error.code === "tool-denied" && /deny-list/.test(r.error.message)); assert.equal(asks.length, 0);
  });

  it("a classify() that throws is a refusal, not an allow", async () => {
    const { d } = rig([base({ classify: () => { throw new Error("x"); } })]);
    const r = await d.call(call("demo.echo", { q: "a" }), CTX);
    assert.ok(r.isError && r.error.code === "tool-denied");
  });

  it("a sub-agent without hand-off scope is denied (policy narrowing is honoured)", async () => {
    const { d } = rig([base()], { policyContext: { subject: { kind: "subagent", agentId: "helper" } } });
    const r = await d.call(call("demo.echo", { q: "a" }), CTX);
    assert.ok(r.isError && r.error.code === "tool-denied");
  });
});
