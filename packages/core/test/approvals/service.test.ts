import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FOREGROUND_WAIT_MS } from "../../src/approvals/service.ts";
import { decide } from "../../src/policy/index.ts";
import type { DispatchContext } from "../../src/tools/dispatcher.ts";
import { DAY, HOUR, MIN, askFor, lastNonce, raw, rig, tick, NO_GRANTS } from "./service-helpers.ts";
import { abs } from "../helpers/abs.ts";

const T = { timeout: 20_000 };
const dctx = (o: Partial<DispatchContext> = {}): DispatchContext => ({ agentId: "bernd", principal: "christian", sessionId: "s1", taskId: "t1", surface: 3, signal: new AbortController().signal, ...o });
const approve = (r: Awaited<ReturnType<typeof rig>>, o: Record<string, unknown> = {}) => {
  const { id, nonce } = lastNonce(r);
  return r.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 3, ...o } as never);
};

describe("ApprovalService: park and resolve (D109 §5, D4)", () => {
  it("parks the call: a request with nonce, bound to the action, is stored and announced; nothing resolves by itself", T, async () => {
    const r = await rig();
    const ask = askFor({ actionHash: "a1".padEnd(64, "0") });
    let settled = false;
    const p = r.service.request(ask).then((a) => { settled = true; return a; });
    await tick();
    assert.equal(settled, false);
    const ev = r.events.filter((e) => e.name === "approval.requested");
    assert.equal(ev.length, 1);
    const { approval, nonce, foregroundUntil } = ev[0]!.payload;
    assert.match(nonce, /^[0-9a-f]{32}$/);
    assert.equal(foregroundUntil, r.clock.t + DEFAULT_FOREGROUND_WAIT_MS);
    assert.equal(approval.status, "pending");
    assert.equal(approval.principal, "christian");
    assert.deepEqual(approval.subject, { kind: "agent", id: "bernd" });
    assert.equal(approval.actionHash, "a1".padEnd(64, "0"));
    assert.equal(approval.sessionId, "s1");
    assert.equal(approval.taskId, "t1");
    assert.equal(approval.turnId, "turn1");
    assert.equal(approval.capability, "fs.read");
    assert.deepEqual(approval.targets, [abs("/outside/dir/a.txt")]);
    assert.ok(approval.grantOptions.length >= 1);
    assert.ok(!("nonce" in approval));
    const stored = r.stores.approvals.get(approval.id)!;
    assert.equal(stored.status, "pending");
    assert.equal(stored.bound.actionHash, "a1".padEnd(64, "0"));
    r.service.dispose();
    assert.equal((await p).approved, false);
  });

  it("approve (default once): the waiting call resolves approved, a once grant bound to the action exists, events follow", T, async () => {
    const r = await rig();
    const p = r.service.request(askFor());
    await tick();
    const res = approve(r);
    assert.ok(res.ok, JSON.stringify(res));
    const a = await p;
    assert.equal(a.approved, true);
    assert.equal(a.scope, "once");
    assert.equal(a.grantIds?.length, 1);
    const g = r.stores.grants.get(a.grantIds![0]!)!;
    assert.equal(g.scope, "once");
    assert.equal(g.actionHash, "h1".padEnd(64, "0"));
    assert.equal(g.person, "christian");
    assert.equal(g.agent, "bernd");
    assert.equal(g.surface, 3);
    const resolved = r.events.find((e) => e.name === "approval.resolved")!;
    assert.equal(resolved.payload.outcome, "approved");
    assert.equal(resolved.payload.approval.status, "approved");
    assert.equal(resolved.payload.approval.decidedBy, "christian");
    assert.ok(r.events.some((e) => e.name === "grant.changed" && e.payload.change === "created" && e.payload.grantId === g.id));
  });

  it("deny: the call resolves not approved, no grant, status denied", T, async () => {
    const r = await rig();
    const p = r.service.request(askFor());
    await tick();
    assert.ok(approve(r, { decision: "deny" }).ok);
    const a = await p;
    assert.equal(a.approved, false);
    assert.match(a.reason ?? "", /denied/);
    assert.equal(r.stores.grants.inspect().length, 0);
    assert.equal(r.events.find((e) => e.name === "approval.resolved")!.payload.outcome, "denied");
  });

  it("the first valid answer wins; the second is approval-used and changes nothing", T, async () => {
    const r = await rig();
    const p = r.service.request(askFor());
    await tick();
    const { id, nonce } = lastNonce(r);
    const first = r.service.decide({ requestId: id, nonce, decision: "deny", person: "christian", surface: 3 });
    const second = r.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 3 });
    assert.ok(first.ok);
    assert.deepEqual(second, { ok: false, reason: "approval-used" });
    assert.equal((await p).approved, false);
    assert.equal(r.stores.grants.inspect().length, 0);
  });

  it("a wrong nonce, another person or an unknown id is approval-mismatch; the call keeps waiting", T, async () => {
    const r = await rig();
    let settled = false;
    const p = r.service.request(askFor()).then((a) => { settled = true; return a; });
    await tick();
    const { id, nonce } = lastNonce(r);
    assert.deepEqual(r.service.decide({ requestId: id, nonce: "0".repeat(32), decision: "approve", person: "christian", surface: 3 }), { ok: false, reason: "approval-mismatch" });
    assert.deepEqual(r.service.decide({ requestId: id, nonce, decision: "approve", person: "mallory", surface: 3 }), { ok: false, reason: "approval-mismatch" });
    assert.deepEqual(r.service.decide({ requestId: "apr_nope", nonce, decision: "approve", person: "christian", surface: 3 }), { ok: false, reason: "approval-mismatch" });
    await tick();
    assert.equal(settled, false);
    assert.ok(r.audit.events.some((e) => e.action === "approval.refused" && e.detail.reason === "approval-mismatch"));
    r.service.dispose();
    await p;
  });

  it("T0 never decides; a surface below the class cannot approve (money.spend needs T3)", T, async () => {
    const r = await rig();
    const p = r.service.request(askFor({ capability: "money.spend", tool: "pay", effect: "money", targets: [] }));
    await tick();
    const { id, nonce } = lastNonce(r);
    for (const surface of [0, 1, 2] as const) {
      assert.deepEqual(r.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface }), { ok: false, reason: "surface-untrusted" }, `T${surface}`);
    }
    assert.equal(r.stores.approvals.get(id)!.status, "pending");
    assert.ok(r.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 3 }).ok);
    assert.equal((await p).approved, true);
  });

  it("denying needs no class-level surface: a T1 surface may refuse what it may not approve", T, async () => {
    const r = await rig();
    const p = r.service.request(askFor({ capability: "money.spend", tool: "pay", effect: "money", targets: [] }));
    await tick();
    const { id, nonce } = lastNonce(r);
    assert.ok(r.service.decide({ requestId: id, nonce, decision: "deny", person: "christian", surface: 1 }).ok);
    assert.equal((await p).approved, false);
  });

  it("a scope above the capability's ceiling is scope-unavailable, and the request stays decidable", T, async () => {
    const r = await rig();
    void r.service.request(askFor({ capability: "money.spend", tool: "pay", effect: "money", targets: [] }));
    await tick();
    const { id, nonce } = lastNonce(r);
    assert.deepEqual(r.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 3, scope: "always" }), { ok: false, reason: "scope-unavailable" });
    assert.equal(r.stores.approvals.get(id)!.status, "pending");
    assert.ok(r.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 3, scope: "once" }).ok);
    r.service.dispose();
  });

  it("approve with scope task: a path grant on the target's directory (never wider), bound to the task, and decide() then allows", T, async () => {
    const r = await rig();
    const p = r.service.request(askFor());
    await tick();
    const res = approve(r, { scope: "task" });
    assert.ok(res.ok);
    const a = await p;
    assert.equal(a.approved, true);
    const g = r.stores.grants.get(a.grantIds![0]!)!;
    assert.equal(g.scope, "task");
    assert.equal(g.taskId, "t1");
    assert.deepEqual(g.match, { kind: "path", path: abs("/outside/dir"), access: "read", recursive: false });
    const next = askFor({ targets: [abs("/outside/dir/b.txt")], actionHash: "h2".padEnd(64, "0") });
    // the same call again is now allowed by the grant; a sibling directory still asks
    const base = { principal: { person: "christian" }, subject: { kind: "agent" as const, agentId: "bernd" }, surface: 3 as const, sessionId: "s1", taskId: "t1" };
    const call = (targets: string[], h: string) => ({ capability: "fs.read", tool: "fs.read", flags: { outsideRoots: true, denyListHit: false }, targets, access: "read" as const, actionHash: h });
    assert.equal(decide(call([abs("/outside/dir/b.txt")], "h2"), base, { grants: r.stores.grants, clock: r.clock }).kind, "allow");
    assert.equal(decide(call([abs("/outside/other/b.txt")], "h3"), base, { grants: r.stores.grants, clock: r.clock }).kind, "ask");
    void next;
  });

  it("task and session scopes need a real task / session id; otherwise scope-unavailable and nothing is decided", T, async () => {
    const r = await rig();
    void r.service.request(askFor({ taskId: null, sessionId: null }));
    await tick();
    const { id, nonce } = lastNonce(r);
    for (const scope of ["task", "session"] as const) {
      assert.deepEqual(r.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 3, scope }), { ok: false, reason: "scope-unavailable" }, scope);
    }
    assert.equal(r.stores.approvals.get(id)!.status, "pending");
    assert.equal(r.stores.grants.inspect().length, 0);
    r.service.dispose();
  });

  it("delegable: the grant carries the flag (D104), the record too", T, async () => {
    const r = await rig();
    void r.service.request(askFor());
    await tick();
    const res = approve(r, { scope: "task", delegable: true });
    assert.ok(res.ok);
    assert.equal(r.stores.grants.inspect()[0]!.grant.delegable, true);
    assert.equal(r.service.get(lastNonce(r).id)!.delegable, true);
    r.service.dispose();
  });

  it("no scope, no targets (a capability without paths): a once grant still exists and binds the action", T, async () => {
    const r = await rig();
    const p = r.service.request(askFor({ capability: "net.submit", tool: "http.post", effect: "external", targets: [] }));
    await tick();
    assert.ok(approve(r).ok);
    const a = await p;
    assert.equal(r.stores.grants.get(a.grantIds![0]!)!.scope, "once");
  });
});

