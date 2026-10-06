import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authorize, canSee } from "../../src/rbac/authorize.ts";
import type { BreakGlassGrant, Principal, Resource } from "../../src/rbac/types.ts";

const NOW = 5_000;
const p = (over: Partial<Principal> = {}): Principal => ({ userId: "u1", role: "member", ...over });
const grant = (over: Partial<BreakGlassGrant> = {}): BreakGlassGrant =>
  ({ id: "g1", holderUserId: "u1", targetUserId: "u2", reason: "investigating ticket 12", issuedAt: 1_000, expiresAt: 9_000, ...over });
const card = (ownerUserId: string): Resource => ({ kind: "memory", scope: "user", ownerUserId });
const priv = (agentId: string): Resource => ({ kind: "memory", scope: "agent-private", agentId });

describe("privacy (ADR-007 §Privacy)", () => {
  it("user-scope cards: only the owning user, whatever the role below Admin", () => {
    for (const role of ["operator", "member", "viewer"] as const) {
      assert.equal(authorize(p({ role }), "memory.user.read", card("u1")).effect, "allow", role);
      assert.deepEqual(authorize(p({ role }), "memory.user.read", card("u2")), { effect: "deny", reason: "not-owner" }, role);
    }
  });

  it("Owner and Admin read another user's cards only through a live break-glass; denial says so", () => {
    for (const role of ["owner", "admin"] as const) {
      assert.deepEqual(authorize(p({ role }), "memory.user.read", card("u2"), { now: NOW }), { effect: "deny", reason: "break-glass-required" });
      assert.deepEqual(authorize(p({ role, breakGlass: [grant()] }), "memory.user.read", card("u2"), { now: NOW }), { effect: "allow", reason: "break-glass", breakGlassId: "g1" });
    }
  });

  it("break-glass is read only, per target, per holder, and never expired or revoked", () => {
    const admin = (g: BreakGlassGrant) => p({ role: "admin", breakGlass: [g] });
    assert.equal(authorize(admin(grant()), "memory.user.write", card("u2"), { now: NOW }).effect, "deny", "no write on another's cards");
    assert.equal(authorize(admin(grant({ targetUserId: "u3" })), "memory.user.read", card("u2"), { now: NOW }).effect, "deny", "other target");
    assert.equal(authorize(admin(grant({ holderUserId: "u9" })), "memory.user.read", card("u2"), { now: NOW }).effect, "deny", "someone else's grant");
    assert.equal(authorize(admin(grant({ revokedAt: 4_000 })), "memory.user.read", card("u2"), { now: NOW }).effect, "deny", "revoked");
    assert.equal(authorize(admin(grant({ expiresAt: NOW })), "memory.user.read", card("u2"), { now: NOW }).effect, "deny", "expiry instant is outside the window");
    assert.equal(authorize(admin(grant({ expiresAt: NOW + 1 })), "memory.user.read", card("u2"), { now: NOW }).effect, "allow", "last live instant");
    assert.equal(authorize(admin(grant({ issuedAt: NOW + 1 })), "memory.user.read", card("u2"), { now: NOW }).effect, "deny", "not yet issued");
  });

  it("without ctx.now no break-glass is honoured (authorize never reads a clock)", () => {
    assert.equal(authorize(p({ role: "admin", breakGlass: [grant()] }), "memory.user.read", card("u2")).effect, "deny");
    assert.equal(authorize(p({ role: "admin", breakGlass: [grant()] }), "memory.user.read", card("u2"), { now: Number.NaN }).effect, "deny");
  });

  it("agent-private cards need `manage` on that very agent", () => {
    const m = (rights: Record<string, "use" | "manage">) => p({ agentRights: rights });
    assert.deepEqual(authorize(m({ a1: "use" }), "memory.agent-private.read", priv("a1")), { effect: "deny", reason: "object-right-required" });
    assert.equal(authorize(m({ a1: "manage" }), "memory.agent-private.read", priv("a1")).effect, "allow");
    assert.equal(authorize(m({ a1: "manage" }), "memory.agent-private.read", priv("a2")).effect, "deny", "manage on one agent is not manage on another");
    assert.equal(authorize(p({ role: "operator", agentRights: { a1: "manage" } }), "memory.agent-private.read", priv("a1")).effect, "deny", "Operator has no capability here");
    assert.equal(authorize(p({ role: "viewer", agentRights: { a1: "manage" } }), "memory.agent-private.read", priv("a1")).effect, "deny");
  });

  it("a card's scope must match the action's: a workspace card is not judged by the agent-private rule", () => {
    assert.equal(authorize(p({ role: "owner" }), "memory.agent-private.read", { kind: "memory", scope: "workspace", agentId: "a1" }).reason, "resource-mismatch");
    assert.equal(authorize(p({ role: "owner" }), "memory.user.read", priv("a1")).reason, "resource-mismatch");
  });
});

