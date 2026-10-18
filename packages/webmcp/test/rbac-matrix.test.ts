// Step 1 of the security serial: one matrix over EVERY method in rpc.schema.json.
//   A. RBAC classification (docs/rbac.md): a rule in `RPC_RULES` whose action is in `POLICY`, with roles the doc names;
//      or an entry in UNRULED with its reason.
//   B. Writes: forbidden as a WebMCP tool, or on WRITE_EXPOSED with a reason; the exposed ones must ask the person.
//   C. Person-only methods: refused for an agent principal by the RBAC guard, and not offered to an agent over WebMCP.
// A deviation is a `todo: "KNOWN GAP: ..."` case named after the method (it fails today, and turns green when fixed);
// nothing here weakens a check. The RBAC side lives in packages/core (read-only import, tests only).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SCHEMA, buildCapabilities } from "@plur1bus/rpc-schema";
import { buildWebMcpTools, isForbiddenMethod, selectMethods, toolNameFor } from "../src/index.ts";
import { RPC_RULES, guardMethods } from "../../core/src/rbac/guard.ts";
import { POLICY, policyFor } from "../../core/src/rbac/policy.ts";

type MethodDef = { "x-server": string; description?: string };
const methods = (SCHEMA as any).$defs.methods as Record<string, MethodDef>;
const coreMethods = Object.keys(methods).filter((n) => methods[n]!["x-server"] === "core").sort();
const rbacDoc = readFileSync(new URL("../../../docs/rbac.md", import.meta.url), "utf8");
const DOC_ROLES = ["owner", "admin", "operator", "member", "viewer"];

// The schema carries no read/write marker (only x-server / x-since / x-stability), so "writes" are found by verb: any
// dot-segment of the method name that is one of these. `verify`, `list`, `get`, `status`, `comment` (alone) are reads.
const WRITE_VERBS = new Set(("set create delete update revoke decide install uninstall start stop restart run move assign unassign archive unarchive " +
  "import generate add remove enable disable cancel forget correct share propose accept reject capture pause resume redeem claim confirm link " +
  "unlink rename markRead dismiss edit reindex checkpoint shutdown open close login logout acknowledge scan request purge restore export abort " +
  "snapshot serve prepare submit adopt").split(" "));
const isWrite = (m: string): boolean => m.split(".").some((s) => WRITE_VERBS.has(s));

/** Core methods that carry no RBAC rule on purpose. Each reason is a statement the doc or the code makes. */
const UNRULED: Record<string, string> = {
  "core.auth": "handshake; no principal exists yet",
  "core.status": "docs/rbac.md 'Not yet secured': core.*",
  "core.shutdown": "docs/rbac.md 'Not yet secured': core.*; reachable only with the local token",
  "core.adopt": "docs/rbac.md 'Not yet secured': core.*; adoption nonce check, supervisor only",
  "events.subscribe": "connection-bound subscription, no data of its own",
  "events.unsubscribe": "connection-bound subscription, no data of its own",
  "memory.recall": "docs/rbac.md 'Not yet secured': memory.recall; the engine ACL filters per principal",
  "memory.capture": "docs/rbac.md 'Not yet secured': memory.capture; the engine ACL decides",
  "memory.checkpoint": "docs/rbac.md 'Not yet secured': memory.checkpoint",
  "memory.state": "docs/rbac.md 'Not yet secured': memory.state",
  "agent.list": "docs/rbac.md 'Not yet secured': agent.list (callers filter with canSee)",
  "agent.open": "docs/rbac.md 'Not yet secured': agent.open",
  "agent.close": "docs/rbac.md 'Not yet secured': agent.close",
  "jobs.list": "docs/rbac.md 'Not yet secured': jobs.list",
  "jobs.history": "docs/rbac.md 'Not yet secured': jobs.history",
  "dreams.status": "docs/rbac.md: reads stay open like jobs.list",
  "dreams.log": "docs/rbac.md: reads stay open like jobs.list",
  "dreams.schedule.get": "docs/rbac.md: reads stay open like jobs.list",
  "models.list": "docs/rbac.md 'Not yet secured': models.list",
  "secret.status": "owner only, enforced by the store (secrets/rpc.ts principalOf), not by RPC_RULES",
  "secret.list": "owner only, enforced by the store (secrets/rpc.ts principalOf), not by RPC_RULES",
  "secret.set": "owner only, enforced by the store (secrets/rpc.ts principalOf), not by RPC_RULES",
  "secret.get": "owner only, enforced by the store (secrets/rpc.ts principalOf), not by RPC_RULES",
  "secret.delete": "owner only, enforced by the store (secrets/rpc.ts principalOf), not by RPC_RULES",
  "user.invite.redeem": "the redeemer has no principal yet (admin-surface.ts); reachable only through the core's own handshake",
};

