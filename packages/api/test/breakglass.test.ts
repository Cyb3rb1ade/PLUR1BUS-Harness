import assert from "node:assert/strict";
import test from "node:test";
import { NoticeInbox } from "../src/notices.ts";
import { FakeClock } from "../src/clock.ts";
import type { AuditSink, BreakGlassNotice } from "../src/rbac-bridge.ts";
import { addUser, jsonHeaders, loginAs, login, raw, start, write, type Harness } from "./helpers.ts";

const wide = { auth: { capacity: 1000, refillPerSec: 100 }, read: { capacity: 1000, refillPerSec: 100 }, write: { capacity: 1000, refillPerSec: 100 }, totp: { capacity: 1000, refillPerSec: 100 }, stream: { capacity: 1000, refillPerSec: 100 } };
const REASON = "Ticket 4711: the user asked support to recover a memory they deleted by mistake";
const setup = async (o: Parameters<typeof start>[0] = {}) => {
  const h = await start({ rateClasses: wide, ...o });
  await addUser(h, { id: "u-adam", username: "adam", role: "admin" });
  await addUser(h, { id: "u-adele", username: "adele", role: "admin" });
  await addUser(h, { id: "u-mia", username: "mia", role: "member" });
  await addUser(h, { id: "u-olga", username: "olga", role: "operator" });
  await addUser(h, { id: "u-vera", username: "vera", role: "viewer" });
  return h;
};
const grant = (h: Harness, cookie: string, body: Record<string, unknown>) => write(h, cookie, { path: "/api/v1/breakglass", body });
const list = (h: Harness, cookie: string) => raw(h, { path: "/api/v1/breakglass", headers: { cookie } });
const events = (h: Harness, prefix = "break-glass") => h.audit.events.filter((e) => e.action.startsWith(prefix));

test("only Owner and Admin can ask for break-glass; Operator, Member and Viewer cannot; a token cannot (cookie session only)", async () => {
  const h = await setup();
  try {
    for (const [name, status] of [["adam", 201], ["olga", 403], ["mia", 403], ["vera", 403]] as const) {
      const { cookie } = await loginAs(h, name);
      const r = await grant(h, cookie, { targetUserId: "u-mia", reason: REASON });
      assert.equal(r.status, status, name); if (status === 403) assert.equal(r.json.reason, "role-denied");
    }
    const o = await login(h); assert.equal((await grant(h, o.cookie, { targetUserId: "u-mia", reason: REASON })).status, 201, "the owner can");
    const t = await raw(h, { method: "POST", path: "/api/v1/breakglass", headers: { authorization: "Bearer plb_000000000000_" + "A".repeat(43), ...jsonHeaders() }, body: JSON.stringify({ targetUserId: "u-mia", reason: REASON }) });
    assert.equal(t.status, 401);
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/breakglass", headers: { cookie: (await loginAs(h, "adam")).cookie, ...jsonHeaders() }, body: JSON.stringify({ targetUserId: "u-mia", reason: REASON }) })).status, 403, "no CSRF token, no grant");
  } finally { await h.close(); }
});

test("a reason is mandatory (10 to 500 characters) and without one nothing is granted or audited", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "adam");
    for (const reason of [undefined, "", "   ", "too short", "x".repeat(501), 5]) {
      const r = await grant(h, cookie, { targetUserId: "u-mia", ...(reason !== undefined ? { reason } : {}) });
      assert.equal(r.status, 400, String(reason)); assert.equal(r.json.reason, "reason");
    }
    assert.equal(events(h).length, 0); assert.deepEqual((await list(h, cookie)).json.grants, []);
  } finally { await h.close(); }
});

test("the window is 1 to 60 minutes, 15 by default; the grant says when it ends", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "adam");
    const d = (await grant(h, cookie, { targetUserId: "u-mia", reason: REASON })).json.grant;
    assert.equal(Date.parse(d.expiresAt) - Date.parse(d.issuedAt), 15 * 60_000);
    const s = (await grant(h, cookie, { targetUserId: "u-mia", reason: REASON, ttlMinutes: 60 })).json.grant;
    assert.equal(Date.parse(s.expiresAt) - Date.parse(s.issuedAt), 60 * 60_000);
    for (const ttlMinutes of [0, 61, -5, 1.5, "10", null]) assert.equal((await grant(h, cookie, { targetUserId: "u-mia", reason: REASON, ttlMinutes })).json.reason, "ttl", String(ttlMinutes));
  } finally { await h.close(); }
});

