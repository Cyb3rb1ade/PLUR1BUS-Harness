// Parity vectors for the RPC guard, the break-glass registry and the two audit line writers (P4-12 task 6):
//   rules        `RPC_RULES` as data: per method the action, `humanOnly`, `apiServiceOnly` and the resource its rule builds from
//                each of the parameter shapes in `shapes` (a method's `resource` is an index into `resources`).
//   guard        `guardMethods` over a grid: what the wrapped handler's caller sees (`ok` with the principal the handler reads
//                through `authenticatedPrincipal`, or the `RpcError`) and the audit events. Packed as in export-exposure.ts:
//                `tables[field]` lists the distinct JSON texts of an input, a case is `refs TAB outcome`, both indexes.
//                In a resolver's principal and in an outcome, `$A` stands for the action of the method's rule and `$M` for
//                the method (the replay puts them back), so that one text serves every method. `"authenticated": true` says
//                the handler read exactly the principal the resolver returned (`false`: an API-service-only method, which
//                runs without one).
//   break-glass  sequences against `createBreakGlass` with a scripted clock and id source: per step the result or error, the
//                audit events and the notices.
//   audit        the exact line `createJsonlAuditSink` (rbac) and `createAuditWriter` (identity) append for an event; `keys`
//                is the order of the detail's members (a fixture file sorts object keys, the line does not).
// `crates/plur1bus-core/src/rbac/guard_vectors.rs` replays every file. Recorded, never edited by hand.
//
// THE GUARD GRID (counts in `guard.index`). Methods with the same (action, humanOnly, apiServiceOnly, resource) are one class;
// layer `class` runs one method of every class over role(5) x kind(person, agent, absent) x token scopes(absent, the rule's
// action, an unrelated action), for a rule with an agent or memory resource also x agent right on `a1`(none, use, manage) x
// params(`a1`, none); then the resolver outcomes (nothing, a failure, a disabled person) and five malformed principals. Layer
// `method` runs EVERY method with three principals, so a wrong row of a single method fails. Layer `service` covers the
// `apiServiceOnly` branch (the context is the API service, an API request with a principal, or neither). Layer `fallback` is
// the memory fallback of the six methods that have one: role(owner, member, viewer) x kind(person, agent) x right(3) x
// binding(absent, `a1`) x the token scopes the fallback reads x params(2) x scoped client context or not.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-rbac-guard.ts [--check]
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindApiPrincipal, bindClientContext } from "@plur1bus/module-api";
import { createAuditWriter } from "../../packages/core/src/identity/audit.ts";
import { createJsonlAuditSink, type AuditEvent } from "../../packages/core/src/rbac/audit.ts";
import { BreakGlassError, createBreakGlass } from "../../packages/core/src/rbac/break-glass.ts";
import { RPC_RULES, authenticatedPrincipal, guardMethods } from "../../packages/core/src/rbac/guard.ts";
import { ROLES, type Principal } from "../../packages/core/src/rbac/types.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import { exporterMain } from "./lib.mjs";

type Json = any;
const NOW = 1_760_000_000_000;
const clone = (v: unknown): Json => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

// ---- rules -------------------------------------------------------------------------------------------------------------
/** Parameter shapes as JSON texts: what a JSON-decoded request can carry (so no inherited member, but an own `__proto__`). */
const SHAPES: Record<string, string> = {
  absent: "", null: "null", string: "\"a1\"", number: "7", array: "[{\"agentId\":\"a1\"}]", empty: "{}",
  agent: "{\"agentId\":\"a1\"}", "agent-other": "{\"agentId\":\"a2\",\"extra\":1}", "agent-empty": "{\"agentId\":\"\"}", "agent-number": "{\"agentId\":7}",
  "agent-null": "{\"agentId\":null}", "agent-object": "{\"agentId\":{\"agentId\":\"a1\"}}", proto: "{\"__proto__\":{\"agentId\":\"a1\"}}", "agent-proto-id": "{\"agentId\":\"__proto__\"}",
};
const paramsOf = (text: string): unknown => (text === "" ? undefined : JSON.parse(text));

