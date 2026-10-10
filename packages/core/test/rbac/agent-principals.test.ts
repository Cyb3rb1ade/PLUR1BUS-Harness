// D109 D6 (spec 2026-09-28 §4 last paragraph): grant.* and approval.* are for people. An agent principal can never call
// them, in any state, with any role, any right, any token scope and any break-glass grant; a missing or unknown
// principal kind is treated as "not a person". The methods are also absent from every catalogue an agent can see.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RpcError } from "../../src/rpc/errors.ts";
import type { CallContext, Handler } from "../../src/rpc/server.ts";
import { authorize } from "../../src/rbac/authorize.ts";
import { LOCAL_OWNER, RPC_RULES, guardMethods } from "../../src/rbac/guard.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { POLICY, policyFor } from "../../src/rbac/policy.ts";
import { ROLES, type Principal, type Role } from "../../src/rbac/types.ts";
import { CAPABILITIES, NEVER_CAPABILITIES } from "../../src/policy/capabilities.ts";
import { FS_CAPABILITIES } from "../../src/tools/fs/tools.ts";
import { WEB_CAPABILITIES } from "../../src/tools/web/tools.ts";
import { isForbiddenMethod } from "../../../webmcp/src/provider.ts";

const NOW = 1_000_000;
const SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL("../../../rpc-schema/schema/rpc.schema.json", import.meta.url)), "utf8"));
const SCHEMA_METHODS = Object.keys(SCHEMA.$defs.methods) as string[];
const NOTIFICATIONS = Object.keys(SCHEMA.$defs.notifications) as string[];

const METHODS = ["grant.list", "grant.create", "grant.revoke", "approval.list", "approval.get", "approval.decide", "approval.cancel", "approval.verify"] as const;
const ACTIONS = ["grant.read", "grant.write", "approval.read", "approval.decide"] as const;
const PERSON_ROLES: Record<(typeof ACTIONS)[number], readonly Role[]> = {
  "grant.read": ["owner", "admin"], "grant.write": ["owner", "admin"], "approval.read": ["owner", "admin", "operator"], "approval.decide": ["owner", "admin"],
};
const PARAMS: Record<(typeof METHODS)[number], unknown> = {
  "grant.list": {}, "grant.create": { capability: "fs.write", agent: "bernd", scope: "always" }, "grant.revoke": { id: "grt_1" },
  "approval.list": { status: "pending" }, "approval.get": { id: "apr_1" }, "approval.decide": { id: "apr_1", decision: "approve" },
  "approval.cancel": { id: "apr_1" }, "approval.verify": {},
};

const ctx: CallContext = { requestId: "r1", connectionId: "c1", signal: new AbortController().signal };
const breakGlass = { id: "bg-1", holderUserId: "x", targetUserId: "someone", reason: "incident 4711 follow-up", issuedAt: NOW - 10, expiresAt: NOW + 10_000 };

/** Everything a principal could be given at once. */
const everything = (kind: Principal["kind"], role: Role): Principal => ({
  userId: "x", role, ...(kind === undefined ? {} : { kind }),
  agentRights: { bernd: "manage" }, projectRights: { p: "lead" }, breakGlass: [breakGlass],
  tokenScopes: ["grant.*", "approval.*", "grant.read", "grant.write", "approval.read", "approval.decide"],
});

describe("grant.* / approval.* policy actions (D6)", () => {
  it("exist as human-only actions on the system resource", () => {
    for (const a of ACTIONS) {
      const s = policyFor(a);
      assert.ok(s, a);
      assert.equal(s.humanOnly, true, `${a} humanOnly`);
      assert.equal(s.resource, "system", a);
    }
  });

  it("no role entry of an agent-capable action leaks: humanOnly is the only way these actions are reached", () => {
    const humanOnly = POLICY.filter((s) => s.humanOnly).map((s) => s.action).sort();
    assert.deepEqual(humanOnly, [...ACTIONS,"device.list","device.revoke","device.rename","admin.agent.operate","admin.agent.manage","admin.agent.delete","admin.agent.rights","admin.users.read","admin.users.write","admin.breakglass.read","admin.breakglass.write","admin.sessions.read","admin.sessions.write","admin.sessions.transcript","admin.pairing.read","admin.notices.read","admin.memory.read","media.read","media.write","project.create","project.surface.read","project.surface.write","identity.self.read","identity.self.write","auth.credentials.read","auth.credentials.write","channel.read","channel.write"].sort());
  });

  it("persons get exactly the roles written down, nothing else", () => {
    for (const a of ACTIONS) {
      for (const role of ROLES) {
        const d = authorize({ userId: "x", role, kind: "person" }, a, { kind: "system" }, { now: NOW });
        assert.equal(d.effect, PERSON_ROLES[a].includes(role) ? "allow" : "deny", `${role} x ${a}`);
      }
    }
  });
});

