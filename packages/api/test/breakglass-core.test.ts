// One break-glass registry: the core's. The REST routes forward to the core's breakglass.request|list|revoke, so a grant made
// over REST is the grant a core read consults, a grant made over RPC shows in the REST list, and the notice and the audit
// line exist only for a grant that took effect. The core here is `miniCore`: the real registry, admin surface, RPC guard and
// break-glass memory read, with only the engine faked (the same wiring `core.ts` uses; chats-core.test.ts runs the real core).
import assert from "node:assert/strict";
import test from "node:test";
import type { ApiPrincipal } from "@plur1bus/module-api";
import { FakeClock } from "../src/clock.ts";
import type { AuditSink } from "../src/rbac-bridge.ts";
import { miniCore, type MiniCore } from "./mini-core.ts";
import { addUser, loginAs, raw, start, write, type Harness } from "./helpers.ts";

const wide = { auth: { capacity: 1000, refillPerSec: 100 }, read: { capacity: 1000, refillPerSec: 100 }, write: { capacity: 1000, refillPerSec: 100 }, totp: { capacity: 1000, refillPerSec: 100 }, stream: { capacity: 1000, refillPerSec: 100 } };
const REASON = "Ticket 4711: the user asked support to recover a memory they deleted by mistake";
const adam: ApiPrincipal = { userId: "u-adam", kind: "person", role: "admin" };
const mia: ApiPrincipal = { userId: "u-mia", kind: "person", role: "member" };

async function setup(o: { auditSink?: AuditSink; notify?: Parameters<typeof miniCore>[0]["notify"] } = {}): Promise<{ h: Harness; core: MiniCore }> {
  const clock = new FakeClock();
  const core = miniCore({ clock, ...(o.auditSink ? { auditSink: o.auditSink } : {}), ...(o.notify ? { notify: o.notify } : {}) });
  const h = await start({ rateClasses: wide, clock, core });
  for (const [id, username, role] of [["u-adam", "adam", "admin"], ["u-mia", "mia", "member"], ["u-vera", "vera", "viewer"]] as const) {
    await addUser(h, { id, username, role }); core.addPerson(id, role);
  }
  return { h, core };
}
const close = async (h: Harness, core: MiniCore) => { await h.close(); core.close(); };
/** The core read a grant exists for: another person's user-scope cards through memory.list, as `reader`. */
const coreRead = (core: MiniCore, reader: ApiPrincipal, targetUserId = "u-mia") => core.rpc<{ items: Array<{ scope: string }> }>(reader, "memory.list", { agentId: "main", targetUserId, topic: "anything" });
const denied = (e: unknown) => (e as { error?: string }).error === "E_DENIED";
const grant = (h: Harness, cookie: string, body: Record<string, unknown> = { targetUserId: "u-mia", reason: REASON }) => write(h, cookie, { path: "/api/v1/breakglass", body });
const revoke = (h: Harness, cookie: string, grantId: string) => write(h, cookie, { path: "/api/v1/breakglass/revoke", body: { grantId } });
const list = (h: Harness, cookie: string) => raw(h, { path: "/api/v1/breakglass", headers: { cookie } });
const notices = (h: Harness, cookie: string) => raw(h, { path: "/api/v1/me/notices", headers: { cookie } });

test("a grant made over REST is the grant the core's read consults; revoking it over REST takes the read away again", async () => {
  const { h, core } = await setup();
  try {
    const { cookie } = await loginAs(h, "adam");
    await assert.rejects(coreRead(core, adam), denied, "no grant yet: the core refuses");
    const r = await grant(h, cookie);
    assert.equal(r.status, 201, r.text);
    const items = (await coreRead(core, adam)).items;
    assert.deepEqual(items.map((c) => c.scope), ["user"], "the REST grant lets the core read the target's user cards");
    await assert.rejects(coreRead(core, adam, "u-vera"), denied, "a grant covers its target only");
    await assert.rejects(coreRead(core, mia), denied, "and its holder only");
    assert.equal((await revoke(h, cookie, r.json.grant.id)).status, 200);
    await assert.rejects(coreRead(core, adam), denied, "revoked over REST: the core refuses again");
    assert.deepEqual((await list(h, cookie)).json.grants, []);
  } finally { await close(h, core); }
});

