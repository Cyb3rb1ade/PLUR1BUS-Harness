import test from "node:test";
import assert from "node:assert/strict";
import { AdminStore } from "../../src/identity/admin-store.ts";
test("person status is durable authority; last active Owner remains enabled and rights survive enable", () => {
  const store = new AdminStore({ path: ":memory:", ownerId: "owner-one" });
  try {
    assert.equal(store.person("owner-one")?.disabled, false);
    assert.throws(() => store.setDisabled("owner-one", true, "owner-one", 1, () => {}), { error: "E_CONFLICT" });
    store.setRole("owner-two", "owner", () => {}); store.setRight("main", "owner-one", "manage");
    store.setDisabled("owner-one", true, "owner-two", 2, () => {});
    assert.equal(store.resolvePerson("owner-one"), null);
    assert.throws(() => store.setDisabled("owner-two", true, "owner-two", 3, () => {}), { error: "E_CONFLICT" });
    const v = store.person("owner-one")!.version;
    store.setDisabled("owner-one", false, "owner-two", 4, () => {});
    assert.equal(store.resolvePerson("owner-one")?.agentRights?.main, "manage"); assert.ok(store.person("owner-one")!.version > v);
    assert.throws(() => store.setDisabled("owner-one", true, "owner-two", 5, () => { throw new Error("audit failed"); })); assert.equal(store.person("owner-one")?.disabled, false);
  } finally { store.close(); }
});
test.todo("KNOWN GAP: channel inbound ignores person.disabled; switchboard is owned by the parallel security package");

test("disable/enable role matrix, agents denied, audit principals hashed and reason bounded", async () => {
  const { buildAdminSurface } = await import("../../src/rpc/admin-surface.ts"); const { guardMethods } = await import("../../src/rbac/guard.ts");
  const roles = ["owner", "admin", "operator", "member", "viewer"] as const; const store = new AdminStore({ path: ":memory:", ownerId: "bootstrap-owner" }); const events: any[] = [];
  let who: any = { kind: "person", userId: "acting-person", role: "owner" };
  const raw = buildAdminSurface({ people: store, identity: { list: () => ({ humans: [] }) }, clock: () => 123, audit: { append: (e: unknown) => events.push(e) } } as any);
  const methods = guardMethods(raw, { resolve: () => who, now: () => 123 });
  const ctx = { connectionId: "test", requestId: "test", signal: new AbortController().signal };
  try {
    for (const role of roles) store.setRole(`target-${role}`, role, () => {});
    for (const actorRole of roles) for (const targetRole of roles) {
      who = { kind: "person", userId: "acting-person", role: actorRole }; const params = { userId: `target-${targetRole}`, reason: "maintenance\u202e\n" };
      if (actorRole === "owner" || actorRole === "admin" && ["member", "viewer"].includes(targetRole)) { await methods["user.disable"]!(params, ctx); await methods["user.enable"]!({ userId: params.userId }, ctx); }
      else await assert.rejects(methods["user.disable"]!(params, ctx), { error: "E_DENIED" });
    }
    who = { kind: "agent", userId: "acting-person", role: "owner" }; await assert.rejects(methods["user.disable"]!({ userId: "target-member" }, ctx), { error: "E_DENIED" });
    who.kind = "person"; await assert.rejects(methods["user.disable"]!({ userId: "target-member", reason: "x".repeat(201) }, ctx), { error: "E_INVALID_PARAMS" });
    const audit = JSON.stringify(events); assert.equal(audit.includes("acting-person"), false); assert.equal(audit.includes("target-member"), false); assert.equal(audit.includes("\\u202e"), false);
    assert.equal(events[0].action, "user.disabled"); assert.match(events[0].actor.user, /^[a-f0-9]{64}$/);
  } finally { store.close(); }
});