describe("agent principals are refused for every grant/approval action in every state", () => {
  for (const a of ACTIONS) {
    for (const role of ROLES) {
      it(`agent with role ${role} x ${a}: denied with everything granted (rights, scopes, break-glass)`, () => {
        for (const now of [NOW, undefined]) {
          const d = authorize(everything("agent", role), a, { kind: "system" }, now === undefined ? {} : { now });
          assert.deepEqual(d, { effect: "deny", reason: "agent-principal" });
        }
      });
    }
  }

  it("a missing or unknown principal kind is not a person (fail closed), even with the owner role", () => {
    for (const a of ACTIONS) {
      assert.deepEqual(authorize(everything(undefined, "owner"), a, { kind: "system" }, { now: NOW }), { effect: "deny", reason: "agent-principal" }, a);
    }
    const odd = { ...everything("person", "owner"), kind: "service" } as unknown as Principal;
    assert.deepEqual(authorize(odd, "grant.write", { kind: "system" }, { now: NOW }), { effect: "deny", reason: "invalid-principal" });
  });

  it("an agent is refused whatever the resource shape or token scope says (the kind check comes first)", () => {
    for (const a of ACTIONS) {
      for (const res of [{ kind: "system" }, { kind: "agent", agentId: "bernd" }, { kind: "user", userId: "x" }] as const) {
        assert.equal(authorize(everything("agent", "owner"), a, res, { now: NOW }).effect, "deny");
      }
      const narrow: Principal = { ...everything("agent", "owner"), tokenScopes: ["memory.*"] };
      assert.deepEqual(authorize(narrow, a, { kind: "system" }, { now: NOW }), { effect: "deny", reason: "agent-principal" });
    }
  });

  it("break-glass never opens a human-only action for an agent, and it is not what lets a person in either", () => {
    const person: Principal = { userId: "x", role: "operator", kind: "person", breakGlass: [breakGlass] };
    assert.equal(authorize(person, "grant.write", { kind: "system" }, { now: NOW }).effect, "deny");
    assert.equal(authorize({ ...person, kind: "agent", role: "owner" }, "approval.decide", { kind: "system" }, { now: NOW }).effect, "deny");
  });
});

