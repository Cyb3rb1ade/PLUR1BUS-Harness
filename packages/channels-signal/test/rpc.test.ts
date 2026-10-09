import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonRpcClient, SignalRpcError, mapRpcError } from "../src/index.ts";
import { duplexPair, manualTimeout } from "./helpers/duplex-pair.ts";

function setup(over: Partial<ConstructorParameters<typeof JsonRpcClient>[0]> = {}) {
  const [c, s] = duplexPair();
  const notes: Array<[string, unknown]> = [];
  const t = manualTimeout();
  const closes: string[] = [];
  const client = new JsonRpcClient({
    stream: c,
    timeoutMs: 1000,
    timeout: t.fn,
    maxLineBytes: 4096,
    onNotification: (m, p) => notes.push([m, p]),
    onClose: (r) => closes.push(r),
    ...over,
  });
  const requests: Array<Record<string, any>> = [];
  s.on("data", (d: Buffer) => {
    for (const l of d.toString().split("\n")) if (l) requests.push(JSON.parse(l));
  });
  return { client, server: s, notes, t, closes, requests };
}
const tick = () => new Promise((r) => setImmediate(r));

test("rpc: request ids are unique and responses are matched by id, even out of order", async () => {
  const { client, server, requests } = setup();
  const a = client.call("one");
  const b = client.call("two");
  await tick();
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]!.id, requests[1]!.id);
  assert.equal(requests[0]!.jsonrpc, "2.0");
  server.write(JSON.stringify({ jsonrpc: "2.0", id: requests[1]!.id, result: "B" }) + "\n");
  server.write(JSON.stringify({ jsonrpc: "2.0", id: requests[0]!.id, result: "A" }) + "\n");
  assert.deepEqual(await Promise.all([a, b]), ["A", "B"]);
});

test("rpc: framing across chunk boundaries and several messages per chunk", async () => {
  const { client, server, notes, requests } = setup();
  const p = client.call("x");
  await tick();
  const id = requests[0]!.id;
  const n1 = JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { n: 1, text: "héllo 😀" } });
  const res = JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } });
  const n2 = JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { n: 2 } });
  const all = Buffer.from(`${n1}\n${res}\n${n2}\n`);
  // 1) everything in one chunk
  // 2) then byte-wise dribble including a split inside a multi-byte character
  server.write(all.subarray(0, 40));
  server.write(all.subarray(40, 41));
  const emoji = all.indexOf(Buffer.from("😀"));
  server.write(all.subarray(41, emoji + 2));
  server.write(all.subarray(emoji + 2));
  assert.deepEqual(await p, { ok: true });
  await tick();
  assert.deepEqual(notes.map((n) => (n[1] as any).n), [1, 2]);
  assert.equal((notes[0]![1] as any).text, "héllo 😀");
  // single chunk with three messages
  const p2 = client.call("y");
  await tick();
  const id2 = requests[1]!.id;
  server.write(`${n2}\n${JSON.stringify({ jsonrpc: "2.0", id: id2, result: 7 })}\n${n1}\n`);
  assert.equal(await p2, 7);
});

test("rpc: garbage lines and unknown ids are skipped, reader survives; throwing notification handler does not kill it", async () => {
  const { client, server, requests } = setup({
    onNotification: () => {
      throw new Error("boom");
    },
  });
  const p = client.call("x");
  await tick();
  server.write('not json\n[1,2]\n"str"\n{"jsonrpc":"2.0","id":999,"result":1}\n{"jsonrpc":"2.0","method":"receive","params":{}}\n\n');
  server.write(JSON.stringify({ jsonrpc: "2.0", id: requests[0]!.id, result: "fine" }) + "\n");
  assert.equal(await p, "fine");
  assert.ok(client.isOpen);
});

test("rpc: per-call timeout via injected timer; late response is ignored", async () => {
  const { client, server, t, requests } = setup();
  const p = client.call("slow");
  await tick();
  t.fireAll();
  await assert.rejects(p, (e: unknown) => e instanceof SignalRpcError && e.kind === "timeout");
  server.write(JSON.stringify({ jsonrpc: "2.0", id: requests[0]!.id, result: 1 }) + "\n");
  await tick();
  assert.ok(client.isOpen);
});

test("rpc: a settled call disarms its deadline", async () => {
  const { client, server, t, requests } = setup();
  const p = client.call("quick");
  await tick();
  server.write(JSON.stringify({ jsonrpc: "2.0", id: requests[0]!.id, result: 1 }) + "\n");
  await p;
  t.fireAll();
  await tick();
  assert.ok(client.isOpen);
});

test("rpc: connection drop rejects in-flight calls as disconnected and later calls as not-connected; onClose once", async () => {
  const { client, server, closes } = setup();
  const p = client.call("x");
  await tick();
  server.destroy();
  await assert.rejects(p, (e: unknown) => e instanceof SignalRpcError && e.kind === "disconnected");
  await client.closed;
  await assert.rejects(client.call("y"), (e: unknown) => e instanceof SignalRpcError && e.kind === "not-connected");
  assert.deepEqual(closes, ["closed"]);
});

test("rpc: an oversize line drops the connection instead of buffering without bound", async () => {
  const { client, server, closes } = setup({ maxLineBytes: 256 });
  const p = client.call("x");
  await tick();
  server.write("x".repeat(100));
  server.write("y".repeat(200));
  await assert.rejects(p, (e: unknown) => e instanceof SignalRpcError && e.kind === "disconnected");
  assert.deepEqual(closes, ["oversize"]);
});

test("rpc: abort signal rejects without leaking the pending entry", async () => {
  const { client } = setup();
  const ac = new AbortController();
  const p = client.call("x", {}, ac.signal);
  ac.abort();
  await assert.rejects(p, (e: unknown) => e instanceof SignalRpcError && e.kind === "not-connected");
});

test("rpc: server-to-client requests get method-not-found", async () => {
  const { server } = setup();
  const got: string[] = [];
  server.on("data", (d: Buffer) => got.push(d.toString()));
  server.write(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "weird" }) + "\n");
  await tick();
  assert.match(got.join(""), /-32601/);
});

const errCases: Array<[string, any, string, number | undefined]> = [
  ["rate limit by data", { code: -1, message: "Failed to send", data: { response: { results: [{ type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 30 }] } } }, "rate-limited", 30_000],
  ["rate limit clamped high", { code: -1, message: "rate limit exceeded", data: { retryAfterSeconds: 99999 } }, "rate-limited", 300_000],
  ["rate limit clamped low", { code: -1, message: "Rate limit", data: { retryAfterSeconds: 0 } }, "rate-limited", 1000],
  ["rate limit no hint", { code: -5, message: "too many requests" }, "rate-limited", 1000],
  ["untrusted identity", { code: -1, message: "org.signal.libsignal.protocol.UntrustedIdentityException: Untrusted identity key" }, "untrusted-identity", undefined],
  ["not registered", { code: -32603, message: "NotRegisteredException: User is not registered." }, "not-registered", undefined],
  ["method not found", { code: -32601, message: "Method not found" }, "rpc", undefined],
  ["generic", { code: -1, message: "something else with +4915112345678" }, "rpc", undefined],
];
for (const [name, input, kind, retry] of errCases)
  test(`rpc error mapping: ${name}`, () => {
    const e = mapRpcError(input);
    assert.equal(e.kind, kind);
    assert.equal(e.retryAfterMs, retry);
    assert.ok(!/\+49|\d{8}/.test(e.message), "daemon text never copied into the message");
  });
