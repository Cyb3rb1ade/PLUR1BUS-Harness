// Acceptance: every error class of the taxonomy is produced by a fixture, on both the stream and the non-stream path.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";
import { createChatCompletionsAdapter, parseRetryAfter, ProviderError } from "../src/index.ts";
import type { ProviderErrorKind } from "../src/index.ts";
import { basicRequest, credentials, hold, sleep, sseHeaders, startStub } from "./helpers/stub.ts";

const T = { timeout: 20_000 };
const dir = new URL("./fixtures/errors/", import.meta.url);

interface ErrorFixture {
  expect: { kind: ProviderErrorKind; status: number; retryable: boolean; code?: string; retryAfterMs?: number };
  response: { status: number; headers: Record<string, string>; body: unknown };
}
const fixtures = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => [f, JSON.parse(readFileSync(new URL(f, dir), "utf8")) as ErrorFixture] as const);

async function failure(p: Promise<unknown> | AsyncGenerator<unknown>): Promise<ProviderError> {
  try {
    if (Symbol.asyncIterator in p) for await (const _ of p) { /* drain */ } else await p;
  } catch (e) {
    assert.ok(e instanceof ProviderError, `expected ProviderError, got ${String(e)}`);
    return e;
  }
  assert.fail("expected the call to fail");
}

test("the fixtures cover every error kind the HTTP layer can produce", T, () => {
  const kinds = new Set(fixtures.map(([, f]) => f.expect.kind));
  for (const k of ["auth", "rate_limit", "context_length", "content_filter", "bad_request", "server", "timeout", "protocol"] as const) assert.ok(kinds.has(k), k);
});

for (const [name, fx] of fixtures) {
  for (const path of ["complete", "stream"] as const) {
    test(`${name} → ${fx.expect.kind} (${path})`, T, async () => {
      const stub = await startStub((_req, res) => {
        const body = typeof fx.response.body === "string" ? fx.response.body : JSON.stringify(fx.response.body);
        res.writeHead(fx.response.status, { "content-type": "application/json", ...fx.response.headers });
        res.end(body);
      });
      try {
        const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() });
        const err = await failure(path === "complete" ? a.complete(basicRequest) : a.stream(basicRequest));
        assert.equal(err.kind, fx.expect.kind);
        assert.equal(err.status, fx.expect.status);
        assert.equal(err.retryable, fx.expect.retryable);
        assert.equal(err.code, fx.expect.code);
        assert.equal(err.retryAfterMs, fx.expect.retryAfterMs);
        assert.ok(!err.message.includes("synthetic-secret-token-123"), "a credential echoed by the provider must not survive into the error");
        assert.equal(stub.requests.length, 1, "an error response is never retried or followed by the adapter");
      } finally { await stub.close(); }
    });
  }
}

test("the credential echoed in a provider message is redacted", T, async () => {
  const stub = await startStub((_q, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "bad key synthetic-secret-token-123 given" } })); });
  try {
    const err = await failure(createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() }).complete(basicRequest));
    assert.equal(err.providerMessage, "bad key [redacted] given");
  } finally { await stub.close(); }
});

test("Retry-After accepts seconds, an HTTP date and retry-after-ms; garbage is ignored; the value is capped", T, () => {
  const h = (o: Record<string, string>) => new Headers(o);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfter(h({ "retry-after": "12" }), now), 12_000);
  assert.equal(parseRetryAfter(h({ "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" }), now), 30_000);
  assert.equal(parseRetryAfter(h({ "retry-after": "Wed, 31 Dec 2025 00:00:00 GMT" }), now), 0);
  assert.equal(parseRetryAfter(h({ "retry-after-ms": "250" }), now), 250);
  assert.equal(parseRetryAfter(h({ "retry-after": "Thursday, 01-Jan-26 00:01:00 GMT" }), now), 60_000);
  assert.equal(parseRetryAfter(h({ "retry-after": "Thu Jan  1 00:00:05 2026" }), now), 5_000);
  for (const bad of ["soon", "12abc", "1.5", "0x10", "Thu, 01 Jan 2026 00:00:30 +0100", "Thu 01 Jan 2026", "2026-01-01T00:00:30Z", "Jan 1 2026"]) {
    assert.equal(parseRetryAfter(h({ "retry-after": bad }), now), undefined, bad);
  }
  assert.equal(parseRetryAfter(h({ "retry-after-ms": "1.5" }), now), undefined);
  assert.equal(parseRetryAfter(h({ "retry-after": "-5" }), now), undefined);
  assert.equal(parseRetryAfter(h({ "retry-after": "999999999" }), now), 24 * 3600 * 1000);
  assert.equal(parseRetryAfter(h({}), now), undefined);
});

