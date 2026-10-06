// Acceptance: an abort mid-stream ends the call cleanly (typed `aborted`, partial kept) and leaves no open handle.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatCompletionsAdapter, ProviderError } from "../src/index.ts";
import { basicRequest, credentials, hold, sseHeaders, startStub, until } from "./helpers/stub.ts";

const T = { timeout: 15_000 };
const part = (s: string) => `data: ${JSON.stringify({ id: "chatcmpl-synthetic-3", choices: [{ index: 0, delta: { content: s }, finish_reason: null }] })}\n\n`;

function resources(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of process.getActiveResourcesInfo()) out[r] = (out[r] ?? 0) + 1;
  return out;
}
const handles = () => { const r = resources(); return (r["TCPSocketWrap"] ?? 0) + (r["Timeout"] ?? 0) + (r["TCPServerWrap"] ?? 0) + (r["Immediate"] ?? 0); };

test("abort mid-stream: typed aborted error, partial text kept, server connection closed, no timer or socket left", T, async () => {
  const baseline = handles();
  let serverSawClose = false;
  const stub = await startStub(async (req, res) => {
    req.socket.on("close", () => { serverSawClose = true; });
    sseHeaders(res);
    res.write(part("one "));
    res.write(part("two "));
    await hold(res);
  });
  const ac = new AbortController();
  const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials(), timeouts: { headersMs: 30_000, idleMs: 30_000, totalMs: 30_000 } });
  const seen: string[] = [];
  let caught: unknown;
  try {
    for await (const e of a.stream(basicRequest, { signal: ac.signal })) {
      if (e.type === "text_delta") { seen.push(e.text); if (seen.length === 2) ac.abort(new Error("user pressed stop")); }
    }
  } catch (e) { caught = e; }
  assert.ok(caught instanceof ProviderError, String(caught));
  assert.equal(caught.kind, "aborted");
  assert.equal(caught.retryable, false);
  assert.deepEqual(seen, ["one ", "two "]);
  assert.equal(caught.partial?.text, "one two ");
  assert.ok(await until(() => serverSawClose), "the server saw the connection close");
  await stub.close();
  assert.ok(await until(() => handles() <= baseline, 3000), `handles after ${JSON.stringify(resources())} vs baseline ${baseline}`);
});

test("abort before the call starts: nothing is sent", T, async () => {
  const stub = await startStub((_q, res) => { res.end(); });
  try {
    const ac = new AbortController();
    ac.abort();
    const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() });
    await assert.rejects(async () => { for await (const _ of a.stream(basicRequest, { signal: ac.signal })) { /* */ } }, (e) => e instanceof ProviderError && e.kind === "aborted");
    await assert.rejects(a.complete(basicRequest, { signal: ac.signal }), (e) => e instanceof ProviderError && e.kind === "aborted");
    assert.equal(stub.requests.length, 0);
  } finally { await stub.close(); }
});

test("abort while waiting for headers", T, async () => {
  let closed = false;
  const stub = await startStub(async (req, res) => { req.socket.on("close", () => { closed = true; }); await hold(res); });
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() });
    await assert.rejects(a.complete(basicRequest, { signal: ac.signal }), (e) => e instanceof ProviderError && e.kind === "aborted");
    assert.ok(await until(() => closed));
  } finally { await stub.close(); }
});

test("abort while the credentials are being fetched", T, async () => {
  const ac = new AbortController();
  const slow = { authorization: ({ signal }: { signal: AbortSignal }) => new Promise<string>((_ok, no) => signal.addEventListener("abort", () => no(new Error("lookup cancelled")))) };
  const stub = await startStub((_q, res) => { res.end(); });
  try {
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: slow }).complete(basicRequest, { signal: ac.signal }), (e) => e instanceof ProviderError && e.kind === "aborted");
    assert.equal(stub.requests.length, 0);
  } finally { await stub.close(); }
});

test("a consumer that stops iterating early cancels the request and frees the connection", T, async () => {
  let closed = false;
  const stub = await startStub(async (req, res) => {
    req.socket.on("close", () => { closed = true; });
    sseHeaders(res);
    res.write(part("first"));
    await hold(res);
  });
  try {
    const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() });
    for await (const e of a.stream(basicRequest)) { if (e.type === "text_delta") break; }
    assert.ok(await until(() => closed), "breaking out of the loop closed the connection");
  } finally { await stub.close(); }
});

test("abort after completion is harmless; a finished call leaves no timer behind", T, async () => {
  const baseline = handles();
  const stub = await startStub((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }));
  });
  const ac = new AbortController();
  const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials(), timeouts: { headersMs: 30_000, idleMs: 30_000, totalMs: 30_000 } });
  assert.equal((await a.complete(basicRequest, { signal: ac.signal })).text, "done");
  ac.abort();
  await stub.close();
  assert.ok(await until(() => handles() <= baseline, 3000), JSON.stringify(resources()));
});