describe("ApprovalService: consuming an approval at execution start (D109 §6 replay)", () => {
  it("begin() consumes the approval and its once grant exactly once", T, async () => {
    const r = await rig();
    const ask = askFor();
    const p = r.service.request(ask);
    await tick();
    approve(r);
    const a = await p;
    assert.equal(r.service.begin(a, ask), true);
    assert.equal(r.service.begin(a, ask), false, "replay");
    assert.equal(r.stores.approvals.get(a.requestId!)!.status, "used");
    assert.equal(r.stores.grants.get(a.grantIds![0]!)!.consumedAt !== undefined, true);
    assert.ok(r.audit.events.some((e) => e.action === "approval.consumed"));
  });

  it("an approval presented with other arguments, another agent, another session or another principal is refused and stays usable", T, async () => {
    const r = await rig();
    const ask = askFor();
    const p = r.service.request(ask);
    await tick();
    approve(r);
    const a = await p;
    const other = (o: Partial<typeof ask> & { request?: typeof ask.request }) => ({ ...ask, ...o });
    assert.equal(r.service.begin(a, other({ request: { ...ask.request, actionHash: "ff".repeat(32) } })), false);
    assert.equal(r.service.begin(a, other({ agentId: "other" })), false);
    assert.equal(r.service.begin(a, other({ sessionId: "s2" })), false);
    assert.equal(r.service.begin(a, other({ principal: "mallory" })), false);
    assert.equal(r.service.begin(a, ask), true);
  });

  it("a not-approved or foreign answer never begins", T, async () => {
    const r = await rig();
    const ask = askFor();
    assert.equal(r.service.begin({ approved: false }, ask), false);
    assert.equal(r.service.begin({ approved: true }, ask), false);
    assert.equal(r.service.begin({ approved: true, requestId: "apr_forged" }, ask), false);
  });

  it("with a standing grant chosen, begin() records the use of the grant", T, async () => {
    const r = await rig();
    const ask = askFor();
    const p = r.service.request(ask);
    await tick();
    approve(r, { scope: "always" });
    const a = await p;
    assert.equal(r.service.begin(a, ask), true);
    assert.ok(r.stores.grants.get(a.grantIds![0]!)!.lastUsedAt !== undefined);
  });
});

