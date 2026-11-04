import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import { formatSSEEvent, formatSSEErrorEvent, SSE_HEADERS, HTTP_EXTENSION_HEADER } from "@a2a-js/sdk";
import { LEGACY_HTTP_EXTENSION_HEADER } from "@a2a-js/sdk/compat/v0_3";
import { JsonRpcTransportHandler, ServerCallContext } from "@a2a-js/sdk/server";
import { A2aServerCore } from "../src/a2a/server.ts";
import { DEFAULT_PROTOCOL_HEARTBEAT_MS } from "../src/protocol-routes.ts";

function response() {
  const chunks: string[] = [];
  let headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    headersSent: false, writableEnded: false, destroyed: false, socket: new EventEmitter(),
    writeHead(_status: number, values: Record<string, string>) { headers = values; this.headersSent = true; },
    flushHeaders() {}, write(chunk: string) { chunks.push(chunk); return true; }, end(chunk?: string) { if (chunk) chunks.push(chunk); this.writableEnded = true; },
  });
  return { res: res as unknown as ServerResponse, chunks, headers: () => headers };
}
const core = () => new A2aServerCore({ agentId: "main", tokenId: "fixture", baseUrl: "https://example.test", core: { async call() { throw new Error("stream fixture must not call Core"); } } });
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

for (const legacy of [false, true]) test(`A2A ${legacy ? '0.3' : '1.0'} retains the exact SDK bytes for every stream event and error`, async () => {
  const task = { id: "task", contextId: "context", status: { state: "TASK_STATE_WORKING" } };
  const message = { role: "ROLE_AGENT", messageId: "message", parts: [{ text: "line one\nline two ♥" }] };
  const status = { taskId: "task", contextId: "context", status: { state: "TASK_STATE_COMPLETED" }, final: true };
  const artifact = { taskId: "task", contextId: "context", artifact: { artifactId: "a", parts: [{ text: "artifact" }] }, append: false, lastChunk: true };
  const results = legacy ? [
    { ...task, status: { state: "working" }, kind: "task" },
    { ...message, role: "agent", parts: [{ kind: "text", text: "line one\nline two ♥" }], kind: "message" },
    { id: "task", contextId: "context", status: { state: "completed" }, final: true, kind: "status-update" },
    { id: "task", contextId: "context", artifact: { artifactId: "a", parts: [{ kind: "text", text: "artifact" }] }, append: false, lastChunk: true, kind: "artifact-update" },
  ] : [{ task }, { message }, { statusUpdate: status }, { artifactUpdate: artifact }];
  const events = results.map(result => ({ jsonrpc: "2.0", id: "rpc", result }));
  const error = new Error("controlled stream failure");
  async function* stream() { yield* events; throw error; }
  const f = response();
  const context = new ServerCallContext({ requestedVersion: legacy ? "0.3" : "1.0" });
  context.addActivatedExtension("https://example.test/extension");
  await core().streamToResponse(f.res, "rpc", stream(), context, legacy);
  const rpcError = { jsonrpc: "2.0", id: "rpc", error: JsonRpcTransportHandler.mapToJSONRPCError(error) };
  assert.equal(Buffer.concat(f.chunks.map(c => Buffer.from(c))).toString('hex'), Buffer.from(events.map(formatSSEEvent).join('') + formatSSEErrorEvent(rpcError)).toString('hex'));
  assert.deepEqual(f.headers(), { ...SSE_HEADERS, [legacy ? LEGACY_HTTP_EXTENSION_HEADER : HTTP_EXTENSION_HEADER]: "https://example.test/extension" });
  assert.equal(f.res.writableEnded, true);
  assert.equal(f.res.socket!.listenerCount("close"), 0, "an ended response must not remain attached to a reusable socket");
});