test("the grant is audited before it exists, with holder, target and reason; a sink that cannot record means no grant and no notice (503)", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "adam");
    const g = (await grant(h, cookie, { targetUserId: "u-mia", reason: REASON })).json.grant;
    const ev = events(h, "break-glass.granted"); assert.equal(ev.length, 1);
    assert.deepEqual([ev[0]!.actor.user, ev[0]!.target, ev[0]!.detail.grantId, ev[0]!.detail.reason], ["u-adam", "u-mia", g.id, REASON]);
  } finally { await h.close(); }
  const broken: AuditSink = { append() { throw new Error("audit-chain: lock timeout"); } };
  const notices: BreakGlassNotice[] = [];
  const h2 = await setup({ breakGlassAudit: broken, notifyBreakGlass: (n) => notices.push(n) });
  try {
    const { cookie } = await loginAs(h2, "adam");
    const r = await grant(h2, cookie, { targetUserId: "u-mia", reason: REASON });
    assert.deepEqual([r.status, r.json.reason], [503, "audit-unavailable"]);
    assert.deepEqual((await list(h2, cookie)).json.grants, []); assert.equal(notices.length, 0);
    assert.ok(!r.text.includes("lock timeout"), "the chain's own text is not forwarded");
  } finally { await h2.close(); }
});

test("with no audit sink at all there is no break-glass (fail closed)", async () => {
  const h = await start({ rateClasses: wide, noAudit: true });
  try {
    await addUser(h, { id: "u-adam", username: "adam", role: "admin" }); await addUser(h, { id: "u-mia", username: "mia", role: "member" });
    const { cookie } = await loginAs(h, "adam");
    assert.equal((await grant(h, cookie, { targetUserId: "u-mia", reason: REASON })).status, 503);
  } finally { await h.close(); }
});

test("the affected user is notified: the grant is in their inbox at once, with who, why and until when; nobody else sees it; the hook is called too", async () => {
  const hook: BreakGlassNotice[] = [];
  const h = await setup({ notifyBreakGlass: (n) => hook.push(n) });
  try {
    const adam = await loginAs(h, "adam"); const mia = await loginAs(h, "mia"); const vera = await loginAs(h, "vera");
    const g = (await grant(h, adam.cookie, { targetUserId: "u-mia", reason: REASON })).json.grant;
    const inbox = await raw(h, { path: "/api/v1/me/notices", headers: { cookie: mia.cookie } });
    assert.equal(inbox.status, 200); assert.equal(inbox.json.notices.length, 1);
    assert.deepEqual(inbox.json.notices[0], { kind: "break-glass.granted", grantId: g.id, holderUserId: "u-adam", reason: REASON, at: inbox.json.notices[0].at, expiresAt: g.expiresAt });
    assert.deepEqual((await raw(h, { path: "/api/v1/me/notices", headers: { cookie: vera.cookie } })).json.notices, []);
    assert.deepEqual((await raw(h, { path: "/api/v1/me/notices", headers: { cookie: adam.cookie } })).json.notices, [], "the holder gets no notice of their own grant");
    assert.deepEqual(hook.map((n) => [n.userId, n.holderUserId, n.grantId]), [["u-mia", "u-adam", g.id]]);
  } finally { await h.close(); }
});

test("a delivery hook that throws does not undo the grant; the failure is audited", async () => {
  const h = await setup({ notifyBreakGlass: () => { throw new Error("smtp down"); } });
  try {
    const { cookie } = await loginAs(h, "adam");
    const r = await grant(h, cookie, { targetUserId: "u-mia", reason: REASON });
    assert.equal(r.status, 201); assert.equal((await list(h, cookie)).json.grants.length, 1);
    assert.equal(events(h, "break-glass.notify-failed").length, 1);
    const mia = await loginAs(h, "mia");
    assert.equal((await raw(h, { path: "/api/v1/me/notices", headers: { cookie: mia.cookie } })).json.notices.length, 1, "the inbox still has it");
  } finally { await h.close(); }
});