function buildRules() {
  const resources: string[] = []; const index = new Map<string, number>();
  const methods = Object.entries(RPC_RULES).map(([method, r]) => {
    const text = JSON.stringify(Object.fromEntries(Object.entries(SHAPES).map(([name, shape]) => [name, r.resource(paramsOf(shape))])));
    let i = index.get(text);
    if (i === undefined) { i = resources.length; resources.push(text); index.set(text, i); }
    return { method, action: r.action, humanOnly: r.humanOnly === true, apiServiceOnly: r.apiServiceOnly === true, resource: i };
  });
  return { shapes: SHAPES, resources: resources.map((t) => JSON.parse(t)), methods };
}

// ---- guard -------------------------------------------------------------------------------------------------------------
type Resolver = { principal: Json } | { kind: "null" | "undefined" | "throws" | "throws-disabled" | "throws-denied" | "async" ; principal?: Json };
interface GuardCase { layer: string; method: string; params: string; resolver: Resolver; ctx: { client?: boolean; api?: "service" | "principal" } }

async function runGuard(c: GuardCase): Promise<string> {
  const events: AuditEvent[] = [];
  const ctx = {} as Json;
  if (c.ctx.client) bindClientContext(ctx);
  if (c.ctx.api === "service") bindApiPrincipal(ctx, null);
  if (c.ctx.api === "principal") bindApiPrincipal(ctx, { userId: "api-user", kind: "person", role: "owner" });
  let seen: Json = null;
  // The handler reads the call's identity as real handlers do; an API-service-only method has none.
  const inner = async () => { try { seen = { authenticated: JSON.stringify(authenticatedPrincipal(ctx)) === JSON.stringify(r.principal) }; } catch { seen = { authenticated: false }; } return "handled"; };
  const action = RPC_RULES[c.method]!.action;
  const r = JSON.parse(JSON.stringify(c.resolver).replaceAll("\"$A\"", JSON.stringify(action))) as Json;
  const resolve = (): Json => {
    switch (r.kind) {
      case "null": return null;
      case "undefined": return undefined;
      case "throws": throw new Error("resolver broke");
      case "throws-disabled": throw new RpcError("E_DENIED", "person is disabled", { reason: "person-disabled" });
      case "throws-denied": throw new RpcError("E_DENIED", "something else", { reason: "other" });
      case "async": return Promise.resolve(r.principal);
      default: return r.principal;
    }
  };
  const guarded = guardMethods({ [c.method]: inner }, { resolve, audit: { append: (e) => { events.push(structuredClone(e)); } }, now: () => NOW, host: "host-1" });
  let out: Json;
  try { const value = await guarded[c.method]!(paramsOf(c.params), ctx); out = { ok: value, ...seen }; }
  catch (e) { if (!(e instanceof RpcError)) throw e; out = { err: { error: e.error, message: e.message, ...(e.reason !== undefined ? { reason: e.reason } : {}) } }; }
  // After the call the context no longer names a principal.
  let after = false; try { authenticatedPrincipal(ctx); after = true; } catch { /* expected */ }
  if (after) throw new Error("the guard left a principal on the context");
  if (out.ok && seen.authenticated !== !RPC_RULES[c.method]!.apiServiceOnly) throw new Error("the handler did not read the resolved principal");
  // One text for every method: the method and the action are named where the guard puts them.
  const text = JSON.stringify({ ...out, audit: clone(events) });
  const m = JSON.stringify(c.method), a = JSON.stringify(action);
  const generic = text.replaceAll(`"target":${m}`, "\"target\":\"$M\"").replaceAll(`"action":${a}`, "\"action\":\"$A\"").replaceAll(`"message":${JSON.stringify(`not permitted: ${action}`)}`, "\"message\":\"not permitted: $A\"");
  if (generic.includes(m) || (generic.includes(a) && !["x"].includes(action))) throw new Error(`method or action left in an outcome: ${generic}`);
  return generic;
}

