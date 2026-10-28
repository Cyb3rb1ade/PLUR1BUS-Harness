import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { validateParams } from "@plur1bus/rpc-schema";
import { mapMemoryOpError } from "../../src/memory-ops.ts";
import { EngineClient } from "../../src/engine/client.ts";

const identity = { fingerprintId: "fp", provider: "local", model: "fixture", dimensions: 3 };
const models: E.ModelsStatus = {
  embedder: { state: "ready", warming: false, checkedAt: 1, identity },
  reranker: { state: "disabled", warming: false, checkedAt: null, provider: null },
};
const status: E.EngineStatus = {
  ready: true, degraded: null, agents: 1, contract: "1.17.0", storeSchema: { current: "1", expected: "1" },
  jobs: { ledger: "ok", agents: [] }, models, journal: null,
  sharedMemory: { supported: false, mode: "unavailable", reason: "platform" },
};
const principal: E.Principal = { trust: "proved", agentId: "a", channel: "cli", accountId: "local", workspace: "workspace-dir:v1:/workspace", chat: { id: "test", kind: "direct" } };
const agent: E.AgentContext = { origin: "user", background: false };
const signal = new AbortController().signal;
const query: E.RecallQuery = { query: "hello", principal, agent, signal };
const recall = { blocks: [], capChars: 10, degraded: null, timing: { phases: null, totalMs: 1 }, deferrals: [] };