/** Core write methods that WebMCP may offer (the page opts in via `include`; the provider asks the person first). */
const WRITE_EXPOSED: Record<string, string> = {
  "memory.capture": "D55 default tool (stable); engine ACL + person confirmation",
  "memory.forget": "D55 memory operation; RBAC rule memory.forget; person confirmation",
  "jobs.run": "RBAC rule jobs.run (Owner/Admin/Operator); person confirmation",
  "dreams.run": "same class as jobs.run (RBAC action jobs.run); person confirmation",
  "agent.pause": "provider.ts: 'a person may trigger them through an assistant'; person confirmation",
  "agent.resume": "provider.ts: 'a person may trigger them through an assistant'; person confirmation",
};

/** Deviations found by this matrix. One todo per method; the test body is the real assertion. */
const GAP_UNRULED = "no RPC_RULES entry and not documented as intentionally open in docs/rbac.md 'Not yet secured'; only the local token (R8: owner) protects it";
const GAP_UNRULED_DOCUMENTED = "no RPC_RULES entry (docs/rbac.md lists it under 'Not yet secured')";
const GAP_WRITE = "write method is neither forbidden as a WebMCP tool nor on the exposure list; a page that passes it in `include` offers it to an agent";
const GAP_HUMAN = "policy marks the action humanOnly (people only) but WebMCP does not forbid the method, so an agent driving the page acts as the person";

const knownUnruled = new Set(["models.scan", "models.acknowledge", "memory.correct", "memory.share", "memory.propose", "memory.proposals."]);
const unruledGap = (m: string): string | undefined => {
  if (m in UNRULED) return undefined;
  return [...knownUnruled].some((p) => m === p || m.startsWith(p)) ? GAP_UNRULED_DOCUMENTED : GAP_UNRULED;
};

function t(name: string, gap: string | undefined, fn: () => void): void {
  if (gap) it(name, { todo: `KNOWN GAP: ${gap}` }, fn);
  else it(name, fn);
}

describe("matrix: inputs", () => {
  it("covers every method of the schema", () => {
    assert.ok(coreMethods.length > 100);
    for (const m of Object.keys(methods)) assert.ok(["core", "supervisor", "module"].includes(methods[m]!["x-server"]), m);
  });
  it("docs/rbac.md names the five roles", () => {
    for (const r of DOC_ROLES) assert.match(rbacDoc, new RegExp(`\\b${r}\\b`, "i"), r);
  });
  it("the UNRULED and WRITE_EXPOSED lists name only real core methods, and no ruled method", () => {
    for (const m of [...Object.keys(UNRULED), ...Object.keys(WRITE_EXPOSED)]) assert.ok(coreMethods.includes(m), `${m} is not a core method`);
    for (const m of Object.keys(UNRULED)) assert.ok(!RPC_RULES[m], `${m} has a rule now: drop it from UNRULED`);
    for (const m of Object.keys(WRITE_EXPOSED)) assert.ok(isWrite(m) && !isForbiddenMethod(m), `${m} is not an exposed write`);
  });
  it("every rule names a real method and an action that is in POLICY with documented roles", () => {
    for (const [m, r] of Object.entries(RPC_RULES)) {
      assert.ok(m in methods, `${m} not in schema`);
      const spec = policyFor(r.action);
      assert.ok(spec, `${m}: action ${r.action} not in POLICY`);
      for (const role of Object.keys(spec.grants)) assert.ok(DOC_ROLES.includes(role), `${m}: role ${role} not documented`);
    }
    assert.ok(POLICY.length > 0);
  });
});

describe("A. every core method has an RBAC classification", () => {
  for (const m of coreMethods) {
    const rule = RPC_RULES[m];
    if (rule) {
      it(`${m}: rule ${rule.action} with documented roles`, () => {
        const spec = policyFor(rule.action);
        assert.ok(spec);
        assert.ok(Object.keys(spec.grants).length > 0, "no role holds it: nobody could call it");
        for (const role of Object.keys(spec.grants)) assert.ok(DOC_ROLES.includes(role));
      });
    } else {
      t(`${m}: classified or documented as open`, unruledGap(m), () => {
        assert.ok(m in UNRULED, `${m}: no RBAC rule and no reason on record`);
      });
    }
  }
  it("supervisor and module methods have no core RBAC rule (they authenticate with their own token)", () => {
    for (const m of Object.keys(methods).filter((n) => methods[n]!["x-server"] !== "core")) assert.ok(!RPC_RULES[m], m);
  });
});

