// The API key reaches the server in one header and nowhere else: not in the URL, not in the body, not in any error, not in any log.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { createGeminiAdapter, ProviderError } from "../../src/index.ts";
import type { GeminiAdapter } from "../../src/index.ts";
import { startStub } from "../helpers/stub.ts";
import { adapterFor, cand, fakeKey, KEY, part, req, sendJson, sendSse, sse } from "./helpers.ts";

const T = { timeout: 15_000 };
const MARKER = /LEAKMARKER|AIza/;
const OTHER_KEY = "AIzaSyOTHERKEY9876543210zyxwvutsrqpon"; // a different key the provider echoes: shape-based scrubbing

function assertClean(e: ProviderError, where: string): void {
  const dump = [e.message, e.providerMessage ?? "", e.stack ?? "", JSON.stringify(e), inspect(e, { depth: 6 }), String(e.cause ?? ""), JSON.stringify(e.partial ?? {})].join("\n");
  assert.doesNotMatch(dump, MARKER, `${where}: the key leaked into an error`);
}
const failure = async (p: Promise<unknown>): Promise<ProviderError> => {
  try { await p; } catch (e) { assert.ok(e instanceof ProviderError); return e; }
  throw new assert.AssertionError({ message: "expected a ProviderError" });
};
const drain = async (it: ReturnType<GeminiAdapter["stream"]>) => { for await (const _ of it) { /* drain */ } };

test("the key travels in x-goog-api-key only: never in the URL, the body or the fetch arguments", T, async () => {
  const seen: { url: string; body: string }[] = [];
  const stub = await startStub((_q, res) => sendSse(res, sse(cand([part("ok")], "STOP"))));
  try {
    const spy: typeof fetch = (input, init) => { seen.push({ url: String(input), body: String(init?.body) }); return fetch(input, init); };
    const a = adapterFor(stub.baseUrl, { fetch: spy });
    await drain(a.stream({ ...req, messages: [{ role: "system", content: "s" }, ...req.messages] }));
    await a.complete(req).catch(() => undefined);
    assert.equal(seen.length, 2);
    for (const s of seen) { assert.doesNotMatch(s.url, MARKER); assert.doesNotMatch(s.url, /[?&]key=/i); assert.doesNotMatch(s.body, MARKER); }
    for (const r of stub.requests) {
      assert.equal(r.headers["x-goog-api-key"], KEY);
      assert.doesNotMatch(r.url ?? "", MARKER);
      assert.doesNotMatch(r.body, MARKER);
      assert.equal(r.headers["authorization"], undefined);
    }
  } finally { await stub.close(); }
});

test("provider text that echoes the key is scrubbed from every error path, and nothing is logged", T, async () => {
  const echo = `bad key ${KEY} and also ${OTHER_KEY}`;
  const cases: [string, (res: Parameters<Parameters<typeof startStub>[0]>[1]) => void, "complete" | "stream"][] = [
    ["400", (res) => sendJson(res, { error: { code: 400, status: "INVALID_ARGUMENT", message: echo } }, 400), "complete"],
    ["429", (res) => sendJson(res, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: echo } }, 429), "complete"],
    ["503 text/plain", (res) => { res.writeHead(503, { "content-type": "text/plain" }); res.end(echo); }, "stream"],
    ["200 json error", (res) => sendJson(res, { error: { code: 500, status: "INTERNAL", message: echo } }), "complete"],
    ["in-stream error", (res) => sendSse(res, sse(cand([part("x")]), { error: { code: 500, status: "INTERNAL", message: echo } })), "stream"],
    ["prompt block", (res) => sendSse(res, sse({ promptFeedback: { blockReason: "SAFETY", blockReasonMessage: echo } })), "stream"],
    ["candidate block", (res) => sendJson(res, { candidates: [{ finishReason: "SAFETY", finishMessage: echo }] }), "complete"],
  ];
  const logged: string[] = [];
  const realOut = process.stdout.write, realErr = process.stderr.write;
  const tap = (orig: typeof process.stdout.write) => ((chunk: unknown, ...rest: unknown[]) => { logged.push(String(chunk)); return (orig as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest); }) as typeof process.stdout.write;
  let i = 0;
  const stub = await startStub((_q, res) => cases[i++]![1](res));
  try {
    process.stdout.write = tap(realOut); process.stderr.write = tap(realErr);
    for (const [name, , how] of cases) {
      const a = adapterFor(stub.baseUrl);
      const e = await failure(how === "complete" ? a.complete(req) : drain(a.stream(req)));
      assertClean(e, name);
      if (e.providerMessage) assert.match(e.providerMessage, /\[redacted\]/, name);
    }
  } finally {
    process.stdout.write = realOut; process.stderr.write = realErr;
    await stub.close();
  }
  assert.doesNotMatch(logged.join(""), MARKER, "the key was written to stdout/stderr");
});