test("a grant made over RPC is in the REST list and can be revoked over REST (no 404); the REST list has no grant the core does not have", async () => {
  const { h, core } = await setup();
  try {
    const { cookie } = await loginAs(h, "adam");
    const made = await core.rpc<{ id: string; targetUserId: string }>(adam, "breakglass.request", { targetUserId: "u-mia", reason: REASON, windowMinutes: 5 });
    const listed = (await list(h, cookie)).json.grants;
    assert.deepEqual(listed.map((g: { id: string; targetUserId: string }) => [g.id, g.targetUserId]), [[made.id, "u-mia"]], "RPC grant is visible over REST");
    assert.equal(Date.parse(listed[0].expiresAt) - Date.parse(listed[0].issuedAt), 5 * 60_000);
    assert.equal((await coreRead(core, adam)).items.length, 1);
    assert.equal((await revoke(h, cookie, made.id)).status, 200, "an RPC grant can be revoked over REST");
    await assert.rejects(coreRead(core, adam), denied);
    assert.equal((await revoke(h, cookie, made.id)).status, 404, "and it is gone");
    // The other way round: REST list and core list never differ.
    const viaRest = await grant(h, cookie);
    assert.deepEqual((await core.rpc<{ grants: Array<{ id: string }> }>(adam, "breakglass.list")).grants.map((g) => g.id), (await list(h, cookie)).json.grants.map((g: { id: string }) => g.id));
    assert.equal(viaRest.status, 201);
  } finally { await close(h, core); }
});

test("the affected user is told, and the audit line written, only for a grant that took effect", async () => {
  const { h, core } = await setup();
  try {
    const adamCookie = (await loginAs(h, "adam")).cookie; const miaCookie = (await loginAs(h, "mia")).cookie;
    // Refused by the core (own cards): no grant, no notice anywhere, no granted line.
    const self = await grant(h, adamCookie, { targetUserId: "u-adam", reason: REASON });
    assert.deepEqual([self.status, self.json.reason], [400, "self-target"]);
    const short = await grant(h, adamCookie, { targetUserId: "u-mia", reason: "x".repeat(9) });
    assert.deepEqual([short.status, short.json.reason], [400, "reason"]);
    assert.equal(core.notified.length, 0); assert.deepEqual((await notices(h, miaCookie)).json.notices, []);
    assert.equal(core.audit.events.filter((e) => e.action === "break-glass.granted").length, 0);
    // Effective grant: notice at once (REST pull side reads the core's durable notice), one audit line, the holder gets no notice.
    const g = (await grant(h, adamCookie)).json.grant;
    assert.deepEqual(core.notified.map((n) => [n.userId, n.holderUserId, n.grantId]), [["u-mia", "u-adam", g.id]]);
    const pulled = (await notices(h, miaCookie)).json.notices;
    assert.deepEqual(pulled.map((n: { kind: string; grantId: string; holderUserId: string; reason: string; expiresAt: string }) => [n.kind, n.grantId, n.holderUserId, n.reason, n.expiresAt]), [["break-glass.granted", g.id, "u-adam", REASON, g.expiresAt]]);
    assert.deepEqual((await core.rpc<{ notices: Array<{ grantId: string }> }>(mia, "breakglass.notices")).notices.map((n) => n.grantId), [g.id], "the same notice over RPC");
    assert.deepEqual((await notices(h, adamCookie)).json.notices, [], "the holder gets no notice of their own grant");
    assert.equal(core.audit.events.filter((e) => e.action === "break-glass.granted").length, 1);
  } finally { await close(h, core); }
});

test("a core that cannot audit grants nothing and tells nobody (503); a core that cannot deliver the notice grants nothing either", async () => {
  const broken: AuditSink = { append() { throw new Error("audit-chain: lock timeout"); } };
  const a = await setup({ auditSink: broken });
  try {
    const { cookie } = await loginAs(a.h, "adam");
    const r = await grant(a.h, cookie);
    assert.deepEqual([r.status, r.json.reason], [503, "audit-unavailable"]);
    assert.ok(!r.text.includes("lock timeout"), "the chain's own text is not forwarded");
    assert.equal(a.core.notified.length, 0); assert.deepEqual((await list(a.h, cookie)).json.grants, []);
    await assert.rejects(coreRead(a.core, adam), denied);
  } finally { await close(a.h, a.core); }
  const b = await setup({ notify: () => { throw new Error("inbox store locked"); } });
  try {
    const { cookie } = await loginAs(b.h, "adam");
    const r = await grant(b.h, cookie);
    assert.deepEqual([r.status, r.json.error], [503, "E_NOT_AVAILABLE"]);
    assert.ok(!r.text.includes("store locked"));
    assert.deepEqual((await list(b.h, cookie)).json.grants, [], "no grant without a durable notice");
    await assert.rejects(coreRead(b.core, adam), denied);
    assert.equal(b.core.audit.events.filter((e) => e.action === "break-glass.notify-failed").length, 1, "the failure is audited");
  } finally { await close(b.h, b.core); }
});

test("the REST gate stays: Operator, Member and Viewer cannot ask (403) and nothing reaches the core's registry", async () => {
  const { h, core } = await setup();
  try {
    const before = core.calls.length;
    for (const name of ["mia", "vera"]) {
      const { cookie } = await loginAs(h, name);
      const r = await grant(h, cookie);
      assert.deepEqual([r.status, r.json.reason], [403, "role-denied"], name);
      assert.equal((await list(h, cookie)).status, 403, name);
    }
    assert.equal(core.calls.length, before, "refused at the API's gate: no delegated call");
    assert.equal(core.audit.events.filter((e) => e.action.startsWith("break-glass")).length, 0);
  } finally { await close(h, core); }
});