describe("ApprovalService: timeouts, abort, errors: never approved", () => {
  it("after 10 minutes in the foreground the task parks: the call gets a not-approved answer, the request stays open", T, async () => {
    const r = await rig();
    const p = r.service.request(askFor());
    await tick();
    r.timers.advance(10 * MIN - 1);
    await tick();
    assert.equal(r.events.some((e) => e.name === "approval.parked"), false);
    r.timers.advance(1);
    const a = await p;
    assert.equal(a.approved, false);
    assert.equal(a.parked, true);
    assert.match(a.reason ?? "", /parked|waiting for approval/);
    assert.equal(r.events.filter((e) => e.name === "approval.parked").length, 1);
    const { id } = lastNonce(r);
    assert.equal(r.stores.approvals.get(id)!.status, "pending");
    assert.ok(r.audit.events.some((e) => e.action === "approval.parked"));
  });

  it("a parked request can still be decided before it expires; the answer goes to the store and the grant, not to a dead call", T, async () => {
    const r = await rig();
    const p = r.service.request(askFor());
    await tick();
    r.timers.advance(10 * MIN);
    await p;
    r.clock.advance(5 * HOUR);
    const res = approve(r, { scope: "task" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(r.stores.approvals.get(lastNonce(r).id)!.status, "approved");
    assert.equal(r.events.filter((e) => e.name === "approval.resolved").length, 1);
  });

  it("after 24 hours the request expires = denied, never approved", T, async () => {
    const r = await rig();
    const p = r.service.request(askFor());
    await tick();
    r.timers.advance(10 * MIN);
    await p;
    r.timers.advance(DAY);
    const { id, nonce } = lastNonce(r);
    assert.equal(r.stores.approvals.get(id)!.status, "expired");
    const ev = r.events.find((e) => e.name === "approval.resolved")!;
    assert.equal(ev.payload.outcome, "expired");
    assert.deepEqual(r.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 3 }), { ok: false, reason: "approval-expired" });
    assert.ok(r.audit.events.some((e) => e.action === "approval.expired"));
    assert.equal(r.stores.grants.inspect().length, 0);
  });

  it("a foreground wait configured longer than the request's life ends with the request: denied", T, async () => {
    const r = await rig({ ttlMs: HOUR, foregroundWaitMs: 3 * HOUR });
    const p = r.service.request(askFor());
    await tick();
    r.timers.advance(HOUR);
    const a = await p;
    assert.equal(a.approved, false);
    assert.match(a.reason ?? "", /expired/);
  });

  it("the foreground wait is configurable", T, async () => {
    const r = await rig({ foregroundWaitMs: 2 * MIN });
    const p = r.service.request(askFor());
    await tick();
    r.timers.advance(2 * MIN);
    assert.equal((await p).parked, true);
  });

  it("an abort cancels the request: not approved, status cancelled, a later decision is refused", T, async () => {
    const r = await rig();
    const ac = new AbortController();
    const p = r.service.request(askFor({ signal: ac.signal }));
    await tick();
    ac.abort();
    const a = await p;
    assert.equal(a.approved, false);
    assert.match(a.reason ?? "", /abort/);
    const { id, nonce } = lastNonce(r);
    assert.equal(r.stores.approvals.get(id)!.status, "cancelled");
    assert.deepEqual(r.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 3 }), { ok: false, reason: "approval-expired" });
    assert.equal(r.events.find((e) => e.name === "approval.resolved")!.payload.outcome, "cancelled");
  });

  it("an already aborted signal asks nobody", T, async () => {
    const r = await rig();
    const ac = new AbortController(); ac.abort();
    const a = await r.service.request(askFor({ signal: ac.signal }));
    assert.equal(a.approved, false);
    assert.equal(r.events.length, 0);
    assert.equal(r.stores.approvals.list().length, 0);
  });

  it("a headless ask (park) neither prompts nor waits nor leaves a request: it is refused at once and audited", T, async () => {
    const r = await rig();
    const ask = { ...askFor(), park: true };
    const a = await r.service.request(ask);
    assert.equal(a.approved, false);
    assert.equal(r.events.length, 0);
    assert.equal(r.stores.approvals.list().length, 0);
    assert.equal(r.timers.pending, 0);
    assert.ok(r.audit.events.some((e) => e.action === "approval.refused" && e.detail.reason === "headless"));
  });

  it("a broken chain: the call is not approved (never an exception), and the integrity failure is audited", T, async () => {
    const r = await rig();
    const p0 = r.service.request(askFor());
    await tick();
    r.service.dispose();
    await p0;
    const db = raw(r.path);
    db.prepare("UPDATE approval_chain SET payload = payload || ' ' WHERE seq = 1").run();
    db.close();
    const a = await r.service.request(askFor({ actionHash: "b2".padEnd(64, "0") }));
    assert.equal(a.approved, false);
    assert.match(a.reason ?? "", /integrity|unavailable/);
    const f = r.audit.events.find((e) => e.action === "approvals.integrity-failure")!;
    assert.ok(f);
    assert.equal(typeof f.detail.brokenAt, "number");
    assert.equal(r.service.verify().ok, false);
  });

  it("a failing audit sink on request: the request is not created, the call is not approved", T, async () => {
    const r = await rig();
    const bad = await rig({ service: { audit: { record() { throw new Error("audit down"); } } } });
    const a = await bad.service.request(askFor());
    assert.equal(a.approved, false);
    assert.equal(bad.stores.approvals.list().length, 0);
    void r;
  });

  it("dispose() resolves every waiting call as not approved", T, async () => {
    const r = await rig();
    const ps = [r.service.request(askFor()), r.service.request(askFor({ actionHash: "c3".padEnd(64, "0") }))];
    await tick();
    r.service.dispose();
    for (const a of await Promise.all(ps)) assert.equal(a.approved, false);
    assert.equal(r.timers.pending, 0);
  });

  it("a decision still works after a restart: the stored detail, not memory, drives the surface rules", T, async () => {
    const r1 = await rig();
    const p = r1.service.request(askFor({ capability: "money.spend", tool: "pay", effect: "money", targets: [] }));
    await tick();
    const { id, nonce } = lastNonce(r1);
    r1.service.dispose();
    await p;
    r1.stores.close();
    const r2 = await rig({ path: r1.path, clock: r1.clock });
    assert.deepEqual(r2.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 2 }), { ok: false, reason: "surface-untrusted" });
    assert.ok(r2.service.decide({ requestId: id, nonce, decision: "approve", person: "christian", surface: 3 }).ok);
  });
});

