// Step 6 (core link) of the server hardening sweep: the API with an unreachable, hung, slow or malformed core.
// Already pinned elsewhere (not repeated): lazy connect, one shared connection, a fresh token per connection, reconnect
// after a drop, a failed connect failing only its call (core-link.test.ts, api-core-link.coverage.test.ts), the 503/502
// status mapping of core errors (errors-headers.test.ts), a core error's text never being forwarded (redteam.test.ts F2).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ConnectOptions, CoreClient } from "@plur1bus/module-api";
import { createCoreLink } from "../src/core-link.ts";
import { buildOpenApi } from "../src/openapi.ts";
import { ROUTES } from "../src/routes.ts";
import { validate, type Doc } from "./openapi-validate.ts";
import { login, raw, start, type FakeCore } from "./helpers.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const doc = buildOpenApi() as unknown as Doc & { paths: Record<string, Record<string, any>> };
const wide = { auth: { capacity: 100_000, refillPerSec: 10_000 }, read: { capacity: 100_000, refillPerSec: 10_000 }, write: { capacity: 100_000, refillPerSec: 10_000 }, totp: { capacity: 100_000, refillPerSec: 10_000 }, stream: { capacity: 100_000, refillPerSec: 10_000 } };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const asCore = (link: ReturnType<typeof createCoreLink>) => link as unknown as FakeCore;

function client(call: (m: string) => Promise<unknown>): CoreClient & { closed: number } {
  const c = { closed: 0, hello: { rpc: "1", instanceId: "c", pid: 1 }, call: call as CoreClient["call"], onNotification: () => () => {}, onClose: () => () => {}, close: async () => { c.closed++; }, supports: () => true };
  return c as CoreClient & { closed: number };
}
const STATUS = { rpc: "1.5.0", contract: "7.18.4", uptimeMs: 1234, engine: { ready: true, degraded: null } };
const AGENT = { agentId: "main", open: true, activity: { state: "idle", since: 1 } };

// ---- an unreachable or hung core -----------------------------------------------------------------------------------

test("an unreachable core is a 503 with the documented bodies, quickly, and neither the socket path nor the system error text reaches the client or the log", async () => {
  const link = createCoreLink("/Users/redact-probe-alpha/home", { connect: async () => { throw Object.assign(new Error("connect ECONNREFUSED /Users/redact-probe-alpha/home/run/core.sock"), { code: "ECONNREFUSED" }); }, readToken: () => "t", readPid: () => undefined });
  const h = await start({ rateClasses: wide, core: asCore(link) });
  try {
    const { cookie } = await login(h); const t0 = Date.now();
    const health = await raw(h, { path: "/api/v1/health", headers: { cookie } });
    assert.equal(health.status, 503); assert.deepEqual(health.json, { schema: "health/1", status: "down", api: { version: "1.0.0" }, core: { reachable: false } });
    const agents = await raw(h, { path: "/api/v1/agents", headers: { cookie } });
    assert.equal(agents.status, 503); assert.deepEqual(agents.json, { schema: "error/1", error: "E_CORE_UNAVAILABLE", message: "the core is not reachable", reason: "core-unreachable" });
    assert.ok(Date.now() - t0 < 1500, "a refused connection answers at once; nothing waits for a retry");
    for (const text of [health.text, agents.text, h.logs.join("\n")]) { assert.ok(!/ECONNREFUSED|redact-probe-alpha|core\.sock/.test(text), "a system detail leaked"); }
  } finally { await h.close(); await link.close(); }
});

