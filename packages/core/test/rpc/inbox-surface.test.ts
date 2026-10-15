import { test } from "node:test";
import assert from "node:assert/strict";
import { validateParams, validateResult, validateNotification } from "@plur1bus/rpc-schema";
import { InboxStore, createInboxService, buildInboxSurface, deliverInboxChange, type InboxChange } from "../../src/inbox/index.ts";
import { guardMethods, RPC_RULES } from "../../src/rbac/guard.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { RpcError } from "../../src/rpc/errors.ts";

const isCode = (code: string) => (e: unknown) => e instanceof RpcError && e.error === code;
const person = (userId: string, role: Principal["role"] = "member"): Principal => ({ userId, role, kind: "person" });

function fixture() {
  let now = 1_000;
  const store = new InboxStore({ path: ":memory:", clock: () => now });
  const changes: InboxChange[] = [];
  const metrics: string[] = [];
  const service = createInboxService({ store, admins: () => ["root", "adm"], onChange: c => changes.push(c), onPublished: k => metrics.push(k) });
  let principal: Principal | null = person("alice");
  const raw = buildInboxSurface(() => service);
  const methods = guardMethods(raw, { resolve: () => principal, audit: memoryAuditSink(), now: () => now });
  const ctx = { signal: new AbortController().signal, requestId: "1", connectionId: "c" };
  const call = async (method: string, params: any = {}) => {
    assert.deepEqual(validateParams(method, params), { ok: true }, `${method} params`);
    const result = await methods[method]!(params, ctx);
    assert.deepEqual(validateResult(method, result), { ok: true }, `${method} result`);
    return result as any;
  };
  return { store, service, changes, metrics, raw, methods, call, ctx, tick: (n: number) => { now += n; }, as: (p: Principal | null) => { principal = p; } };
}
const note = (over: Record<string, unknown> = {}) => ({ kind: "approval" as const, severity: "info" as const, titleKey: "inbox.approval.requested", dedupeKey: "approval:1", userId: "alice", ...over });

test("every inbox method has an RBAC rule; no identity, an agent or an unknown role never reaches the data", async () => {
  const f = fixture();
  for (const method of Object.keys(f.raw)) {
    assert.ok(RPC_RULES[method]?.action.startsWith("inbox."), method);
    f.as(null); await assert.rejects(f.methods[method]!({ ids: ["x"] }, f.ctx), isCode("E_UNAUTHORIZED"));
    f.as({ userId: "bot", kind: "agent", role: "owner" }); await assert.rejects(f.methods[method]!({ ids: ["x"] }, f.ctx), isCode("E_DENIED"));
    f.as({ userId: "alice", kind: "person", role: "unknown" as never }); await assert.rejects(f.methods[method]!({ ids: ["x"] }, f.ctx), isCode("E_DENIED"));
    f.as({ userId: "alice", kind: "person", role: "owner", tokenScopes: [] }); await assert.rejects(f.methods[method]!({ ids: ["x"] }, f.ctx), isCode("E_DENIED"));
    // the unguarded handler still refuses an unauthenticated context
    await assert.rejects(f.raw[method]!({ ids: ["x"] }, f.ctx), isCode("E_UNAUTHORIZED"));
  }
  f.store.close();
});

test("every human role reads and manages its own inbox", async () => {
  const f = fixture();
  for (const role of ["owner", "admin", "operator", "member", "viewer"] as const) {
    f.as(person("alice", role));
    assert.equal((await f.call("inbox.count")).total, 0);
    assert.deepEqual((await f.call("inbox.list")).entries, []);
  }
  f.store.close();
});

test("a person sees only their own entries; owner and admin get no view into foreign inboxes", async () => {
  const f = fixture();
  f.service.publish(note({ userId: "alice", dedupeKey: "a" }));
  f.service.publish(note({ userId: "bob", dedupeKey: "b" }));
  f.as(person("bob")); const bobIds = (await f.call("inbox.list")).entries.map((e: any) => e.id);
  assert.equal(bobIds.length, 1);
  f.as(person("alice"));
  const alice = (await f.call("inbox.list")).entries;
  assert.equal(alice.length, 1);
  assert.ok(!bobIds.includes(alice[0].id));
  for (const role of ["owner", "admin"] as const) {
    f.as(person("root", role));
    assert.deepEqual((await f.call("inbox.list")).entries, [], "an admin's inbox is the admin's own");
    assert.equal((await f.call("inbox.count")).total, 0);
    assert.equal((await f.call("inbox.markRead", { ids: [alice[0].id] })).changed, 0);
    assert.equal((await f.call("inbox.dismiss", { ids: [alice[0].id, ...bobIds] })).changed, 0);
  }
  // there is no way to name another person: the params are closed
  assert.equal(validateParams("inbox.list", { userId: "alice" }).ok, false);
  assert.equal(validateParams("inbox.count", { userId: "alice" }).ok, false);
  f.as(person("alice"));
  assert.equal((await f.call("inbox.count")).unread.approval, 1, "foreign attempts changed nothing");
  f.store.close();
});

