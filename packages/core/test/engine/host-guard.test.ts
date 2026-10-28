import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostMethods } from "../../src/engine/host-methods.ts";
import { bindEnginePrincipal, isEngineContext, verifyEngineDelegation } from "../../src/engine/engine-principal.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import type { CallContext } from "@plur1bus/module-api";
import { connect, coreAddress, createLogger, createRpcServer } from "@plur1bus/module-api";
import { buildCapabilities, RPC_VERSION } from "@plur1bus/rpc-schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

const context = (): CallContext => ({ requestId: "fixture", connectionId: "fixture", signal: new AbortController().signal });
const token = "e".repeat(64);

function fixture() {
  const audit = createMemoryAuditSink();
  const secrets = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit });
  let completions = 0, decisions = 0, workspaces = 0, events = 0, backlogReads = 0;
  const methods = createHostMethods({
    secrets,
    egress: { decide: async () => { decisions++; return { allowed: false, reason: "host-not-allowed", message: "fixture" }; } },
    complete: async params => { completions++; return { text: params.messages[0]?.content ?? "", usage: { inputTokens: 1, outputTokens: 1 } }; },
    host: {
      workspaceDir: async () => { workspaces++; return undefined; },
      events: { emit: () => { events++; } },
      capabilities: { journalBacklog: () => { backlogReads++; return { entries: 1, oldestAt: null }; } },
    },
  });
  return { audit, secrets, methods, counts: () => ({ completions, decisions, workspaces, events, backlogReads }) };
}

test("every host handler refuses an ordinary context before accessing a host service", async () => {
  const f = fixture();
  const params: Record<string, object> = {
    "host.secret.get": { name: "models/key" }, "host.llm.complete": { params: { messages: [{ role: "user", content: "fixture" }] } },
    "host.egress.decide": { scheme: "https", host: "example.com", port: 443 }, "host.workspaceDir": { agentId: "a" },
    "host.event": { name: "recall.completed", payload: {} }, "host.journalBacklog": {},
  };
  assert.deepEqual(Object.keys(f.methods).sort(), Object.keys(params).sort());
  for (const [name, handler] of Object.entries(f.methods)) {
    await assert.rejects(() => handler(params[name], context()), { error: "E_DENIED", reason: "engine-principal-required" }, name);
  }
  assert.deepEqual(f.counts(), { completions: 0, decisions: 0, workspaces: 0, events: 0, backlogReads: 0 });
  assert.deepEqual(f.audit.events, []);
});

test("engine delegation is exact, secret-independent and cannot be forged through context properties", () => {
  const ctx = context();
  assert.equal(isEngineContext({ ...ctx, kind: "engine" } as CallContext), false);
  for (const input of [undefined, { clientId: "plur1bus-engine", token: "x".repeat(64) }, { clientId: "harness-api", token }, { clientId: "plur1bus-engine", token, principal: "engine" }]) {
    assert.throws(() => verifyEngineDelegation(input, token), { error: "E_UNAUTHORIZED", reason: "engine-delegation" });
  }
  assert.throws(() => verifyEngineDelegation({ clientId: "plur1bus-engine", token }, undefined), { error: "E_UNAUTHORIZED" });
  verifyEngineDelegation({ clientId: "plur1bus-engine", token }, token);
  bindEnginePrincipal(ctx);
  assert.equal(isEngineContext(ctx), true);
  assert.equal(isEngineContext({ ...ctx }), false);
});

test("engine host secret reads use durable audited leases, revoke them and register values for redaction", async () => {
  const f = fixture(), ctx = context(); bindEnginePrincipal(ctx);
  const secret = "fixture-private-value-that-must-never-be-logged";
  await f.secrets.set({ kind: "owner" }, "models/key", secret);
  assert.deepEqual(await f.methods["host.secret.get"]!({ name: "models/key" }, ctx), { value: secret });
  assert.equal(f.secrets.activeLeases({ kind: "core" }).length, 0);
  assert.ok(f.audit.events.some(event => event.action === "secret.lease"));
  assert.equal(JSON.stringify(f.audit.events).includes(secret), false);
  assert.equal(f.secrets.redaction.mask(`provider returned ${secret}`), "provider returned [redacted]");
});

test("engine host handlers preserve completion cancellation and host results", async () => {
  const f = fixture(), ctx = context(); bindEnginePrincipal(ctx);
  assert.deepEqual(await f.methods["host.llm.complete"]!({ params: { messages: [{ role: "user", content: "fixture" }] } }, ctx), { text: "fixture", usage: { inputTokens: 1, outputTokens: 1 } });
  assert.deepEqual(await f.methods["host.workspaceDir"]!({ agentId: "a" }, ctx), { path: null });
  assert.deepEqual(await f.methods["host.journalBacklog"]!({}, ctx), { entries: 1, oldestAt: null });
  assert.deepEqual(await f.methods["host.event"]!({ name: "recall.completed", payload: {} }, ctx), {});
  assert.deepEqual(await f.methods["host.egress.decide"]!({ scheme: "https", host: "example.com", port: 443 }, ctx), { allowed: false, reason: "host-not-allowed", message: "fixture" });
  assert.deepEqual(f.counts(), { completions: 1, decisions: 1, workspaces: 1, events: 1, backlogReads: 1 });
});