test("a core that accepts the connection and never answers ends every request in its own time (503 for health, 504 for the rest), the API keeps serving, and the link recovers when the core does", async () => {
  let release: (() => void) | undefined; let connects = 0;
  const gate = new Promise<void>((r) => { release = r; });
  const link = createCoreLink("/h", { connect: async () => { connects++; await gate; return client(async (m) => (m === "core.status" ? STATUS : { agents: [AGENT] })); }, readToken: () => "t", readPid: () => undefined });
  const h = await start({ rateClasses: wide, core: asCore(link), limits: { healthTimeoutMs: 150, handlerTimeoutMs: 400 } });
  try {
    const { cookie } = await login(h); const t0 = Date.now();
    const [health, agents, who] = await Promise.all([raw(h, { path: "/api/v1/health", headers: { cookie } }), raw(h, { path: "/api/v1/agents", headers: { cookie } }), raw(h, { path: "/api/v1/whoami", headers: { cookie } })]);
    assert.equal(health.status, 503); assert.equal(health.json.status, "down"); assert.equal(agents.status, 504); assert.equal(agents.json.reason, "handler-timeout"); assert.equal(who.status, 200, "routes that need no core are unaffected");
    assert.ok(Date.now() - t0 < 2000, `the slowest answer took ${Date.now() - t0} ms`);
    assert.equal(connects, 1, "requests that arrived while one attempt was in flight shared it");
    release!(); await delay(20);
    assert.equal((await raw(h, { path: "/api/v1/agents", headers: { cookie } })).status, 200, "once the core answers, the next request works");
    assert.equal(connects, 1);
  } finally { release?.(); await h.close(); await link.close(); }
});

test("there is no retry loop in the background: every failed call is one connection attempt, 30 concurrent calls share one, and nothing reconnects by itself", async () => {
  let attempts = 0; let open = false;
  const link = createCoreLink("/h", { connect: async () => { attempts++; await delay(30); if (!open) throw new Error("ECONNREFUSED"); return client(async () => ({ ok: true })); }, readToken: () => "t", readPid: () => undefined });
  const burst = await Promise.allSettled(Array.from({ length: 30 }, () => link.call("x")));
  assert.equal(burst.every((r) => r.status === "rejected"), true); assert.equal(attempts, 1, "one attempt for the whole burst");
  await delay(150); assert.equal(attempts, 1, "no background retry");
  for (let i = 0; i < 4; i++) await assert.rejects(link.call("x"), /ECONNREFUSED/);
  assert.equal(attempts, 5, "each later failed call is exactly one more attempt: no backoff state, no hidden retries, bounded by the request rate limits");
  open = true; assert.deepEqual(await link.call("x"), { ok: true }); await link.close();
});

test("closing the link while a connection is being made does not leave that connection open", async () => {
  let resolveConnect: ((c: CoreClient) => void) | undefined; const late = client(async () => ({}));
  const link = createCoreLink("/h", { connect: (_o: ConnectOptions) => new Promise<CoreClient>((r) => { resolveConnect = r; }), readToken: () => "t", readPid: () => undefined });
  const inFlight = link.call("x").catch((e) => e as Error);
  await delay(10); await link.close(); resolveConnect!(late);
  const outcome = await inFlight; assert.ok(outcome instanceof Error, "the call that raced the close fails");
  await delay(10); assert.equal(late.closed, 1, "the connection that finished after the close was closed, not kept");
  await assert.rejects(link.call("y"), /closed/);
});

// ---- what the core says is checked before it goes on ---------------------------------------------------------------

test("health: a core.status of the wrong shape or types is never forwarded; it is the same 503 down as an unreachable core", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h); const bad: unknown[] = [null, "ok", 5, [], {}, { ...STATUS, engine: undefined }, { ...STATUS, engine: null }, { ...STATUS, engine: { ready: "yes", degraded: null } }, { ...STATUS, rpc: { nested: "x".repeat(10_000) } },
      { ...STATUS, rpc: 5 }, { ...STATUS, contract: ["a"] }, { ...STATUS, uptimeMs: "soon" }, { ...STATUS, uptimeMs: -1 }, { ...STATUS, uptimeMs: 1.5 }, { ...STATUS, rpc: "x".repeat(10_000) }, { ...STATUS, uptimeMs: 10 ** 30 }];
    const leaked: string[] = [];
    for (const [i, s] of bad.entries()) {
      h.core.impl = async () => s; const r = await raw(h, { path: "/api/v1/health", headers: { cookie } });
      if (r.status !== 503 || r.json?.status !== "down" || r.text.includes("xxxx")) leaked.push(`case ${i} ${JSON.stringify(s)?.slice(0, 60)} → ${r.status} ${r.text.slice(0, 80)}`);
    }
    assert.deepEqual(leaked, [], leaked.join("\n"));
    h.core.impl = async () => STATUS; assert.equal((await raw(h, { path: "/api/v1/health", headers: { cookie } })).status, 200);
    h.core.impl = async () => ({ ...STATUS, extra: { not: "forwarded" }, engine: { ready: false, degraded: { reason: "x" }, other: 1 } });
    const ok = await raw(h, { path: "/api/v1/health", headers: { cookie } }); assert.equal(ok.json.status, "degraded"); assert.ok(!ok.text.includes("forwarded") && !ok.text.includes("other"), "only the documented fields are copied");
  } finally { await h.close(); }
});