describe("ApprovalService: list, get, cancel, verify", () => {
  it("views never carry the nonce or the arguments; list filters by status and principal", T, async () => {
    const r = await rig();
    void r.service.request(askFor({ args: { path: abs("/outside/dir/a.txt"), token: "ghp_" + "A".repeat(36) } }));
    void r.service.request(askFor({ principal: "anna", actionHash: "d4".padEnd(64, "0") }));
    await tick();
    const all = r.service.list();
    assert.equal(all.length, 2);
    const raw = JSON.stringify(all);
    assert.ok(!/nonce/i.test(raw));
    assert.ok(!raw.includes("A".repeat(36)), "secret-shaped value in the preview is masked");
    assert.equal(r.service.list({ principal: "anna" }).length, 1);
    assert.equal(r.service.list({ status: "approved" }).length, 0);
    assert.equal(r.service.list({ status: "pending" }).length, 2);
    r.service.dispose();
  });

  it("get(id, principal) does not reveal another person's request", T, async () => {
    const r = await rig();
    void r.service.request(askFor());
    await tick();
    const { id } = lastNonce(r);
    assert.ok(r.service.get(id));
    assert.ok(r.service.get(id, "christian"));
    assert.equal(r.service.get(id, "mallory"), undefined);
    assert.equal(r.service.get("apr_nope"), undefined);
    r.service.dispose();
  });

  it("cancel by the principal resolves the waiting call as not approved; another person cannot", T, async () => {
    const r = await rig();
    const p = r.service.request(askFor());
    await tick();
    const { id } = lastNonce(r);
    assert.deepEqual(r.service.cancel({ requestId: id, person: "mallory" }), { ok: false, reason: "approval-mismatch" });
    assert.ok(r.service.cancel({ requestId: id, person: "christian" }).ok);
    assert.equal((await p).approved, false);
    assert.equal(r.service.get(id)!.status, "cancelled");
    assert.deepEqual(r.service.cancel({ requestId: id, person: "christian" }), { ok: false, reason: "approval-used" });
    assert.ok(r.audit.events.some((e) => e.action === "approval.cancelled"));
    assert.equal(r.events.find((e) => e.name === "approval.resolved")!.payload.outcome, "cancelled");
  });

  it("decideForSession: an authenticated surface decides without handling the nonce", T, async () => {
    const r = await rig();
    const p = r.service.request(askFor());
    await tick();
    const { id } = lastNonce(r);
    assert.deepEqual(r.service.decideForSession({ requestId: id, decision: "approve", person: "mallory", surface: 3 }), { ok: false, reason: "approval-mismatch" });
    assert.ok(r.service.decideForSession({ requestId: id, decision: "approve", person: "christian", surface: 3 }).ok);
    assert.equal((await p).approved, true);
  });

  it("verify() is the store's chain check and audits a failure", T, async () => {
    const r = await rig();
    assert.equal(r.service.verify().ok, true);
    assert.equal(r.audit.events.filter((e) => e.action === "approvals.integrity-failure").length, 0);
  });
});

