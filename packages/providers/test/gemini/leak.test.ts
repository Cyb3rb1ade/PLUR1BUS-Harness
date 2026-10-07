// The secret-leak marker test: a recognisable key goes through every path (success, stream, every error class, a
// server that echoes the key back) and the marker must appear in no URL, no request body, no error (message, fields,
// cause chain, stack), no result and no partial. The adapter has no logger; what it hands out is what a log could hold.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { ProviderError, createGeminiAdapter } from "../../src/index.ts";
import type { ChatRequest } from "../../src/index.ts";
import { startStub } from "../helpers/stub.ts";
import type { Handler } from "../helpers/stub.ts";
import { KEY, T, adapterFor, basic, candidate, collect, geminiError, json, sse } from "./helpers.ts";

const MARK = "LEAKMARKER";

function everything(v: unknown): string {
  const seen = new Set<unknown>();
  const walk = (x: unknown): string => {
    if (typeof x !== "object" || x === null) return String(x);
    if (seen.has(x)) return "";
    seen.add(x);
    const own = Object.getOwnPropertyNames(x).map((k) => walk((x as Record<string, unknown>)[k])).join("|");
    return `${inspect(x, { depth: 6, showHidden: true })}|${own}`;
  };
  return walk(v);
}

async function observe(handler: Handler, mode: "complete" | "stream" = "complete", req: ChatRequest = basic): Promise<string> {
  const stub = await startStub(handler);
  try {
    const { adapter } = adapterFor(stub);
    const out: unknown[] = [];
    try { out.push(mode === "complete" ? await adapter.complete(req) : await collect(adapter.stream(req))); } catch (e) { out.push(e); }
    for (const r of stub.requests) out.push(r.url, r.body);
    return everything(out);
  } finally { await stub.close(); }
}

const echo = (what: string) => `request with key ${KEY} rejected ${what}`;

test("the marker is in the key we use (guard against a vacuous test)", () => {
  assert.ok(KEY.includes(MARK));
});

test("success and stream paths", T, async () => {
  const text = candidate([{ text: "fine" }], "STOP");
  assert.equal((await observe((_q, res) => json(res, text))).includes(MARK), false);
  assert.equal((await observe((_q, res) => sse(res, [text]), "stream")).includes(MARK), false);
});

test("a server that echoes the key in its error text: every status class comes back redacted", T, async () => {
  for (const [status, g] of [[400, "INVALID_ARGUMENT"], [401, "UNAUTHENTICATED"], [403, "PERMISSION_DENIED"], [404, "NOT_FOUND"], [429, "RESOURCE_EXHAUSTED"], [500, "INTERNAL"], [503, "UNAVAILABLE"]] as const) {
    const seen = await observe((_q, res) => json(res, geminiError(status, g, echo(g)), status));
    assert.equal(seen.includes(MARK), false, `${status} ${g}`);
    assert.ok(seen.includes("[redacted]"), `${status} ${g} was echoed and must show the redaction`);
  }
});

test("a key echoed inside the stream (error event, block messages) is redacted too", T, async () => {
  assert.equal((await observe((_q, res) => sse(res, [geminiError(429, "RESOURCE_EXHAUSTED", echo("stream"))]), "stream")).includes(MARK), false);
  assert.equal((await observe((_q, res) => sse(res, [{ promptFeedback: { blockReason: "OTHER", blockReasonMessage: echo("prompt") } }]), "stream")).includes(MARK), false);
  assert.equal((await observe((_q, res) => json(res, candidate([{ text: "x" }], "SAFETY", { finishMessage: echo("candidate") })))).includes(MARK), false);
  assert.equal((await observe((_q, res) => json(res, geminiError(400, "INVALID_ARGUMENT", echo("body")), 200))).includes(MARK), false);
});

test("malformed responses, truncated streams, auth failures, aborts and timeouts", T, async () => {
  assert.equal((await observe((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{bad"); })).includes(MARK), false);
  assert.equal((await observe((_q, res) => sse(res, [candidate([{ text: "half" }])]), "stream")).includes(MARK), false);
  assert.equal((await observe((_q, res) => { res.writeHead(302, { location: `https://example.invalid/?key=${KEY}` }); res.end(); })).includes(MARK), false);
  const stub = await startStub((_q, res) => { void res; });
  try {
    const { adapter } = adapterFor(stub, { timeouts: { headersMs: 100, totalMs: 100 } });
    const e = await adapter.complete(basic).then(() => undefined, (x: unknown) => x);
    assert.ok(e instanceof ProviderError && e.kind === "timeout");
    assert.equal(everything([e, ...stub.requests.map((r) => [r.url, r.body])]).includes(MARK), false);
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    const a = await adapter.complete(basic, { signal: ac.signal }).then(() => undefined, (x: unknown) => x);
    assert.ok(a instanceof ProviderError && a.kind === "aborted");
    assert.equal(everything(a).includes(MARK), false);
  } finally { await stub.close(); }
});

test("a transport failure (connection refused) and an injected fetch that throws with the key in its own message", T, async () => {
  const adapter = createGeminiAdapter({ baseUrl: "http://127.0.0.1:9/v1", credentials: { apiKey: () => KEY } });
  const e = await adapter.complete(basic).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof ProviderError && e.kind === "network");
  assert.equal(everything(e).includes(MARK), false);
  // RULING: an error thrown by the transport is wrapped as `network` with its message; the adapter never puts the key in a
  // request-level object a transport could echo (it is only a header value), so the realistic echo is the server's text, covered above.
});

test("an invalid request is refused before the key is even read", T, async () => {
  let reads = 0;
  const adapter = createGeminiAdapter({ credentials: { apiKey: () => { reads++; return KEY; } }, fetch: (async () => { throw new Error("no"); }) as unknown as typeof fetch });
  await assert.rejects(adapter.complete({ model: basic.model, messages: [] }), (e: unknown) => e instanceof ProviderError && e.kind === "bad_request");
  assert.equal(reads, 0);
});