async function fixture(o: { memoryLink?: boolean; onEvent?: (name: E.EngineEventName, payload: unknown) => void; contract?: string; stall?: readonly string[]; respond?: (method: string, params: Record<string, unknown>, socket: Socket) => unknown } = {}) {
  const home = await mkdtemp(join(tmpdir(), "engine-client-"));
  await mkdir(join(home, "run"), { mode: 0o700 });
  const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-engine-test-${randomUUID()}` : join(home, "run", "engine.sock");
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffered = "";
    socket.on("data", bytes => {
      buffered += bytes.toString();
      for (;;) {
        const end = buffered.indexOf("\n"); if (end < 0) break;
        const request = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
        calls.push({ method: request.method, params: request.params });
        const checked = validateParams(request.method, request.params);
        if (!checked.ok) {
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: checked.errors.join("; "), data: { error: "E_INVALID_PARAMS" } } }) + "\n");
          continue;
        }
        let result: unknown;
        if (request.method === "engine.auth") result = { contract: o.contract ?? "1.17.0", rpc: "1.7.0", instanceId: "instance", pid: process.pid, capabilities: { methods: { "engine.memory.link": { stability: "experimental", since: "1.7.0" } }, notifications: {}, extensionPoints: {}, features: [] }, ...(o.memoryLink === undefined ? {} : { engineCapabilities: { memoryLink: o.memoryLink } }) };
        else if (request.method === "engine.status") result = status;
        else if (request.method === "engine.jobs.list") result = [{ name: "afterthought" }];
        else if (request.method === "engine.embedding.identities") result = [identity];
        else if (request.method === "engine.models.status" || request.method === "engine.models.warm") result = models;
        else if (request.method === "engine.systemSupplement") result = ["fixture supplement"];
        else if (request.method === "engine.recall") result = recall;
        else if (request.method === "engine.embedding.embed") result = [[1, 0, 0]];
        else if (request.method === "engine.capture") result = { id: "remote-capture", acceptedAt: 42 };
        else result = {};
        const custom = o.respond?.(request.method, request.params, socket);
        if (custom !== undefined) result = custom;
        if (o.stall?.includes(request.method)) continue;
        const error = (result as { $error?: unknown })?.$error;
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  await writeFile(join(home, "run", "engine.token"), "a".repeat(64), { mode: 0o600 });
  await writeFile(join(home, "run", "engine.pid"), `${process.pid} instance\n`, { mode: 0o600 });
  const client = new EngineClient({ home, address, callTimeoutMs: 1000, ...(o.onEvent ? { onEvent: o.onEvent } : {}) });
  return { home, calls, client, async close() { await client.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); } };
}

test("EngineClient implements the Phase 1 Engine members the Core calls over engine RPC", async () => {
  const f = await fixture();
  try {
    const store = await f.client.open("a");
    assert.equal(store.agentId, "a");
    assert.equal(f.client.contract, "1.17.0");
    assert.deepEqual(f.calls.find(call => call.method === "engine.auth")?.params, { token: "a".repeat(64), clientId: "harness-core" });
    assert.deepEqual(await f.client.status(), status);
    assert.deepEqual(f.client.models.status(), models);
    assert.deepEqual(f.client.jobs.list(), [{ name: "afterthought" }]);
    assert.deepEqual(f.client.embedding.identities(), [identity]);
    assert.deepEqual(f.client.embedding.local, {});
    assert.deepEqual(await f.client.recall({ principal, agent, query: "hello", signal } as unknown as E.RecallQuery), recall);
    const operations: [string, () => unknown][] = [
      ["engine.memory.stats", () => f.client.memory.stats(["id"], principal, agent)],
      ["engine.memory.promote", () => f.client.memory.promote({ ids: ["id"] }, principal, agent)],
      ["engine.memory.curation.list", () => f.client.memory.curation.list({}, principal, agent)],
      ["engine.memory.curation.resolve", () => f.client.memory.curation.resolve("id", "keep", principal, agent)],
      ["engine.memory.import", () => f.client.memory.import({ agentId: "a", principal, cards: [], signal }, principal, agent)],
      ["engine.jobs.run", () => f.client.jobs.run("afterthought", "a", { signal, trigger: "harness" })],
      ["engine.memory.list", () => f.client.memory.list({ topic: "hello" }, principal, agent)],
      ["engine.jobs.history", () => f.client.jobs.history("a", { limit: 1 })],
      ["engine.embedding.serve", () => f.client.embedding.serve(null)],
      ["engine.checkpoint", () => f.client.checkpoint("a", "manual")],
      ["engine.admin.reembedding.plan", () => f.client.admin.reembedding.plan()],
      ["engine.admin.reembedding.apply", () => f.client.admin.reembedding.apply()],
      ["engine.admin.reembedding.resume", () => f.client.admin.reembedding.resume()],
      ["engine.admin.reembedding.status", () => f.client.admin.reembedding.status()],
      ["engine.admin.reembedding.validate", () => f.client.admin.reembedding.validate()],
      ["engine.stores.adopt", () => f.client.stores.adopt({ path: "/tmp/store", expectedIdentity: identity })],
      ["engine.memory.unimport", () => f.client.memory.unimport({ agentId: "a", importRunId: "run", signal }, principal, agent)],
      ["engine.memory.unbind", () => f.client.memory.unbind({ rebindId: "r", signal }, principal, agent)],
      ["engine.memory.show", () => f.client.memory.show("id", principal, agent)],
      ["engine.memory.rebind", () => f.client.memory.rebind({ agentId: "a", fromIdentity: { channel: "cli", identityKey: "u" }, toUser: "u", signal }, principal, agent)],
      ["engine.memory.link", () => f.client.memory.link("id", { sourceRef: "fixture", provenance: "imported" }, principal, agent)],
      ["engine.embedding.probe", () => f.client.embedding.probe({ signal, refresh: true })],
      ["engine.admin.obsidian.detect", () => f.client.admin.obsidian.detect(principal, agent)],
      ["engine.admin.migrate", () => f.client.admin.migrate("1", "2")],
    ];
    for (const [method, call] of operations) { await call(); assert.ok(f.calls.some(c => c.method === method), method); }
    assert.deepEqual(await f.client.embedding.embed(["x"], { kind: "query", identity, signal }), [new Float32Array([1, 0, 0])]);
    assert.ok(f.calls.every(call => !JSON.stringify(call.params).includes('"signal"')));
    f.client.channels.register("fixture"); assert.equal(f.client.channels.has("fixture"), true);
    await store.close();
    assert.ok(f.calls.some(c => c.method === "engine.agent.close"));
  } finally { await f.close(); }
});

test("a missing engine stays lazy, lets open finish, and recall reports engine-unavailable", async () => {
  const home = await mkdtemp(join(tmpdir(), "engine-absent-"));
  const client = new EngineClient({ home, connectTimeoutMs: 20 });
  try {
    assert.equal((await client.open("a")).agentId, "a");
    assert.deepEqual((await client.status()).degraded, { reason: "engine-unavailable", capability: "engine" });
    await assert.rejects(client.recall({} as E.RecallQuery), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { error?: string }).error, "E_NOT_AVAILABLE");
      assert.equal((error as { reason?: string }).reason, "engine-unavailable");
      assert.doesNotMatch(error.message, /ENOENT|ECONNREFUSED|socket/i);
      return true;
    });
  } finally { await client.close(); await rm(home, { recursive: true, force: true }); }
});

test("the handshake rejects an incompatible engine contract", async () => {
  const f = await fixture({ contract: "2.0.0" });
  try { await assert.rejects(f.client.status(), (error: unknown) => (error as { error?: string }).error === "E_RPC_VERSION"); }
  finally { await f.close(); }
});

test("capture returns immediately and done resolves from engine.capture.done, including a notification racing acceptance", async () => {
  const result = { stored: 1, skipped: 0 };
  const f = await fixture({ respond(method, _params, socket) {
    if (method === "engine.capture") socket.write(JSON.stringify({ jsonrpc: "2.0", method: "engine.capture.done", params: { id: "remote-capture", result } }) + "\n");
    return undefined;
  } });
  try {
    const handle = f.client.capture({ agentId: "a", principal, agent, messages: [], incognito: false, signal });
    assert.equal(typeof handle.id, "string"); assert.equal(typeof handle.acceptedAt, "number");
    assert.deepEqual(await handle.done, result);
    assert.ok(f.calls.some(c => c.method === "engine.capture"));
  } finally { await f.close(); }
});

test("capture abort after dispatch sends the remote id and close rejects unfinished captures", async () => {
  const f = await fixture();
  try {
    const handle = f.client.capture({ agentId: "a", principal, agent, messages: [], incognito: false, signal });
    const done = assert.rejects(handle.done, (error: unknown) => (error as { error?: string }).error === "E_NOT_AVAILABLE");
    for (let i = 0; i < 50 && !f.calls.some(c => c.method === "engine.capture"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(f.calls.some(c => c.method === "engine.capture"));
    handle.abort("caller stopped");
    for (let i = 0; i < 50 && !f.calls.some(c => c.method === "engine.capture.abort"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(f.calls.find(c => c.method === "engine.capture.abort")?.params, { id: "remote-capture", reason: "caller stopped" });
    await f.client.close(); await done;
    assert.equal(f.calls.some(c => c.method === "engine.shutdown"), false);
  } finally { await f.close(); }
});


test("the client retries after a missing delegation token becomes available", async () => {
  const f = await fixture();
  const tokenPath = join(f.home, "run", "engine.token");
  try {
    await rm(tokenPath);
    await assert.rejects(f.client.recall(query));
    await writeFile(tokenPath, "a".repeat(64), { mode: 0o600 });
    assert.deepEqual(await f.client.recall(query), recall);
  } finally { await f.close(); }
});


test("recall observes the Core abort signal before its RPC timeout", async () => {
  const f = await fixture({ stall: ["engine.recall"] });
  try {
    const abort = new AbortController();
    const result = f.client.recall({ ...query, signal: abort.signal, budget: { capChars: 40 } });
    setTimeout(() => abort.abort(), 20);
    assert.deepEqual((await result).degraded, { reason: "aborted", capability: "recall" });
    const already = new AbortController(); already.abort();
    const before = f.calls.length;
    assert.equal((await f.client.recall({ ...query, signal: already.signal })).degraded?.reason, "aborted");
    assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

test("memory RPC failures preserve MemoryOpError codes for the Core mapper", async () => {
  const f = await fixture({ respond(method) {
    if (method === "engine.memory.show") return { $error: { code: -32000, message: "card not found", data: { error: "E_NOT_FOUND", reason: "not-found" } } };
    return undefined;
  } });
  try {
    await assert.rejects(f.client.memory.show("missing", principal, agent), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.name, "MemoryOpError");
      assert.equal((error as { code?: string }).code, "not-found"); return true;
    });
  } finally { await f.close(); }
});


test("the reembedding adapter preserves the real Core port arguments beyond the narrow legacy declarations", async () => {
  const f = await fixture();
  try {
    const admin = f.client.admin.reembedding as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const request = { id: "migration", target: { fingerprint: { provider: "local-transformers", model: "fixture", revision: "main", dimensions: 3, normalize: true } } };
    await admin.plan!(request); await admin.apply!({ id: "migration", token: "confirmation" });
    await admin.resume!({ id: "migration", token: "confirmation" }); await admin.validate!({ id: "migration" }); await admin.status!("migration");
    assert.deepEqual(f.calls.find(call => call.method === "engine.admin.reembedding.plan")?.params, { request });
    for (const method of ["apply", "resume"]) assert.deepEqual(f.calls.find(call => call.method === `engine.admin.reembedding.${method}`)?.params, { request: { id: "migration", token: "confirmation" } });
    assert.deepEqual(f.calls.find(call => call.method === "engine.admin.reembedding.validate")?.params, { request: { id: "migration" } });
    assert.deepEqual(f.calls.find(call => call.method === "engine.admin.reembedding.status")?.params, { id: "migration" });
  } finally { await f.close(); }
});

test("a lost engine connection reports engine-unavailable and the next recall reconnects", async () => {
  let disconnect = true;
  const f = await fixture({ respond(method, _params, socket) {
    if (method === "engine.recall" && disconnect) { disconnect = false; socket.destroy(); }
    return undefined;
  } });
  try {
    await assert.rejects(f.client.recall(query), (error: unknown) => error instanceof Error && (error as { error?: string }).error === "E_NOT_AVAILABLE" && (error as { reason?: string }).reason === "engine-unavailable");
    assert.deepEqual(await f.client.recall(query), recall);
    assert.equal(f.calls.filter(call => call.method === "engine.auth").length, 2);
  } finally { await f.close(); }
});

test("engine.event reaches registered listeners and dispose removes the listener", async () => {
  const payloads: unknown[] = [];
  const forwarded: unknown[] = [];
  const f = await fixture({ onEvent(name, payload) { forwarded.push({ name, payload }); throw new Error("observer failed"); }, respond(method, _params, socket) {
    if (method === "engine.recall") socket.write(JSON.stringify({ jsonrpc: "2.0", method: "engine.event", params: { name: "recall.completed", payload: { fixture: true } } }) + "\n");
    return undefined;
  } });
  try {
    const listener = f.client.events.on("recall.completed", payload => payloads.push(payload));
    await f.client.recall(query);
    assert.deepEqual(payloads, [{ fixture: true }]);
    assert.deepEqual(forwarded, [{ name: "recall.completed", payload: { fixture: true } }]);
    listener.dispose(); await f.client.recall(query);
    assert.equal(payloads.length, 1);
  } finally { await f.close(); }
});

test("disposing the active embedding server releases the remote resource", async () => {
  const address: E.IpcAddress = { kind: "unix-socket", address: "/tmp/fixture-embedding.sock" };
  const f = await fixture({ respond(method, params) {
    if (method === "engine.embedding.serve") return params.address === null
      ? { address: null, tokenPath: null, identity: null }
      : { address: params.address, tokenPath: "/tmp/fixture-embedding.token", identity: { model: "fixture", dimensions: 3, fingerprintId: "fp" } };
    return undefined;
  } });
  try {
    const served = await f.client.embedding.serve(address);
    assert.equal(await f.client.embedding.serve(address), served);
    served.dispose();
    await f.client.status();
    assert.deepEqual(f.calls.filter(call => call.method === "engine.embedding.serve").at(-1)?.params, { address: null });
  } finally { await f.close(); }
});


test("an explicit engine memoryLink capability overrides method availability", async () => {
  const f = await fixture({ memoryLink: false });
  try { await f.client.status(); assert.equal(f.client.capabilities.memoryLink, false); }
  finally { await f.close(); }
});

test("a pre-aborted capture never sends a remote capture request", async () => {
  const f = await fixture({ respond(method, _params, socket) {
    if (method === "engine.capture") socket.write(JSON.stringify({ jsonrpc: "2.0", method: "engine.capture.done", params: { id: "remote-capture", result: { stored: 1, skipped: 0 } } }) + "\n");
    return undefined;
  } });
  try {
    const cancelled = new AbortController(); cancelled.abort();
    const handle = f.client.capture({ agentId: "a", principal, agent, messages: [], incognito: false, signal: cancelled.signal });
    assert.deepEqual(await handle.done, { stored: 0, skipped: 1, reason: "aborted" });
    await f.client.status();
    assert.equal(f.calls.some(call => call.method === "engine.capture"), false);
  } finally { await f.close(); }
});

test("close cancels a stalled bootstrap within its requested budget", async () => {
  const f = await fixture({ stall: ["engine.status"] });
  try {
    const pending = f.client.status();
    for (let i = 0; i < 100 && !f.calls.some(call => call.method === "engine.status"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(f.calls.some(call => call.method === "engine.status"));
    const started = performance.now();
    await f.client.close({ budgetMs: 1 });
    assert.ok(performance.now() - started < 250, "close must not wait for the 1000 ms RPC timeout");
    assert.equal((await pending).degraded?.reason, "engine-unavailable");
  } finally { await f.close(); }
});


test("memory RPC failures retain recovery ids through the Core error mapper", async () => {
  const ids = { sourceId: "source", sharedId: "shared", staleSharedId: "stale" };
  const f = await fixture({ respond(method) {
    if (method === "engine.memory.show") return { $error: { code: -32000, message: "recovery required", data: { error: "E_STORAGE", reason: "storage", ids } } };
    return undefined;
  } });
  try {
    await assert.rejects(f.client.memory.show("card", principal, agent), (error: unknown) => {
      assert.deepEqual(mapMemoryOpError(error, { stopping: false })?.ids, ids);
      assert.deepEqual(mapMemoryOpError(error, { stopping: true })?.ids, ids);
      return true;
    });
  } finally { await f.close(); }
});

test("aborting a capture handle during lazy bootstrap discards it before dispatch", async () => {
  const f = await fixture({ respond(method, _params, socket) {
    if (method === "engine.capture") socket.write(JSON.stringify({ jsonrpc: "2.0", method: "engine.capture.done", params: { id: "remote-capture", result: { stored: 1, skipped: 0 } } }) + "\n");
    return undefined;
  } });
  try {
    const handle = f.client.capture({ agentId: "a", principal, agent, messages: [], incognito: false, signal });
    handle.abort("stop before dispatch");
    assert.deepEqual(await handle.done, { stored: 0, skipped: 1, reason: "aborted" });
    await f.client.status();
    assert.equal(f.calls.some(call => call.method === "engine.capture"), false);
    assert.equal(f.calls.some(call => call.method === "engine.capture.abort"), false);
  } finally { await f.close(); }
});

test("ordinary JSON fields named signal survive opaque engine parameters", async () => {
  const f = await fixture();
  try {
    const patch = { signal: "user data", nested: { signal: { flag: true } } };
    await f.client.admin.workspacePolicy.set(patch);
    assert.deepEqual(f.calls.find(call => call.method === "engine.admin.workspacePolicy.set")?.params, { patch });
  } finally { await f.close(); }
});