test("list filters, pages by cursor and rejects a bad cursor with E_INBOX_CURSOR", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.service.publish(note({ dedupeKey: `k${i}`, kind: i % 2 ? "channel" : "approval" }));
  const p1 = await f.call("inbox.list", { limit: 2 });
  assert.equal(p1.entries.length, 2);
  assert.equal(typeof p1.nextCursor, "string");
  const p2 = await f.call("inbox.list", { limit: 2, cursor: p1.nextCursor });
  const p3 = await f.call("inbox.list", { limit: 2, cursor: p2.nextCursor });
  assert.equal(p3.nextCursor, null);
  assert.equal(new Set([...p1.entries, ...p2.entries, ...p3.entries].map((e: any) => e.id)).size, 5);
  assert.equal((await f.call("inbox.list", { kinds: ["channel"] })).entries.length, 2);
  await assert.rejects(f.methods["inbox.list"]!({ cursor: "garbage" }, f.ctx), (e: unknown) => isCode("E_INBOX_CURSOR")(e) && (e as RpcError).reason === "inbox-cursor");
  f.store.close();
});

test("count, markRead (ids | all) and dismiss", async () => {
  const f = fixture();
  f.service.publish(note({ dedupeKey: "1" })); f.service.publish(note({ dedupeKey: "2", kind: "channel" })); f.service.publish(note({ dedupeKey: "3", kind: "channel" }));
  assert.deepEqual((await f.call("inbox.count")).unread, { breakglass: 0, approval: 1, "job-failed": 0, update: 0, "media-index": 0, pairing: 0, channel: 2, system: 0 });
  const ids = (await f.call("inbox.list")).entries.map((e: any) => e.id);
  assert.equal((await f.call("inbox.markRead", { ids: [ids[0]] })).changed, 1);
  assert.equal((await f.call("inbox.markRead", { all: true })).changed, 2);
  assert.equal((await f.call("inbox.count")).total, 3);
  assert.equal((await f.call("inbox.dismiss", { ids })).changed, 3);
  assert.equal((await f.call("inbox.count")).total, 0);
  // exactly one of ids | all
  await assert.rejects(f.methods["inbox.markRead"]!({}, f.ctx), isCode("E_INVALID_PARAMS"));
  await assert.rejects(f.methods["inbox.markRead"]!({ ids: ["x"], all: true }, f.ctx), isCode("E_INVALID_PARAMS"));
  await assert.rejects(f.methods["inbox.dismiss"]!({ ids: [] }, f.ctx), isCode("E_INVALID_PARAMS"));
  f.store.close();
});

test("inbox.changed is raised once per real change, carries no entry data, and never for a no-op", async () => {
  const f = fixture();
  f.service.publish(note());
  f.service.publish(note()); // duplicate: nothing happens
  assert.deepEqual(f.changes, [{ userId: "alice", change: "created", kinds: ["approval"] }]);
  const id = (await f.call("inbox.list")).entries[0].id;
  await f.call("inbox.markRead", { all: true });
  await f.call("inbox.markRead", { all: true }); // nothing left to change
  await f.call("inbox.dismiss", { ids: [id] });
  await f.call("inbox.dismiss", { ids: [id] });
  assert.deepEqual(f.changes.map(c => c.change), ["created", "read", "dismissed"]);
  f.service.settle({ userId: "alice" }, "approval:never-existed");
  f.service.publish(note({ dedupeKey: "approval:7" }));
  f.service.settle({ userId: "alice" }, "approval:7");
  assert.deepEqual(f.changes.slice(3).map(c => c.change), ["created", "settled"]);
  for (const c of f.changes) assert.deepEqual(validateNotification("inbox.changed", { change: c.change, kinds: c.kinds }), { ok: true });
  f.store.close();
});