describe("object rights", () => {
  it("manage implies use, use does not imply manage; lead implies member", () => {
    assert.equal(authorize(p({ agentRights: { a1: "manage" } }), "agent.use", { kind: "agent", agentId: "a1" }).effect, "allow");
    assert.equal(authorize(p({ agentRights: { a1: "use" } }), "agent.manage", { kind: "agent", agentId: "a1" }).effect, "deny");
    assert.equal(authorize(p({ projectRights: { p1: "lead" } }), "project.write", { kind: "project", projectId: "p1" }).effect, "allow");
    assert.equal(authorize(p({ projectRights: { p1: "member" } }), "project.manage", { kind: "project", projectId: "p1" }).effect, "deny");
  });

  it("a Member sees only the agents shared with them (M3 acceptance 3)", () => {
    const agents: Resource[] = ["a1", "a2", "a3"].map((agentId) => ({ kind: "agent", agentId }));
    const member = p({ agentRights: { a2: "use" } });
    assert.deepEqual(canSee(member, "agent.read", agents), [{ kind: "agent", agentId: "a2" }]);
    assert.equal(canSee(p({ role: "admin" }), "agent.read", agents).length, 3);
    assert.equal(canSee(p({ role: "viewer" }), "agent.read", agents).length, 0, "a Viewer with nothing shared sees nothing");
  });

  it("rights table keys are own properties only", () => {
    for (const agentId of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      assert.equal(authorize(p({ agentRights: {} }), "agent.read", { kind: "agent", agentId }).effect, "deny", agentId);
    }
  });

  it("a right on an agent id never carries over to a project of the same id", () => {
    assert.equal(authorize(p({ agentRights: { x: "manage" } }), "project.write", { kind: "project", projectId: "x" }).effect, "deny");
  });
});

describe("token scopes only narrow (ADR-007 enforcement table)", () => {
  const res: Resource = { kind: "system" };
  it("effective capability is role ∩ scopes", () => {
    assert.equal(authorize(p({ role: "admin", tokenScopes: ["models.read"] }), "models.read", res).effect, "allow");
    assert.deepEqual(authorize(p({ role: "admin", tokenScopes: ["models.read"] }), "models.write", res), { effect: "deny", reason: "token-scope" });
    assert.equal(authorize(p({ role: "admin", tokenScopes: ["models.*"] }), "models.write", res).effect, "allow");
    assert.equal(authorize(p({ role: "admin", tokenScopes: ["models.*"] }), "providers.write", res).reason, "token-scope");
    assert.equal(authorize(p({ role: "admin", tokenScopes: [] }), "models.read", res).effect, "deny", "an empty scope list grants nothing");
  });
  it("scopes never widen a role", () => {
    assert.deepEqual(authorize(p({ role: "viewer", tokenScopes: ["*", "models.*"] }), "models.write", res), { effect: "deny", reason: "role-denied" });
    assert.equal(authorize(p({ role: "admin", tokenScopes: ["*"] }), "models.read", res).reason, "token-scope", "a bare `*` is not a scope");
  });
  it("a `prefix.*` scope does not match a longer sibling name", () => {
    assert.equal(authorize(p({ role: "owner", tokenScopes: ["memory.user.*"] }), "memory.forget", { kind: "agent", agentId: "a1" }).reason, "token-scope");
  });
});

describe("deny by default", () => {
  const sys: Resource = { kind: "system" };
  it("unknown actions are denied for every role, including Owner", () => {
    for (const role of ["owner", "admin", "operator", "member", "viewer"] as const) {
      assert.deepEqual(authorize(p({ role }), "nope.nothing", sys), { effect: "deny", reason: "unknown-action" });
    }
  });
  it("prototype-named and non-string actions are unknown", () => {
    for (const a of ["__proto__", "constructor", "toString", "", "models.read ", "MODELS.READ"]) assert.equal(authorize(p({ role: "owner" }), a, sys).reason, "unknown-action", JSON.stringify(a));
    for (const a of [undefined, null, 1, {}, ["models.read"]]) assert.equal(authorize(p({ role: "owner" }), a as never, sys).reason, "unknown-action");
  });
  it("no principal, or a malformed one, is denied", () => {
    assert.deepEqual(authorize(null, "models.read", sys), { effect: "deny", reason: "unauthenticated" });
    assert.deepEqual(authorize(undefined, "models.read", sys), { effect: "deny", reason: "unauthenticated" });
    for (const bad of [{ userId: "", role: "owner" }, { userId: "u", role: "root" }, { userId: "u", role: "__proto__" }, { userId: 7, role: "owner" }, "owner", {}]) {
      assert.equal(authorize(bad as never, "models.read", sys).reason, "invalid-principal", JSON.stringify(bad));
    }
  });
  it("a resource of the wrong shape, or with an empty id, is denied", () => {
    assert.equal(authorize(p({ role: "owner" }), "agent.use", sys).reason, "resource-mismatch");
    assert.equal(authorize(p({ role: "owner" }), "agent.use", { kind: "agent", agentId: "" }).reason, "resource-mismatch");
    assert.equal(authorize(p({ role: "owner" }), "agent.use", { kind: "agent", agentId: 5 } as never).reason, "resource-mismatch");
    assert.equal(authorize(p({ role: "owner" }), "models.read", null as never).reason, "resource-mismatch");
    assert.equal(authorize(p({ role: "owner" }), "my.read", { kind: "user", userId: "" }).reason, "resource-mismatch");
  });
  it("an empty-id principal can never match an empty owner id", () => {
    assert.equal(authorize({ userId: "", role: "member" }, "my.read", { kind: "user", userId: "" }).reason, "invalid-principal");
  });
  it("authorize does not mutate its inputs", () => {
    const principal = Object.freeze(p({ role: "admin", breakGlass: Object.freeze([Object.freeze(grant())]) }));
    const res = Object.freeze(card("u2"));
    const before = JSON.stringify([principal, res]);
    authorize(principal, "memory.user.read", res, { now: NOW });
    assert.equal(JSON.stringify([principal, res]), before);
  });
});