const person = (role: string, extra: Json = {}): Json => ({ userId: `u-${role}`, role, kind: "person", ...extra });
function principalGrid(rights: boolean): Json[] {
  const out: Json[] = [];
  for (const role of ROLES) for (const kind of ["person", "agent", undefined]) for (const right of rights ? [undefined, "use", "manage"] : [undefined]) for (const scopes of [undefined, ["$A"], ["unrelated.action"]])
    out.push({ userId: `u-${role}`, role, ...(kind ? { kind } : {}), ...(right ? { agentRights: { a1: right } } : {}), ...(scopes ? { tokenScopes: scopes } : {}) });
  return out;
}

function guardCases(): GuardCase[] {
  const cases: GuardCase[] = [];
  const classes = new Map<string, string>();
  const rules = buildRules();
  for (const m of rules.methods) { const key = JSON.stringify([m.action, m.humanOnly, m.apiServiceOnly, m.resource]); if (!classes.has(key)) classes.set(key, m.method); }
  for (const method of classes.values()) {
    const r = RPC_RULES[method]!;
    if (r.apiServiceOnly) continue;
    const onAgent = r.resource(paramsOf(SHAPES.agent!)).kind !== "system";
    for (const principal of principalGrid(onAgent)) for (const params of onAgent ? [SHAPES.agent!, SHAPES.empty!] : [SHAPES.empty!]) cases.push({ layer: "class", method, params, resolver: { principal }, ctx: {} });
    for (const kind of ["null", "undefined", "throws", "throws-disabled", "throws-denied"] as const) cases.push({ layer: "class", method, params: SHAPES.agent!, resolver: { kind }, ctx: {} });
    cases.push({ layer: "class", method, params: SHAPES.agent!, resolver: { kind: "async", principal: person("owner") }, ctx: {} });
    // Principals the types forbid but a resolver could hand over: `authorize` decides (invalid-principal), the audit line must not break.
    for (const principal of [{ userId: "", role: "owner", kind: "person" }, { userId: 7, role: "owner", kind: "person" }, { userId: "u", role: "root", kind: "person" }, { userId: "u", kind: "person" }, {}])
      cases.push({ layer: "class", method, params: SHAPES.agent!, resolver: { principal }, ctx: {} });
  }
  for (const m of rules.methods) {
    if (m.apiServiceOnly) continue;
    for (const principal of [person("owner", { agentRights: { a1: "manage" } }), person("viewer"), { userId: "agent-1", role: "owner", kind: "agent", agentRights: { a1: "manage" } }])
      for (const shape of ["agent", "absent"]) cases.push({ layer: "method", method: m.method, params: SHAPES[shape]!, resolver: { principal }, ctx: {} });
  }
  for (const m of rules.methods) {
    if (!m.apiServiceOnly) continue;
    for (const api of ["service", "principal", undefined] as const) for (const resolver of [{ principal: person("owner") }, { kind: "null" as const }, { kind: "throws" as const }])
      cases.push({ layer: "service", method: m.method, params: SHAPES.agent!, resolver, ctx: { ...(api ? { api } : {}) } });
  }
  const scopesOf: Record<string, string[][]> = {
    "external.turn.start": [["a2a.task"], ["mcp.write"], ["mcp:call"], ["mcp.read"], ["agent.use"], [], ["other"]],
    "external.turn.cancel": [["a2a.task"], ["mcp.write"], ["mcp:call"], ["mcp.read"], ["agent.use"], [], ["other"]],
    "external.turn.events": [["a2a.task"], ["mcp.read"], ["mcp:call"], ["mcp.write"], ["agent.read"], [], ["other"]],
    "external.turn.get": [["a2a.task"], ["mcp.read"], ["mcp:call"], ["mcp.write"], ["agent.read"], [], ["other"]],
    "memory.recall": [["memory.workspace.read"], ["memory.user.read"], ["memory.agent-private.read"], ["agent.use"], ["memory.*"], ["mcp.read"], [], ["other"]],
    "memory.capture": [["memory.workspace.write"], ["memory.user.write"], ["memory.agent-private.write"], ["agent.use"], ["memory.*"], ["mcp.write"], [], ["other"]],
  };
  for (const [method, scopeSets] of Object.entries(scopesOf)) {
    for (const role of ["owner", "member", "viewer"]) for (const kind of ["person", "agent"]) for (const right of [undefined, "use", "manage"]) for (const bound of [false, true])
      for (const tokenScopes of scopeSets) for (const shape of ["agent", "empty"]) for (const client of [false, true]) {
        const principal = { userId: `u-${role}`, role, kind, ...(right ? { agentRights: { a1: right } } : {}), tokenScopes, ...(bound ? { binding: { audience: "mcp", agentId: "a1" } } : {}) };
        cases.push({ layer: "fallback", method, params: SHAPES[shape]!, resolver: { principal }, ctx: { ...(client ? { client } : {}) } });
      }
    // Without token scopes there is no token-scope denial and so no fallback: the rule's own decision stands.
    for (const role of ["owner", "member", "viewer"]) for (const client of [false, true])
      cases.push({ layer: "fallback", method, params: SHAPES.agent!, resolver: { principal: person(role, { agentRights: { a1: "use" } }) }, ctx: { ...(client ? { client } : {}) } });
  }
  return cases;
}