test("the target must be another existing user", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "adam");
    assert.deepEqual((await grant(h, cookie, { targetUserId: "u-adam", reason: REASON })).json.reason, "self-target");
    assert.deepEqual((await grant(h, cookie, { targetUserId: "u-nobody", reason: REASON })).json.reason, "target");
    for (const bad of [undefined, "", 5, {}]) assert.equal((await grant(h, cookie, { ...(bad !== undefined ? { targetUserId: bad } : {}), reason: REASON })).status, 400);
    for (const body of [null, [], { targetUserId: "u-mia", reason: REASON, extra: 1 }]) assert.equal((await write(h, cookie, { path: "/api/v1/breakglass", body })).json.reason, "body");
    assert.equal((await grant(h, cookie, { targetUserId: "owner", reason: REASON })).status, 201, "the owner's cards can be the target too");
  } finally { await h.close(); }
});

test("it ends by itself: after the window the grant is gone from the list and one expiry event is audited", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "adam");
    await grant(h, cookie, { targetUserId: "u-mia", reason: REASON, ttlMinutes: 5 });
    h.clock.advance(5 * 60_000 - 1); assert.equal((await list(h, cookie)).json.grants.length, 1);
    h.clock.advance(1);
    assert.deepEqual((await list(h, cookie)).json.grants, []);
    assert.equal(events(h, "break-glass.expired").length, 1);
    await list(h, cookie); assert.equal(events(h, "break-glass.expired").length, 1, "written once");
  } finally { await h.close(); }
});

test("revoke: the holder or an Owner may end a grant; another Admin may not; an unknown grant is a 404; it is audited", async () => {
  const h = await setup();
  try {
    const adam = await loginAs(h, "adam"); const adele = await loginAs(h, "adele"); const owner = await login(h);
    const g1 = (await grant(h, adam.cookie, { targetUserId: "u-mia", reason: REASON })).json.grant;
    const g2 = (await grant(h, adam.cookie, { targetUserId: "u-mia", reason: REASON })).json.grant;
    const rev = (c: string, id: string) => write(h, c, { path: "/api/v1/breakglass/revoke", body: { grantId: id } });
    assert.deepEqual([(await rev(adele.cookie, g1.id)).status, (await rev(adele.cookie, g1.id)).json.reason], [403, "role-denied"]);
    assert.equal((await rev(adam.cookie, g1.id)).status, 200);
    assert.equal((await rev(owner.cookie, g2.id)).status, 200, "an Owner may end anyone's");
    assert.equal((await rev(adam.cookie, g1.id)).status, 404); assert.equal((await rev(adam.cookie, "nope")).status, 404);
    assert.equal((await rev(adam.cookie, "")).status, 400);
    assert.deepEqual((await list(h, adam.cookie)).json.grants, []);
    assert.equal(events(h, "break-glass.revoked").length, 2);
  } finally { await h.close(); }
});

test("the list shows only the caller's own live grants", async () => {
  const h = await setup();
  try {
    const adam = await loginAs(h, "adam"); const adele = await loginAs(h, "adele");
    await grant(h, adam.cookie, { targetUserId: "u-mia", reason: REASON });
    assert.equal((await list(h, adam.cookie)).json.grants.length, 1); assert.deepEqual((await list(h, adele.cookie)).json.grants, []);
  } finally { await h.close(); }
});

test("NoticeInbox: per user, newest first, bounded, and nothing is shared between users", () => {
  const inbox = new NoticeInbox(new FakeClock(), 3);
  const n = (id: string, user = "u1"): BreakGlassNotice => ({ kind: "granted", userId: user, grantId: id, holderUserId: "h", reason: "r", expiresAt: 1 });
  for (const id of ["a", "b", "c", "d"]) inbox.add(n(id));
  inbox.add(n("z", "u2"));
  assert.deepEqual(inbox.list("u1").map((x) => x.grantId), ["d", "c", "b"]); assert.deepEqual(inbox.list("u2").map((x) => x.grantId), ["z"]); assert.deepEqual(inbox.list("u3"), []);
});