test("a 200 JSON error body on a stream request is classified like the non-stream error", T, async () => {
  const cases: [object, ProviderErrorKind][] = [
    [{ error: { message: "slow down", type: "rate_limit_error", code: "rate_limit_exceeded" } }, "rate_limit"],
    [{ error: { message: "too long", code: "context_length_exceeded" } }, "context_length"],
    [{ error: { message: "oops", type: "server_error" } }, "server"],
  ];
  for (const [payload, kind] of cases) {
    const stub = await startStub((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); });
    try {
      const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() });
      assert.equal((await failure(a.stream(basicRequest))).kind, kind);
      assert.equal((await failure(a.complete(basicRequest))).kind, kind, "same answer on the non-stream path");
    } finally { await stub.close(); }
  }
});

test("an error object inside a 200 stream is classified by its code and type", T, async () => {
  const cases: [object, ProviderErrorKind][] = [
    [{ error: { message: "slow down", type: "rate_limit_error", code: "rate_limit_exceeded" } }, "rate_limit"],
    [{ error: { message: "too long", code: "context_length_exceeded" } }, "context_length"],
    [{ error: { message: "blocked", code: "content_filter" } }, "content_filter"],
    [{ error: { message: "oops", type: "server_error" } }, "server"],
    [{ error: { message: "who knows" } }, "server"],
  ];
  for (const [payload, kind] of cases) {
    const stub = await startStub((_q, res) => {
      sseHeaders(res);
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-synthetic-9", choices: [{ index: 0, delta: { content: "par" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.end();
    });
    try {
      const err = await failure(createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() }).stream(basicRequest));
      assert.equal(err.kind, kind);
      assert.equal(err.status, undefined);
      assert.equal(err.partial?.text, "par", "what arrived before the error is kept");
    } finally { await stub.close(); }
  }
});

test("timeout: headers never arrive", T, async () => {
  const stub = await startStub((_q, res) => hold(res));
  try {
    const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials(), timeouts: { headersMs: 80 } });
    const err = await failure(a.stream(basicRequest));
    assert.equal(err.kind, "timeout");
    assert.equal(err.timeoutPhase, "headers");
    assert.equal(err.retryable, true);
  } finally { await stub.close(); }
});

test("timeout: the stream goes silent (idle) and the partial turn is reported", T, async () => {
  const stub = await startStub((_q, res) => {
    sseHeaders(res);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "half" }, finish_reason: null }] })}\n\n`);
  });
  try {
    const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials(), timeouts: { idleMs: 100 } });
    const err = await failure(a.stream(basicRequest));
    assert.equal(err.kind, "timeout");
    assert.equal(err.timeoutPhase, "idle");
    assert.equal(err.partial?.text, "half");
  } finally { await stub.close(); }
});

test("timeout: the whole-call bound fires even while chunks keep arriving; per-call overrides win", T, async () => {
  const stub = await startStub(async (_q, res) => {
    sseHeaders(res);
    for (let i = 0; i < 100 && !res.destroyed; i++) { res.write(`: tick ${i}\n\n`); await sleep(20); }
  });
  try {
    const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials(), timeouts: { totalMs: 60_000 } });
    const err = await failure(a.stream(basicRequest, { timeouts: { totalMs: 150 } }));
    assert.equal(err.kind, "timeout");
    assert.equal(err.timeoutPhase, "total");
  } finally { await stub.close(); }
});

test("timeout: a non-stream call is bounded by totalMs, not by the headers bound", T, async () => {
  const stub = await startStub(async (_q, res) => {
    await sleep(250); // headers arrive only when generation ends
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "late" }, finish_reason: "stop" }] }));
  });
  try {
    const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials(), timeouts: { totalMs: 5000 } });
    assert.equal((await a.complete(basicRequest)).text, "late");
    const b = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials(), timeouts: { totalMs: 100 } });
    assert.equal((await failure(b.complete(basicRequest))).timeoutPhase, "total");
  } finally { await stub.close(); }
});

test("network: connection refused", T, async () => {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  const err = await failure(createChatCompletionsAdapter({ baseUrl: `http://127.0.0.1:${port}/v1`, credentials: credentials() }).complete(basicRequest));
  assert.equal(err.kind, "network");
  assert.equal(err.retryable, true);
});