async function buildGuard() {
  const fields = ["method", "params", "resolver", "ctx"] as const;
  const tables: Record<string, string[]> = { method: [], params: [], resolver: [], ctx: [], outcome: [] };
  const index: Record<string, Map<string, number>> = Object.fromEntries(Object.keys(tables).map((k) => [k, new Map()]));
  const ref = (table: string, text: string): number => { let i = index[table]!.get(text); if (i === undefined) { i = tables[table]!.length; tables[table]!.push(text); index[table]!.set(text, i); } return i; };
  const layers: Record<string, string[]> = {}; const counts: Record<string, number> = {};
  for (const c of guardCases()) {
    const outcome = await runGuard(c);
    const line = `${fields.map((f) => ref(f, f === "method" ? c.method : f === "params" ? c.params : JSON.stringify(c[f]))).join(".")}\t${ref("outcome", outcome)}`;
    (layers[c.layer] ??= []).push(line); counts[c.layer] = (counts[c.layer] ?? 0) + 1;
  }
  return { fields, tables, layers, index: { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), now: NOW, host: "host-1" } };
}

// ---- break-glass -------------------------------------------------------------------------------------------------------
class Glass {
  readonly steps: string[] = [];
  t = NOW; private n = 0; private events: Json[] = []; private notices: Json[] = []; sinkDown = false; notifyDown = false;
  private bg: ReturnType<typeof createBreakGlass>;
  constructor(o: { requireNotification?: boolean; limits?: Json; host?: string } = {}) {
    this.bg = createBreakGlass({
      audit: { append: (e) => { if (this.sinkDown) throw new Error("sink down"); this.events.push(structuredClone(e)); } },
      notify: (n) => { if (this.notifyDown) throw new Error("notice store unavailable"); this.notices.push(structuredClone(n)); },
      clock: () => this.t, idGen: () => `grant-${++this.n}`,
      ...(o.requireNotification !== undefined ? { requireNotification: o.requireNotification } : {}), ...(o.limits ? { limits: () => o.limits } : {}), ...(o.host ? { host: o.host } : {}),
    });
    this.steps.push(JSON.stringify({ op: "create", args: o }));
  }
  private step(op: string, args: Json): { ok?: Json; err?: Json } {
    this.events = []; this.notices = [];
    let out: { ok?: Json; err?: Json };
    try {
      const b = this.bg;
      const v = op === "request" ? b.request(args.holder, args.req) : op === "revoke" ? b.revoke(args.actor, args.grantId) : op === "sweep" ? b.sweep()
        : op === "active" ? b.active(args.holderUserId) : op === "authorize" ? b.authorize(args.principal, args.action, args.resource)
        : op === "sink" ? void (this.sinkDown = args.down) : op === "notify" ? void (this.notifyDown = args.down) : (() => { throw new Error(op); })();
      out = { ok: clone(v) };
    } catch (e) { if (!(e instanceof BreakGlassError)) throw e; out = { err: { code: e.code, message: e.message } }; }
    this.steps.push(JSON.stringify({ op, args: clone(args), at: this.t, out, ...(this.events.length ? { audit: clone(this.events) } : {}), ...(this.notices.length ? { notices: clone(this.notices) } : {}) }));
    return out;
  }
  ok(op: string, args: Json = {}): Json { const o = this.step(op, args); if (o.err) throw new Error(`${op} ${JSON.stringify(args)}: ${JSON.stringify(o.err)}`); return o.ok; }
  err(op: string, args: Json, code: string): void { const o = this.step(op, args); if (o.err?.code !== code) throw new Error(`${op} ${JSON.stringify(args)}: expected ${code}, got ${JSON.stringify(o)}`); }
}