test("agents.list: a core result that is not a list of agents with ids is refused or reduced, the schema id cannot be overridden by the core, and the caller's rights still filter", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h); const get = () => raw(h, { path: "/api/v1/agents", headers: { cookie } });
    for (const garbage of [null, "text", 5, [], [AGENT]]) { h.core.impl = async () => garbage; const r = await get(); assert.equal(r.status, 502, JSON.stringify(garbage)); assert.equal(r.json.reason, "core-error"); assert.equal(r.json.error, "E_CORE_UNAVAILABLE"); }
    h.core.impl = async () => ({ schema: "evil/9", agents: [AGENT, { nope: 1 }, "str", null, 7, { agentId: "" }, { agentId: 5 }, { agentId: { x: 1 } }, [AGENT]] });
    const r = await get(); assert.equal(r.status, 200); assert.equal(r.json.schema, "agents.list/1", "the API's schema id, not the core's");
    assert.deepEqual(r.json.agents, [AGENT], "only entries with a string agent id survive");
    h.core.impl = async () => ({ agents: "not a list" }); assert.deepEqual((await get()).json.agents, []);
  } finally { await h.close(); }
});

test("agents.list answers a real core's optional fields (lifecycle, activity.job, phase) and the document accepts them", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const { cookie } = await login(h);
    const full = { agentId: "dreamer", open: false, activity: { state: "dreaming", since: 7, phase: "rem", job: "dream.rem" }, lifecycle: { paused: false, archived: true, deleted: false } };
    h.core.impl = async () => ({ agents: [full, AGENT] });
    const r = await raw(h, { path: "/api/v1/agents", headers: { cookie } }); assert.equal(r.status, 200); assert.deepEqual(r.json.agents[0], full, "passed through untouched");
    const schema = doc.paths["/api/v1/agents"]!.get.responses["200"].content["application/json"].schema;
    assert.deepEqual(validate(schema, r.json, doc), [], "the OpenAPI response schema must accept what the core really sends");
  } finally { await h.close(); }
});

test("the OpenAPI schemas of agents.list cover every property the core's RPC schema allows (so a newer field cannot make a real answer invalid)", () => {
  const rpc = JSON.parse(readFileSync(path.join(repo, "packages/rpc-schema/schema/rpc.schema.json"), "utf8"));
  const coreItem = rpc.$defs.methods["agent.list"].result.properties.agents.items; const coreActivity = rpc.$defs.Activity;
  const apiSchema = ROUTES.find((r) => r.id === "agents.list")!.success.schema as any; const apiItem = apiSchema.properties.agents.items;
  const resolve = (s: any) => (s.$ref ? (doc.components.schemas as any)[String(s.$ref).replace("#/components/schemas/", "")] : s);
  const missing = Object.keys(coreItem.properties).filter((k) => !(k in apiItem.properties)).map((k) => `agent item: ${k}`);
  const apiActivity = resolve(apiItem.properties.activity); missing.push(...Object.keys(coreActivity.properties).filter((k) => !(k in apiActivity.properties)).map((k) => `activity: ${k}`));
  assert.deepEqual(missing, [], `the document's closed schemas lack: ${missing.join(", ")}`);
});