async function rpcFixture(t: { after(fn: () => unknown): void }) {
  const f = fixture(), home = tempDir("p1b-engine-host-"), address = coreAddress(home), file = join(home, "core.log");
  const logger = createLogger({ file, level: "debug", role: "core" });
  let currentEngineToken: string | undefined = token;
  const server = createRpcServer({ address, token: "c".repeat(64), logger,
    engineToken: () => currentEngineToken,
    hello: () => ({ contract: "1.17.0", rpc: RPC_VERSION, instanceId: "fixture", pid: process.pid, capabilities: buildCapabilities([]) }),
    methods: { ...f.methods, "core.shutdown": async () => ({ accepted: true }) },
  });
  await server.listen();
  t.after(async () => { await server.close(); logger.close(); });
  const ordinary = await connect({ address, token: "c".repeat(64), expectedServerPid: process.pid });
  t.after(() => ordinary.close());
  return { ...f, server, ordinary, file, logger, address, rotate: (next: string | undefined) => { currentEngineToken = next; } };
}

test("an authenticated ordinary client invoking every host method by name gets E_DENIED, despite hidden capabilities", async t => {
  const f = await rpcFixture(t);
  assert.ok(!Object.keys(f.ordinary.hello.capabilities!.methods).some(name => name.startsWith("host.")));
  const params: Record<string, object> = {
    "host.secret.get": { name: "models/key" }, "host.llm.complete": { params: { messages: [{ role: "user", content: "fixture" }] } },
    "host.egress.decide": { scheme: "https", host: "example.com", port: 443 }, "host.workspaceDir": { agentId: "a" },
    "host.event": { name: "recall.completed", payload: {} }, "host.journalBacklog": {},
  };
  for (const [method, p] of Object.entries(params))
    await assert.rejects(() => f.ordinary.call(method, p), { error: "E_DENIED", reason: "engine-principal-required" }, method);
  assert.deepEqual(f.counts(), { completions: 0, decisions: 0, workspaces: 0, events: 0, backlogReads: 0 });
  assert.deepEqual(f.audit.events, []);
});

test("engine credential authenticates independently, accesses audited host services and receives egress.changed", async t => {
  const f = await rpcFixture(t);
  const secret = "engine-provider-value-never-recorded-in-rpc-logs";
  await f.secrets.set({ kind: "owner" }, "models/key", secret);
  const engine = await connect({ address: f.address, token, expectedServerPid: process.pid, engine: { clientId: "plur1bus-engine", token } });
  t.after(() => engine.close());
  assert.ok(engine.hello.capabilities!.methods["host.secret.get"]);
  assert.deepEqual(await engine.call("host.secret.get", { name: "models/key" }), { value: secret });
  assert.deepEqual(await engine.call("host.llm.complete", { params: { messages: [{ role: "user", content: "fixture" }] } }), { text: "fixture", usage: { inputTokens: 1, outputTokens: 1 } });
  await assert.rejects(() => engine.call("core.shutdown"), { error: "E_DENIED", reason: "engine-method" });
  await assert.rejects(() => engine.call("events.subscribe"), { error: "E_DENIED", reason: "engine-method" });
  await engine.call("events.subscribe", { names: ["egress.changed"] });
  const noticed = new Promise<void>(resolve => engine.onNotification(method => { if (method === "egress.changed") resolve(); }));
  f.server.notify("egress.changed", {});
  await noticed;
  assert.equal(f.secrets.activeLeases({ kind: "core" }).length, 0);
  f.logger.close();
  assert.equal(readFileSync(f.file, "utf8").includes(secret), false);
});

test("wrong or missing engine credentials fail closed, rotation is applied and an ordinary connection cannot change identity", async t => {
  const f = await rpcFixture(t);
  await assert.rejects(() => connect({ address: f.address, token: "x".repeat(64), expectedServerPid: process.pid,
    engine: { clientId: "plur1bus-engine", token: "x".repeat(64) } }), { error: "E_INVALID_PARAMS" });
  for (const credential of ["d".repeat(64), "c".repeat(64)]) {
    await assert.rejects(() => connect({ address: f.address, token: credential, expectedServerPid: process.pid,
      engine: { clientId: "plur1bus-engine", token: credential } }), { error: "E_UNAUTHORIZED", reason: "engine-delegation" });
  }
  await assert.rejects(() => f.ordinary.call("core.auth", { token, engine: { clientId: "plur1bus-engine", token } }), { error: "E_DENIED", reason: "engine-identity-change" });
  f.rotate(undefined);
  await assert.rejects(() => connect({ address: f.address, token, expectedServerPid: process.pid,
    engine: { clientId: "plur1bus-engine", token } }), { error: "E_UNAUTHORIZED", reason: "engine-delegation" });
});