function buildBreakGlass() {
  const owner = person("owner"), admin = person("admin"), member = person("member");
  const req = (targetUserId: Json, reason: Json = "investigating a reported leak", ttlMs?: Json) => ({ targetUserId, reason, ...(ttlMs !== undefined ? { ttlMs } : {}) });
  const read = (principal: Json, ownerUserId: string, action = "memory.user.read") => ({ principal, action, resource: { kind: "memory", scope: "user", ownerUserId } });
  const scenarios: Record<string, () => Glass> = {
    "request-validation"() {
      const g = new Glass();
      // The order of the refusals: target, kind, policy, self, reason, lifetime.
      g.err("request", { holder: { ...owner, kind: "agent" }, req: req("") }, "invalid-target");
      g.err("request", { holder: owner, req: req(7) }, "invalid-target");
      g.err("request", { holder: { ...owner, kind: "agent" }, req: req("u-owner", "") }, "not-permitted");
      g.err("request", { holder: member, req: req("u-member", "") }, "not-permitted");
      g.err("request", { holder: person("operator"), req: req("u-x") }, "not-permitted");
      g.err("request", { holder: person("viewer"), req: req("u-x") }, "not-permitted");
      g.err("request", { holder: { ...owner, tokenScopes: ["chat:read"] }, req: req("u-x") }, "not-permitted");
      g.err("request", { holder: owner, req: req("u-owner", "") }, "self-target");
      for (const reason of ["", "too short", "123456789", " 123456789 ", " 123456789 ", "\u00e4".repeat(9), "x".repeat(501), 7, null]) // nine `ä` are nine UTF-16 units (18 bytes)
        g.err("request", { holder: owner, req: req("u-x", reason) }, "reason-required");
      for (const ttlMs of [59_999, 60_000.5, 3_600_001, 0, -60_000, "60000"]) g.err("request", { holder: owner, req: req("u-x", "a reason that is long enough", ttlMs) }, "ttl-invalid");
      g.ok("request", { holder: owner, req: req("u-x", "  1234567890  ") }); // trimmed; default lifetime
      g.ok("request", { holder: admin, req: req("u-x", "x".repeat(500), 60_000) });
      g.ok("request", { holder: admin, req: req("u-y", "\u00e4".repeat(500), 60_000) }); // 500 units, 1000 bytes
      g.ok("request", { holder: { ...owner, tokenScopes: ["breakglass.request"] }, req: req("u-y", "😀".repeat(5), 3_600_000) }); // ten UTF-16 units
      g.ok("request", { holder: { userId: "u-owner", role: "owner" }, req: req("u-z") }); // a principal without a kind is accepted here
      g.ok("active", { holderUserId: "u-owner" }); g.ok("active", { holderUserId: "u-admin" }); g.ok("active", { holderUserId: "nobody" });
      return g;
    },
    "limits"() {
      const g = new Glass({ limits: { reasonMinChars: 3, reasonMaxChars: 5, maxWindowMinutes: 5 }, host: "core-host" });
      g.err("request", { holder: owner, req: req("u-x", "ab") }, "reason-required");
      g.err("request", { holder: owner, req: req("u-x", "abcdef") }, "reason-required");
      g.ok("request", { holder: owner, req: req("u-x", "abc") }); // default lifetime: the smaller of 15 minutes and the window
      g.err("request", { holder: owner, req: req("u-x", "abcde", 300_001) }, "ttl-invalid");
      g.ok("request", { holder: owner, req: req("u-x", "abcde", 300_000) });
      return g;
    },
    "use-expire-sweep"() {
      const g = new Glass();
      const grant = g.ok("request", { holder: owner, req: req("u-x", "a reason that is long enough", 60_000) });
      g.ok("authorize", read(owner, "u-x")); // used: audited
      g.ok("authorize", read({ ...owner, breakGlass: [{ id: "forged", holderUserId: "u-owner", targetUserId: "u-y", reason: "r", issuedAt: NOW, expiresAt: NOW + 1e9 }] }, "u-y")); // grants on the principal are ignored
      g.ok("authorize", read(owner, "u-y")); // no grant for this target
      g.ok("authorize", read(admin, "u-x")); // another holder
      g.ok("authorize", read(owner, "u-x", "memory.user.write")); // read only
      g.ok("authorize", read(owner, "u-owner")); // one's own cards need no grant
      g.ok("authorize", { principal: null, action: "memory.user.read", resource: { kind: "memory", scope: "user", ownerUserId: "u-x" } });
      g.ok("authorize", { principal: owner, action: "agent.list", resource: { kind: "system" } });
      g.ok("sink", { down: true });
      g.ok("authorize", read(owner, "u-x")); // a use that cannot be audited is denied
      g.ok("sink", { down: false });
      g.t = grant.expiresAt - 1;
      g.ok("authorize", read(owner, "u-x"));
      g.t = grant.expiresAt;
      g.ok("sink", { down: true });
      g.ok("sweep"); // the expiry cannot be audited: the grant is kept for the next sweep, and is unusable meanwhile
      g.ok("authorize", read(owner, "u-x"));
      g.ok("active", { holderUserId: "u-owner" });
      g.ok("sink", { down: false });
      g.ok("sweep");
      g.ok("sweep");
      g.ok("authorize", read(owner, "u-x"));
      // Two grants for one target: the use names one of them; both expire with one event each.
      g.ok("request", { holder: owner, req: req("u-x", "first of two grants", 60_000) });
      g.t += 1;
      g.ok("request", { holder: owner, req: req("u-x", "second of two grants", 120_000) });
      g.ok("authorize", read(owner, "u-x"));
      g.t += 60_000;
      g.ok("authorize", read(owner, "u-x"));
      g.t += 120_000;
      g.ok("active", { holderUserId: "u-owner" });
      return g;
    },
    "revoke"() {
      const g = new Glass();
      const a = g.ok("request", { holder: admin, req: req("u-x") });
      const b = g.ok("request", { holder: admin, req: req("u-y") });
      const c = g.ok("request", { holder: owner, req: req("u-y") });
      g.err("revoke", { actor: admin, grantId: "no-such-grant" }, "unknown-grant");
      g.err("revoke", { actor: { ...admin, kind: "agent" }, grantId: a.id }, "not-permitted");
      g.err("revoke", { actor: person("admin", { userId: "another-admin" }), grantId: a.id }, "not-permitted");
      g.err("revoke", { actor: member, grantId: a.id }, "not-permitted");
      g.err("revoke", { actor: admin, grantId: c.id }, "not-permitted"); // an Admin may not revoke an Owner's grant
      g.ok("sink", { down: true });
      g.err("revoke", { actor: admin, grantId: a.id }, "audit-failed"); // not revoked
      g.ok("sink", { down: false });
      g.ok("authorize", read(admin, "u-x"));
      g.ok("revoke", { actor: admin, grantId: a.id }); // the holder
      g.err("revoke", { actor: admin, grantId: a.id }, "unknown-grant");
      g.ok("authorize", read(admin, "u-x"));
      g.ok("revoke", { actor: owner, grantId: b.id }); // an Owner, not the holder
      g.ok("revoke", { actor: { userId: "u-owner", role: "owner" }, grantId: c.id }); // without a kind
      g.ok("active", { holderUserId: "u-admin" });
      return g;
    },
    "notice-fails"() {
      const g = new Glass();
      g.ok("notify", { down: true });
      g.ok("request", { holder: owner, req: req("u-x") }); // without requireNotification the grant stands, the failure is audited
      g.ok("active", { holderUserId: "u-owner" });
      g.ok("sink", { down: true });
      g.err("request", { holder: owner, req: req("u-y") }, "audit-failed"); // no audit line, no grant, no notice attempt
      g.ok("sink", { down: false });
      g.ok("active", { holderUserId: "u-owner" });
      return g;
    },
    "notice-required"() {
      const g = new Glass({ requireNotification: true });
      g.ok("request", { holder: owner, req: req("u-x") });
      g.ok("notify", { down: true });
      g.err("request", { holder: owner, req: req("u-y") }, "notification-failed"); // granted in the audit, then withdrawn
      g.ok("active", { holderUserId: "u-owner" });
      g.ok("authorize", read(owner, "u-y"));
      return g;
    },
  };
  return { scenarios: Object.entries(scenarios).map(([name, run]) => ({ name, steps: run().steps })) };
}