test("A2A bridge finishes on disconnect while the next producer item is still pending", async () => {
  let release!: () => void, waiting!: () => void, finalized = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { waiting = resolve; });
  async function* stream() { try { yield { jsonrpc: "2.0", id: "rpc", result: { task: { id: "task" } } }; waiting(); await gate; yield { unexpected: true }; } finally { finalized++; } }
  const f = response(); let finished = false;
  const pending = core().streamToResponse(f.res, "rpc", stream(), new ServerCallContext(), false).then(() => { finished = true; });
  try {
    await entered; f.res.destroyed = true; f.res.emit("close"); await tick();
    assert.equal(finished, true, "a disconnected response must not wait for a blocked producer");
    assert.equal(f.chunks.length, 1);
  } finally { release(); await pending; await tick(); }
  assert.equal(finalized, 1);
});

test("A2A bridge also stops waiting before the first stream item, without sending SSE headers", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  async function* stream() { entered(); await gate; yield { late: true }; }
  const f = response(); let finished = false;
  const pending = core().streamToResponse(f.res, "rpc", stream(), new ServerCallContext(), false).then(() => { finished = true; });
  try {
    await waiting; f.res.destroyed = true; f.res.emit("close"); await tick();
    assert.equal(finished, true); assert.equal(f.res.headersSent, false); assert.deepEqual(f.chunks, []);
  } finally { release(); await pending; }
});

test("A2A pre-stream errors retain the non-stream JSON response", async () => {
  const error = new Error("controlled pre-stream failure");
  async function* stream(): AsyncGenerator<unknown, void, undefined> { throw error; }
  const f = response();
  await core().streamToResponse(f.res, 7, stream(), new ServerCallContext(), false);
  assert.deepEqual(f.headers(), { "Content-Type": "application/json" });
  assert.equal(f.chunks.join(''), JSON.stringify({ jsonrpc: "2.0", id: 7, error: JsonRpcTransportHandler.mapToJSONRPCError(error) }));
});

test("A2A waits for drain before asking the producer for another event", async () => {
  let advanced = 0, blocked = true;
  const f = response();
  f.res.write = ((chunk: string) => { f.chunks.push(chunk); return !blocked; }) as typeof f.res.write;
  async function* stream() { yield { first: true }; advanced++; yield { second: true }; }
  const pending = core().streamToResponse(f.res, 1, stream(), new ServerCallContext(), false);
  try {
    await tick(); assert.equal(f.chunks.length, 1); assert.equal(advanced, 0);
  } finally { blocked = false; f.res.emit('drain'); await pending; }
  assert.equal(advanced, 1); assert.equal(f.chunks.length, 2); assert.equal(f.res.listenerCount('drain'), 0);
});

test("shared heartbeats stop on disconnect and a late producer failure stays observed", async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let fail!: (error: Error) => void, entered!: () => void;
  const gate = new Promise<void>((_resolve, reject) => { fail = reject; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  async function* stream() { yield { first: true }; entered(); await gate; }
  const f = response();
  const pending = core().streamToResponse(f.res, 1, stream(), new ServerCallContext(), false);
  await waiting; t.mock.timers.tick(DEFAULT_PROTOCOL_HEARTBEAT_MS); await tick();
  assert.equal(f.chunks.at(-1), ': heartbeat\n\n');
  f.res.destroyed = true; f.res.emit('close'); await pending;
  const count = f.chunks.length; t.mock.timers.tick(DEFAULT_PROTOCOL_HEARTBEAT_MS * 2);
  fail(new Error('late producer failure')); await tick();
  assert.equal(f.chunks.length, count); assert.equal(f.res.socket!.listenerCount('close'), 0);
});

test("heartbeats do not queue additional writes while the socket is backpressured", async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = response();
  f.res.write = ((chunk: string) => { f.chunks.push(chunk); return false; }) as typeof f.res.write;
  async function* stream() { yield { first: true }; }
  const pending = core().streamToResponse(f.res, 1, stream(), new ServerCallContext(), false);
  try {
    await tick(); t.mock.timers.tick(DEFAULT_PROTOCOL_HEARTBEAT_MS * 20); await tick();
    assert.equal(f.chunks.length, 1, 'a blocked socket must not accumulate periodic heartbeat frames');
  } finally { f.res.destroyed = true; f.res.emit('close'); await pending; }
  assert.equal(f.res.listenerCount('drain'), 0);
});