describe("ApprovalService.policyContext: repeat protection and prompt cap (D109 §5)", () => {
  it("an action denied in this task is refused without asking next time; other tasks are not affected", T, async () => {
    const r = await rig();
    const ask = askFor({ actionHash: "e5".padEnd(64, "0") });
    const p = r.service.request(ask);
    await tick();
    approve(r, { decision: "deny" });
    await p;
    const pc = r.service.policyContext();
    assert.deepEqual(pc(dctx()).deniedActionHashes, ["e5".padEnd(64, "0")]);
    assert.deepEqual(pc(dctx({ taskId: "t2" })).deniedActionHashes ?? [], []);
    const call = { capability: "fs.read", tool: "fs.read", flags: { outsideRoots: true, denyListHit: false }, targets: [abs("/outside/dir/a.txt")], access: "read" as const, actionHash: "e5".padEnd(64, "0") };
    const ctx = { principal: { person: "christian" }, subject: { kind: "agent" as const, agentId: "bernd" }, surface: 3 as const, sessionId: "s1", taskId: "t1", ...pc(dctx()) };
    const d = decide(call, ctx, { grants: NO_GRANTS, clock: r.clock });
    assert.deepEqual(d.kind === "deny" && d.reason, "repeat-denied");
  });

  it("a timeout or an abort is not a denial: the same action may be asked again", T, async () => {
    const r = await rig();
    const ac = new AbortController();
    const p = r.service.request(askFor({ signal: ac.signal, actionHash: "f6".padEnd(64, "0") }));
    await tick();
    ac.abort();
    await p;
    assert.deepEqual(r.service.policyContext()(dctx()).deniedActionHashes ?? [], []);
  });

  it("counts the prompts of this task in the last hour; at 10 the evaluator refuses to ask", T, async () => {
    const r = await rig();
    for (let i = 0; i < 10; i++) void r.service.request(askFor({ actionHash: String(i).padStart(2, "0").padEnd(64, "a") }));
    await tick();
    const pc = r.service.policyContext();
    assert.equal(pc(dctx()).promptsThisHour, 10);
    assert.equal(pc(dctx({ taskId: "t2" })).promptsThisHour ?? 0, 0);
    const call = { capability: "fs.read", tool: "fs.read", flags: { outsideRoots: true, denyListHit: false }, targets: [abs("/outside/dir/new.txt")], access: "read" as const, actionHash: "9".repeat(64) };
    const ctx = { principal: { person: "christian" }, subject: { kind: "agent" as const, agentId: "bernd" }, surface: 3 as const, sessionId: "s1", taskId: "t1", ...pc(dctx()) };
    const d = decide(call, ctx, { grants: NO_GRANTS, clock: r.clock });
    assert.deepEqual(d.kind === "deny" && d.reason, "prompt-cap");
    r.clock.advance(HOUR + MIN);
    assert.equal(pc(dctx()).promptsThisHour, 0);
    r.service.dispose();
  });

  it("keeps what the inner hook returns and only adds to it", T, async () => {
    const r = await rig();
    const pc = r.service.policyContext(() => ({ toolsDeny: ["x.*"], deniedActionHashes: ["zz"], promptsThisHour: 3 }));
    const out = pc(dctx());
    assert.deepEqual(out.toolsDeny, ["x.*"]);
    assert.deepEqual(out.deniedActionHashes, ["zz"]);
    assert.equal(out.promptsThisHour, 3);
  });
});

