import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../src/index.ts";
import { startStub } from "../helpers/stub.ts";
import { T, adapterFor, basic, geminiError, json } from "./helpers.ts";

async function failing(status: number, body: unknown, headers: Record<string, string> = {}): Promise<ProviderError> {
  const stub = await startStub((_q, res) => json(res, body, status, headers));
  try {
    const e = await adapterFor(stub).adapter.complete(basic).then(() => undefined, (x: unknown) => x);
    assert.ok(e instanceof ProviderError, `expected a ProviderError, got ${String(e)}`);
    return e;
  } finally { await stub.close(); }
}

test("429 RESOURCE_EXHAUSTED: rate_limit, retryable, delay from RetryInfo", T, async () => {
  const e = await failing(429, geminiError(429, "RESOURCE_EXHAUSTED", "Quota exceeded for requests per minute.", [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34.5s" },
  ]));
  assert.equal(e.kind, "rate_limit");
  assert.equal(e.status, 429);
  assert.equal(e.retryable, true);
  assert.equal(e.retryAfterMs, 34_500);
  assert.equal(e.providerType, "RESOURCE_EXHAUSTED");
  assert.match(e.message, /Quota exceeded/);
});

test("429 with a Retry-After header: the header wins over RetryInfo; no delay at all stays undefined; odd delays are ignored", T, async () => {
  const body = (retryDelay: string) => geminiError(429, "RESOURCE_EXHAUSTED", "slow", [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }]);
  assert.equal((await failing(429, body("10s"), { "retry-after": "2" })).retryAfterMs, 2000);
  assert.equal((await failing(429, geminiError(429, "RESOURCE_EXHAUSTED", "slow"))).retryAfterMs, undefined);
  for (const odd of ["soon", "-5s", "1e9s", "5m", ""]) assert.equal((await failing(429, body(odd))).retryAfterMs, undefined, odd);
  assert.equal((await failing(429, body("999999999s"))).retryAfterMs, 24 * 60 * 60 * 1000);
});

test("a wrong key is answered 400 INVALID_ARGUMENT / API_KEY_INVALID by Gemini: classified auth, not bad_request", T, async () => {
  const e = await failing(400, geminiError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [
    { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" },
  ]));
  assert.equal(e.kind, "auth");
  assert.equal(e.status, 400);
  assert.equal(e.code, "API_KEY_INVALID");
  assert.equal(e.retryable, false);
});

test("401/403 auth, 400 token limit is context_length, other 400/404 bad_request, 5xx server (retryable), 3xx protocol", T, async () => {
  assert.equal((await failing(403, geminiError(403, "PERMISSION_DENIED", "denied"))).kind, "auth");
  assert.equal((await failing(401, geminiError(401, "UNAUTHENTICATED", "no"))).kind, "auth");
  const ctx = await failing(400, geminiError(400, "INVALID_ARGUMENT", "The input token count (2000000) exceeds the maximum number of tokens allowed (1048576)."));
  assert.equal(ctx.kind, "context_length");
  assert.equal(ctx.retryable, false);
  assert.equal((await failing(400, geminiError(400, "INVALID_ARGUMENT", "Unknown name \"foo\""))).kind, "bad_request");
  assert.equal((await failing(404, geminiError(404, "NOT_FOUND", "models/x is not found for API version v1beta"))).kind, "bad_request");
  for (const [s, st] of [[500, "INTERNAL"], [503, "UNAVAILABLE"], [504, "DEADLINE_EXCEEDED"]] as const) {
    const e = await failing(s, geminiError(s, st, "try later"));
    assert.equal(e.kind, "server", String(s));
    assert.equal(e.retryable, true);
  }
  const redirect = await failing(302, "", { location: "https://example.invalid/steal" });
  assert.equal(redirect.kind, "protocol");
});

test("non-JSON and empty error bodies are still classified by status", T, async () => {
  const stub = await startStub((_q, res) => { res.writeHead(502, { "content-type": "text/html" }); res.end("<html>Bad gateway</html>"); });
  try {
    await assert.rejects(adapterFor(stub).adapter.complete(basic), (e: unknown) => e instanceof ProviderError && e.kind === "server" && e.status === 502);
  } finally { await stub.close(); }
});