test("transport failure and timeouts carry no key", T, async () => {
  const stub = await startStub((q) => { q.socket.destroy(); });
  try {
    assertClean(await failure(adapterFor(stub.baseUrl).complete(req)), "reset");
  } finally { await stub.close(); }
  const stub2 = await startStub(() => new Promise<void>(() => undefined));
  try {
    assertClean(await failure(adapterFor(stub2.baseUrl, { timeouts: { headersMs: 50, totalMs: 1000 } }).complete(req)), "timeout");
  } finally { await stub2.close(); }
});

test("a key can neither be put into the base URL nor into extra headers", T, () => {
  const c = fakeKey();
  assert.throws(() => createGeminiAdapter({ baseUrl: `https://example.invalid/v1beta?key=${KEY}`, credentials: c }), TypeError);
  assert.throws(() => createGeminiAdapter({ baseUrl: `https://user:${KEY}@example.invalid/v1beta`, credentials: c }), TypeError);
  assert.throws(() => createGeminiAdapter({ baseUrl: "https://example.invalid/v1beta#frag", credentials: c }), TypeError);
  for (const h of ["x-goog-api-key", "Authorization", "X-Goog-User-Project", "Content-Type"]) {
    assert.throws(() => createGeminiAdapter({ baseUrl: "https://example.invalid/v1beta", credentials: c, headers: { [h]: "x" } }), TypeError, h);
  }
});

test("no key, an unusable key or plain http to a remote host: auth/bad_request before any I/O", T, async () => {
  let calls = 0;
  const never: typeof fetch = () => { calls++; throw new Error("must not be called"); };
  const base = "https://example.invalid/v1beta";
  for (const key of [undefined, "", "has space AIza", "line\nbreak"]) {
    const e = await failure(adapterFor(base, { credentials: { apiKey: () => key }, fetch: never }).complete(req));
    assert.equal(e.kind, "auth");
    assertClean(e, "unusable key");
  }
  const throwing = adapterFor(base, { credentials: { apiKey: () => { throw new Error(`vault failure for ${KEY}`); } }, fetch: never });
  const e = await failure(throwing.complete(req));
  assert.equal(e.kind, "auth");
  assert.equal(e.message, "credentials provider failed"); // the cause stays attached for the caller, the message stays clean
  const http = await failure(adapterFor("http://example.invalid/v1beta", { fetch: never }).complete(req));
  assert.equal(http.kind, "bad_request");
  assertClean(http, "plain http");
  assert.equal(calls, 0);
});

test("the key is asked for on every call (rotation) with the call's abort signal", T, async () => {
  const stub = await startStub((_q, res) => sendJson(res, cand([part("ok")], "STOP")));
  try {
    const keys = ["AIzaSyFIRST0000000000000000000000", "AIzaSySECOND000000000000000000000"];
    const signals: unknown[] = [];
    let n = 0;
    const a = adapterFor(stub.baseUrl, { credentials: { apiKey: (ctx) => { signals.push(ctx.signal); return keys[n++]!; } } });
    await a.complete(req); await a.complete(req);
    assert.deepEqual(stub.requests.map((r) => r.headers["x-goog-api-key"]), keys);
    assert.ok(signals.every((s) => s instanceof AbortSignal));
  } finally { await stub.close(); }
});