describe("agent principals at the RPC guard", () => {
  const stubs = () => {
    const ran: string[] = [];
    const handlers: Record<string, Handler> = {};
    for (const m of METHODS) handlers[m] = async () => { ran.push(m); return { ok: m }; };
    return { handlers, ran };
  };
  const reason = async (h: Record<string, Handler>, m: string): Promise<string> => {
    try { await h[m]!(PARAMS[m as (typeof METHODS)[number]], ctx); return "ran"; }
    catch (e) { return e instanceof RpcError ? `${e.error}:${e.reason ?? ""}` : "other"; }
  };

  it("every method has a rule, and every rule maps to a human-only action", () => {
    for (const m of METHODS) {
      const r = RPC_RULES[m];
      assert.ok(r, `${m} has no RBAC rule`);
      assert.equal(policyFor(r.action)?.humanOnly, true, `${m} -> ${r.action}`);
    }
  });

  it("every grant.* / approval.* method of the schema is covered (a new one cannot ship unguarded)", () => {
    const inSchema = SCHEMA_METHODS.filter((m) => /^(grant|approval)\./.test(m)).sort();
    assert.deepEqual(inSchema, [...METHODS].sort());
    for (const m of inSchema) assert.ok(RPC_RULES[m], m);
  });

  for (const role of ROLES) {
    it(`an agent principal with role ${role} is refused E_DENIED agent-principal on all eight methods; no handler runs; each is audited`, async () => {
      const { handlers, ran } = stubs();
      const audit = memoryAuditSink();
      const g = guardMethods(handlers, { resolve: () => everything("agent", role), audit, now: () => 1234 });
      for (const m of METHODS) assert.equal(await reason(g, m), "E_DENIED:agent-principal", `${role} ${m}`);
      assert.deepEqual(ran, []);
      assert.equal(audit.events.length, METHODS.length);
      assert.ok(audit.events.every((e) => e.action === "rbac.denied" && (e.detail as { reason?: string }).reason === "agent-principal"));
    });
  }

  it("the local owner (a person) passes all eight; an unmarked principal does not", async () => {
    const a = stubs();
    const ok = guardMethods(a.handlers, { resolve: () => LOCAL_OWNER, now: () => 0 });
    for (const m of METHODS) assert.equal(await reason(ok, m), "ran", m);
    assert.equal(LOCAL_OWNER.kind, "person");
    const b = stubs();
    const unmarked = guardMethods(b.handlers, { resolve: () => ({ userId: "u", role: "owner" }), now: () => 0 });
    for (const m of METHODS) assert.equal(await reason(unmarked, m), "E_DENIED:agent-principal", m);
    assert.deepEqual(b.ran, []);
  });

  it("an API token with a wildcard scope cannot reach them as an agent either", async () => {
    const { handlers, ran } = stubs();
    const g = guardMethods(handlers, { resolve: () => ({ ...everything("agent", "admin"), tokenScopes: ["*", "grant.*"] }), now: () => 0 });
    for (const m of METHODS) assert.equal(await reason(g, m), "E_DENIED:agent-principal", m);
    assert.deepEqual(ran, []);
  });
});

describe("no way for an agent to become a person", () => {
  it("no RPC method takes a password, passphrase or login (there is no password route for agents)", () => {
    const bad = /pass(word|phrase|wd)|login|otp|totp/i;
    for (const m of SCHEMA_METHODS) {
      const props = Object.keys(SCHEMA.$defs.methods[m].params?.properties ?? {});
      for (const p of props) assert.equal(bad.test(p), false, `${m} takes ${p}`);
    }
  });

  it("the only way to a Principal in the rbac module is the resolver; nothing in rbac/ mints a person from a token or password", () => {
    const dir = new URL("../../src/rbac/", import.meta.url);
    for (const f of ["authorize.ts", "guard.ts", "policy.ts", "types.ts", "break-glass.ts", "audit.ts", "index.ts"]) {
      const src = readFileSync(new URL(f, dir), "utf8");
      assert.equal(/password|passwd|passphrase|bcrypt|scrypt|argon/i.test(src.replace(/\/\/.*$/gm, "")), false, `${f} handles a password`);
    }
  });

  it("break-glass grants name a person as holder: an agent kind with a live grant is still refused for human-only actions", () => {
    const agentWithGrant: Principal = { userId: "x", role: "owner", kind: "agent", breakGlass: [breakGlass] };
    for (const a of ACTIONS) assert.equal(authorize(agentWithGrant, a, { kind: "system" }, { now: NOW }).effect, "deny", a);
  });
});

describe("absent from every catalogue an agent or an outside client can see", () => {
  it("the notifications are not agent events either: the schema names them as person-only subscriptions", () => {
    for (const n of ["approval.requested", "approval.resolved", "grant.changed"]) {
      assert.ok(NOTIFICATIONS.includes(n), n);
      assert.match(SCHEMA.$defs.notifications[n].description, /never to an agent/, n);
    }
  });

  it("the agent tool catalogue (file.*, web.*) has no grant/approval tool, and the capability that would cover one is `never`", () => {
    const names = [...FS_CAPABILITIES, ...WEB_CAPABILITIES].map((e) => e.name);
    assert.ok(names.length >= 6);
    for (const n of names) assert.equal(/^(grant|approval)\./.test(n), false, n);
    const cap = CAPABILITIES.get("harness.admin");
    assert.ok(cap, "harness.admin exists");
    assert.ok(NEVER_CAPABILITIES.includes("harness.admin"));
    assert.match(cap.covers, /grants and approvals/);
  });

  it("WebMCP refuses them (the admin.* rule, B15)", () => {
    for (const m of METHODS) assert.equal(isForbiddenMethod(m), true, m);
  });
});