describe("ApprovalService.policyContext: authority.approvalsHeld is verified, never believed (D104)", () => {
  it("forged, foreign, non-delegable and wrong-task references are dropped and audited; a delegable one passes", T, async () => {
    const r = await rig();
    const mk = (o: object) => r.stores.grants.create({ capability: "fs.read", person: "christian", agent: "bernd", scope: "task", taskId: "t1", match: { kind: "capability" }, createdBy: "christian", surface: 3, delegable: true, ...o });
    const good = mk({});
    const notDelegable = mk({ delegable: false });
    const wrongTask = mk({ taskId: "t2" });
    const foreign = mk({ person: "mallory", createdBy: "mallory" });
    const revoked = mk({});
    r.stores.grants.revoke(revoked.id, "christian");
    r.audit.events.length = 0;
    const pc = r.service.policyContext(() => ({ handoff: { scope: ["fs.read"], taskId: "t1", approvalsHeld: [good.id, "grt_forged", notDelegable.id, wrongTask.id, foreign.id, revoked.id] } }));
    const out = pc(dctx());
    assert.deepEqual(out.handoff!.approvalsHeld, [good.id]);
    assert.equal(out.handoff!.taskId, "t1");
    const ev = r.audit.events.find((e) => e.action === "approvals.held-rejected")!;
    assert.ok(ev);
    assert.equal(ev.actor.user, "christian");
    assert.deepEqual((ev.detail.rejected as { id: string; reason: string }[]).map((x) => x.reason).sort(), ["foreign-person", "not-delegable", "revoked", "task-mismatch", "unknown"]);
  });

  it("nothing to audit when every reference is valid; no hand-off leaves the context untouched", T, async () => {
    const r = await rig();
    const g = r.stores.grants.create({ capability: "fs.read", person: "christian", agent: "bernd", scope: "task", taskId: "t1", match: { kind: "capability" }, createdBy: "christian", surface: 3, delegable: true });
    r.audit.events.length = 0;
    r.service.policyContext(() => ({ handoff: { scope: ["fs.read"], taskId: "t1", approvalsHeld: [g.id] } }))(dctx());
    assert.equal(r.audit.events.length, 0);
    assert.equal(r.service.policyContext()(dctx()).handoff, undefined);
  });

  it("a failing audit on a rejected reference makes the context hook throw (the dispatcher then refuses)", T, async () => {
    const bad = await rig({ service: { audit: { record() { throw new Error("audit down"); } } } });
    const pc = bad.service.policyContext(() => ({ handoff: { scope: ["fs.read"], taskId: "t1", approvalsHeld: ["grt_forged"] } }));
    assert.throws(() => pc(dctx()), /audit down/);
  });
});