test("network: the server drops the connection before and during the response", T, async () => {
  const early = await startStub((req) => { req.socket.destroy(); });
  try {
    const err = await failure(createChatCompletionsAdapter({ baseUrl: early.baseUrl, credentials: credentials() }).stream(basicRequest));
    assert.equal(err.kind, "network");
  } finally { await early.close(); }
  const mid = await startStub((req, res) => {
    sseHeaders(res);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] })}\n\n`, () => req.socket.destroy());
  });
  try {
    const err = await failure(createChatCompletionsAdapter({ baseUrl: mid.baseUrl, credentials: credentials() }).stream(basicRequest));
    assert.equal(err.kind, "network");
    assert.equal(err.partial?.text, "x");
  } finally { await mid.close(); }
});

test("auth: a failing or unusable credentials provider is an auth error and nothing is sent", T, async () => {
  const stub = await startStub((_q, res) => { res.end(); });
  try {
    const boom = { authorization: () => { throw new Error("keychain locked"); } };
    assert.equal((await failure(createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: boom }).complete(basicRequest))).kind, "auth");
    const crlf = credentials("Bearer abc\r\nX-Evil: 1");
    assert.equal((await failure(createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: crlf }).complete(basicRequest))).kind, "auth");
    assert.equal(stub.requests.length, 0);
  } finally { await stub.close(); }
});

test("no Authorization value → the header is simply absent (local servers)", T, async () => {
  const stub = await startStub((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
  });
  try {
    await createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: { authorization: () => undefined }, headers: { "x-title": "plur1bus" } }).complete(basicRequest);
    assert.equal(stub.requests[0]!.headers["authorization"], undefined);
    assert.equal(stub.requests[0]!.headers["x-title"], "plur1bus");
  } finally { await stub.close(); }
});

test("the credential is never sent over plain http to a non-loopback host", T, async () => {
  let called = 0;
  const f = (async () => { called++; return new Response("{}"); }) as typeof fetch;
  const a = createChatCompletionsAdapter({ baseUrl: "http://models.example.invalid/v1", credentials: credentials(), fetch: f });
  const err = await failure(a.complete(basicRequest));
  assert.equal(err.kind, "bad_request");
  assert.equal(called, 0);
  const ok = createChatCompletionsAdapter({ baseUrl: "http://models.example.invalid/v1", credentials: credentials(), fetch: async () => new Response(JSON.stringify({ choices: [{ index: 0, message: { content: "k" }, finish_reason: "stop" }] })), allowInsecureHttp: true });
  assert.equal((await ok.complete(basicRequest)).text, "k");
});

test("configuration mistakes throw at construction", T, () => {
  const c = credentials();
  assert.throws(() => createChatCompletionsAdapter({ baseUrl: "not a url", credentials: c }), TypeError);
  assert.throws(() => createChatCompletionsAdapter({ baseUrl: "ftp://x/v1", credentials: c }), TypeError);
  assert.throws(() => createChatCompletionsAdapter({ baseUrl: "https://u:p@x/v1", credentials: c }), TypeError);
  assert.throws(() => createChatCompletionsAdapter({ baseUrl: "https://x/v1?k=1", credentials: c }), TypeError);
  assert.throws(() => createChatCompletionsAdapter({ baseUrl: "https://x/v1", credentials: c, headers: { Authorization: "Bearer x" } }), TypeError);
});