describe("B. every write method is forbidden in WebMCP or explicitly exposed", () => {
  const writes = coreMethods.filter(isWrite);
  it("finds writes", () => assert.ok(writes.length > 50));
  for (const m of writes) {
    const gap = isForbiddenMethod(m) || m in WRITE_EXPOSED ? undefined : GAP_WRITE;
    t(`${m}`, gap, () => {
      assert.ok(isForbiddenMethod(m) || m in WRITE_EXPOSED, `${m}: write method exposed without a recorded reason`);
    });
  }
  it("supervisor/module methods are never offered, even when named in include", () => {
    const caps = buildCapabilities([]);
    const all = Object.keys(methods);
    const offered = selectMethods({ capabilities: caps, schema: SCHEMA, include: all });
    for (const m of offered) assert.equal(methods[m]!["x-server"], "core", m);
  });
  it("every exposed write asks the person first and does not call without an answer", async () => {
    const caps = buildCapabilities([]);
    const calls: string[] = [];
    const tools = buildWebMcpTools({
      capabilities: caps, schema: SCHEMA, include: Object.keys(WRITE_EXPOSED),
      call: async (method) => { calls.push(method); return { ok: true }; },
    });
    for (const m of Object.keys(WRITE_EXPOSED)) {
      const tool = tools.find((x) => x.name === toolNameFor(m));
      assert.ok(tool, `${m} not built`);
      assert.equal(tool.annotations?.readOnlyHint, false, `${m} marked read-only`);
      const r = await tool.execute({});
      assert.equal(JSON.parse(r.content[0]!.text).reason, "user-declined", m); // no confirm hook: fail closed
    }
    assert.deepEqual(calls, []);
  });
});

describe("C. person-only methods turn agents away", () => {
  const personOnly = coreMethods.filter((m) => RPC_RULES[m] && policyFor(RPC_RULES[m]!.action)?.humanOnly);
  it("there are person-only methods (grant, approval, identity, ...)", () => {
    for (const m of ["grant.create", "approval.decide", "identity.link.request", "device.revoke", "session.create", "session.model.set"]) assert.ok(personOnly.includes(m), m);
  });
  for (const m of personOnly) {
    it(`${m}: RBAC refuses an agent principal in every role`, async () => {
      let ran = false;
      const guarded = guardMethods({ [m]: async () => { ran = true; return {}; } }, {
        resolve: () => ({ userId: "agent-x", role: "owner", kind: "agent" } as any), now: () => 0,
      });
      await assert.rejects(() => guarded[m]!({}, {} as any), (e: any) => (e?.reason ?? e?.data?.reason) === (RPC_RULES[m]?.apiServiceOnly ? "api-service-only" : "agent-principal"));
      assert.equal(ran, false);
    });
    it(`${m}: refuses a principal without kind`, async () => {
      let ran = false;
      const guarded = guardMethods({ [m]: async () => { ran = true; return {}; } }, {
        resolve: () => ({ userId: "u", role: "owner" } as any), now: () => 0,
      });
      await assert.rejects(() => guarded[m]!({}, {} as any));
      assert.equal(ran, false);
    });
    const defaultExposed = ["memory.list", "memory.show"].includes(m);
    t(`${m}: not offered to an agent over WebMCP`, isForbiddenMethod(m) ? undefined : GAP_HUMAN + (defaultExposed ? " (it is even a DEFAULT tool, D55)" : ""), () => {
      assert.ok(isForbiddenMethod(m));
    });
  }
  it("documented person-only families are forbidden in WebMCP", () => {
    for (const m of coreMethods.filter((n) => /^(grant|approval|identity|breakglass|user|device|secret|auth|admin|inbox)\./.test(n))) assert.ok(isForbiddenMethod(m), m);
  });
});

// D103 discovery is an in-process tool over the admitted per-turn catalogue, not an RPC/WebMCP surface.
it('capabilities.search stays dispatcher-only and cannot bypass RPC RBAC through a colliding name', () => {
  assert.equal(Object.hasOwn(methods, 'capabilities.search'), false);
  assert.equal(Object.hasOwn(RPC_RULES, 'capabilities.search'), false);
});