test("publishing to the admin audience reaches every owner/admin exactly once", () => {
  const f = fixture();
  f.service.publish({ audience: "admins", kind: "channel", severity: "warning", titleKey: "inbox.channel.misconfigured", dedupeKey: "channel:tg", params: { channel: "tg" } });
  f.service.publish({ audience: "admins", kind: "channel", severity: "warning", titleKey: "inbox.channel.misconfigured", dedupeKey: "channel:tg", params: { channel: "tg" } });
  assert.equal(f.store.count("root").total, 1);
  assert.equal(f.store.count("adm").total, 1);
  assert.equal(f.store.count("alice").total, 0);
  assert.deepEqual(f.metrics, ["channel", "channel"], "one metric tick per created entry, labelled by kind only");
  f.store.close();
});

test("the port never throws into a producer, even on invalid input or a closed store", () => {
  const f = fixture();
  assert.doesNotThrow(() => f.service.publish({ ...note(), kind: "bogus" as never }));
  assert.doesNotThrow(() => f.service.publish({ ...note(), userId: "" }));
  f.store.close();
  assert.doesNotThrow(() => f.service.publish(note()));
  assert.doesNotThrow(() => f.service.settle({ userId: "alice" }, "x"));
});

test("a throwing change listener never undoes the write", () => {
  const store = new InboxStore({ path: ":memory:", clock: () => 1 });
  const service = createInboxService({ store, admins: () => [], onChange: () => { throw new Error("socket gone"); } });
  service.publish(note());
  assert.equal(store.count("alice").total, 1);
  store.close();
});

test("the surface answers E_NOT_AVAILABLE while the inbox is not up", async () => {
  const raw = buildInboxSurface(() => null);
  const ctx = { signal: new AbortController().signal, requestId: "1", connectionId: "c" };
  const methods = guardMethods(raw, { resolve: () => person("alice"), now: () => 1 });
  await assert.rejects(methods["inbox.count"]!({}, ctx), isCode("E_NOT_AVAILABLE"));
});

test("live delivery targets only matching person connections among mixed subscribers", async () => {
  const sent: { method: string; params: object; opts: object }[] = [];
  const subs = (...ids: string[]) => ids.map(connectionId => ({ connectionId, names: ["inbox.changed"] as const }));
  const who: Record<string, Principal | null> = { a1: person("alice"), a2: person("alice", "viewer"), b1: person("bob"), ag: { userId: "bot", kind: "agent", role: "member" }, none: null };
  const run = async (connections: string[], other: { connectionId: string; names?: readonly string[] }[] = []) => {
    sent.length = 0;
    await deliverInboxChange({ userId: "alice", change: "created", kinds: ["approval"] }, {
      subscriptions: () => [...subs(...connections), ...other],
      principalOf: async id => who[id],
      notify: (method, params, opts) => { sent.push({ method, params, opts }); },
    });
    return sent.slice();
  };
  const ok = await run(["a1", "a2"]);
  assert.equal(ok.length, 1);
  assert.deepEqual(ok[0]!.params, { change: "created", kinds: ["approval"] }, "no userId, no entry data");
  assert.deepEqual(ok[0]!.opts, { optIn: true, audience: [{ connectionId: "a1" }, { connectionId: "a2" }] });
  assert.deepEqual((await run(["a1", "b1"]))[0]!.opts, { optIn: true, audience: [{ connectionId: "a1" }] }, "foreign subscriber excluded");
  assert.deepEqual((await run(["a1", "ag"]))[0]!.opts, { optIn: true, audience: [{ connectionId: "a1" }] }, "agent excluded");
  assert.deepEqual((await run(["a1", "none"]))[0]!.opts, { optIn: true, audience: [{ connectionId: "a1" }] }, "unresolved subscriber excluded");
  assert.equal((await run(["b1", "ag", "none"])).length, 0, "no matching person means no event");
  assert.equal((await run([])).length, 0);
  assert.equal((await run(["a1"], [{ connectionId: "b1", names: ["other.event"] }])).length, 1, "subscribers to other events do not matter");
  assert.equal((await run(["a1"], [{ connectionId: "b1" }])).length, 1, "a nameless subscription cannot receive an optIn event, so it does not matter");
});