// ---- audit lines -------------------------------------------------------------------------------------------------------
function buildAudit(dir: string) {
  const events: AuditEvent[] = [
    { at: NOW, actor: { user: "u-owner", host: "host-1" }, action: "rbac.denied", target: "agent.delete", detail: { action: "admin.agent.delete", reason: "role-denied", role: "viewer" } },
    { at: NOW + 1, actor: { user: "anonymous", host: "local" }, action: "rbac.unauthenticated", target: "chat.list", detail: { action: "chat:read", reason: "no-principal" } },
    { at: 0, actor: { user: "", host: "" }, action: "", target: "", detail: {} },
    { at: NOW, actor: { user: "sys tem", host: "h\"q\\" }, action: "break-glass.granted", target: "u-é😀", detail: { grantId: "grant-1", reason: "line\nbreak\ttab \u0001 \u007f", issuedAt: NOW, expiresAt: NOW + 900_000, ttlMs: 900_000 } },
    { at: NOW, actor: { user: "u", host: "h" }, action: "x", target: "t", detail: { password: "hunter2", token: "abc", nested: { apiKey: "k", fine: "value", list: [{ secret: "s" }, 1, null, true] }, note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", n: 1.5, big: 1e21, neg: -0 } },
    // JavaScript lists integer-like keys first, in numeric order, whatever order they were written in.
    { at: NOW, actor: { user: "u", host: "h" }, action: "x", target: "t", detail: { z: 1, a: 2, "10": 3, "2": 4 }, more: "not written" } as Json,
  ];
  const lines = (name: string, write: (file: string, e: Json) => void, list: Json[]) => list.map((event, i) => {
    const file = path.join(dir, `${name}-${i}`, "logs", "audit.log");
    write(file, event);
    return { event: clone(event), keys: Object.keys(event.detail), line: readFileSync(file, "utf8") };
  });
  const identity: Json[] = [
    { action: "identity.link", target: "a".repeat(64), detail: { humanId: "b".repeat(64), channel: "telegram", proof: "owner_manual" }, actor: { user: "c".repeat(64), host: "d".repeat(64) } },
    { action: "identity.pair.claim", target: "t", detail: { channel: "telegram", result: "refused", reason: "wrong" } }, // no actor: the core itself
    { action: "x", target: "t", detail: { password: "hunter2", note: "fine" }, actor: { user: "u", host: "h" } },
  ];
  return {
    rbac: lines("rbac", (file, e) => createJsonlAuditSink(file).append(e), events),
    // Two events through one sink: the file is appended to, one line each.
    "rbac-two": (() => { const file = path.join(dir, "two", "audit.log"); const sink = createJsonlAuditSink(file); sink.append(events[0]!); sink.append(events[1]!); return readFileSync(file, "utf8"); })(),
    identity: lines("identity", (file, e) => createAuditWriter({ file, securePath: () => {}, clock: () => NOW + 7 })(e), identity),
  };
}

export async function buildRbacGuardVectors(): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(path.join(tmpdir(), "p1b-parity-rbac-guard-"));
  try { return { rules: buildRules(), guard: await buildGuard(), "break-glass": buildBreakGlass(), audit: buildAudit(dir) }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "rbac-guard", build: buildRbacGuardVectors });
}
