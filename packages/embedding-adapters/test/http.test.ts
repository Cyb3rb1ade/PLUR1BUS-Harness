import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter, postJson, statusToKind, type PostJsonRequest } from "../src/http.ts";
import { AdapterError } from "../src/errors.ts";
import { fixtureFetch, type StepSource } from "./helpers/fixture-fetch.ts";

const SECRET = "sk-test-secret-0123456789";

function req(overrides: Partial<PostJsonRequest> = {}): PostJsonRequest {
  return {
    provider: "test",
    url: "https://api.example.test/v1/embeddings",
    headers: { authorization: `Bearer ${SECRET}` },
    body: { input: ["a"] },
    timeoutMs: 1000,
    maxResponseBytes: 1024 * 1024,
    secrets: [SECRET],
    ...overrides,
  };
}

async function failure(source: StepSource, overrides: Partial<PostJsonRequest> = {}): Promise<AdapterError> {
  const { fetch } = fixtureFetch(source);
  try {
    await postJson(req(overrides), { fetch });
  } catch (e) {
    assert.ok(e instanceof AdapterError, `expected AdapterError, got ${String(e)}`);
    return e;
  }
  assert.fail("expected postJson to throw");
}

test("sends a JSON POST without following redirects and returns the parsed body", async () => {
  const { fetch, requests } = fixtureFetch({ status: 200, json: { ok: true } });
  const out = await postJson(req(), { fetch });
  assert.deepEqual(out, { ok: true });
  assert.equal(requests.length, 1);
  const r = requests[0]!;
  assert.equal(r.method, "POST");
  assert.equal(r.url, "https://api.example.test/v1/embeddings");
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(r.headers["accept"], "application/json");
  assert.equal(r.headers["authorization"], `Bearer ${SECRET}`);
  assert.deepEqual(r.body, { input: ["a"] });
  assert.equal(r.redirect, "manual");
  assert.equal(r.hasSignal, true);
});

test("HTTP status maps to the taxonomy", () => {
  const table: [number, string, string][] = [
    [401, "", "auth"], [403, "", "auth"], [408, "", "timeout"], [413, "", "too_large"], [429, "", "rate_limit"],
    [500, "", "overloaded"], [502, "", "overloaded"], [503, "", "overloaded"], [504, "", "overloaded"], [529, "", "overloaded"],
    [400, "bad model", "invalid_request"], [404, "", "invalid_request"], [422, "", "invalid_request"], [409, "", "invalid_request"],
    [400, "This model's maximum context length is 8192 tokens", "too_large"],
    [422, "input too long", "too_large"],
    [302, "", "bad_response"],
  ];
  for (const [status, body, kind] of table) assert.equal(statusToKind(status, body), kind, `${status} ${body}`);
});

test("a failing status becomes an AdapterError with status and provider, and the body snippet is scrubbed", async () => {
  const e = await failure({ status: 401, json: { error: { message: `Incorrect API key provided: ${SECRET}` } } });
  assert.equal(e.kind, "auth");
  assert.equal(e.status, 401);
  assert.equal(e.provider, "test");
  assert.equal(e.message.includes(SECRET), false);
  assert.match(e.message, /401/);
});

test("429 carries retryAfterMs from Retry-After (seconds)", async () => {
  const e = await failure({ status: 429, headers: { "retry-after": "2" }, json: { error: "slow" } });
  assert.equal(e.kind, "rate_limit");
  assert.equal(e.retryAfterMs, 2000);
  assert.equal(e.retryable, true);
});

test("parseRetryAfter understands seconds, milliseconds header values, http dates and rejects junk", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  assert.equal(parseRetryAfter("3", now), 3000);
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter("Wed, 07 Oct 2026 12:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Wed, 07 Oct 2026 11:59:00 GMT", now), 0);
  assert.equal(parseRetryAfter("-4", now), undefined);
  assert.equal(parseRetryAfter("soon", now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
  assert.equal(parseRetryAfter("1e9", now), undefined);
});

test("retry-after-ms is honoured when Retry-After is absent", async () => {
  const e = await failure({ status: 429, headers: { "retry-after-ms": "750" }, json: {} });
  assert.equal(e.retryAfterMs, 750);
});

test("a connection failure is a network error that does not leak the secret", async () => {
  const e = await failure({ throws: `ECONNREFUSED while sending ${SECRET}` });
  assert.equal(e.kind, "network");
  assert.equal(e.message.includes(SECRET), false);
});

test("the per-attempt deadline is a timeout", async () => {
  const e = await failure({ hang: true }, { timeoutMs: 25 });
  assert.equal(e.kind, "timeout");
  assert.equal(e.retryable, true);
});

test("the deadline also covers reading the body", async () => {
  const e = await failure({ bodyHang: true }, { timeoutMs: 25 });
  assert.equal(e.kind, "timeout");
});

test("the caller's signal is an abort, not a timeout", async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 15);
  const e = await failure({ hang: true }, { timeoutMs: 5000, signal: ctrl.signal });
  assert.equal(e.kind, "aborted");
  assert.equal(e.retryable, false);
});

test("an already aborted signal never reaches fetch", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const { fetch, requests } = fixtureFetch({ status: 200, json: {} });
  await assert.rejects(postJson(req({ signal: ctrl.signal }), { fetch }), (e: unknown) => e instanceof AdapterError && e.kind === "aborted");
  assert.equal(requests.length, 0);
});

test("a redirect is refused, never followed, and its location is scrubbed", async () => {
  const { fetch, requests } = fixtureFetch({ status: 307, headers: { location: `https://evil.example/collect?key=${SECRET}&x=1` } });
  await assert.rejects(postJson(req(), { fetch }), (e: unknown) => {
    assert.ok(e instanceof AdapterError);
    assert.equal(e.kind, "bad_response");
    assert.match(e.message, /redirect/i);
    assert.equal(e.message.includes(SECRET), false);
    return true;
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.redirect, "manual");
});

test("a declared content-length over the limit is refused before reading", async () => {
  const cancelled = { value: false };
  const e = await failure({ status: 200, headers: { "content-length": "999999" }, text: "{}", cancelled }, { maxResponseBytes: 1000 });
  assert.equal(e.kind, "bad_response");
  assert.match(e.message, /too large|limit/i);
  assert.equal(cancelled.value, true);
});

test("an endless body is cut off at the limit and the stream is cancelled", async () => {
  const cancelled = { value: false };
  const e = await failure({ endless: true, cancelled }, { maxResponseBytes: 100_000 });
  assert.equal(e.kind, "bad_response");
  assert.equal(cancelled.value, true);
});

test("invalid JSON and empty success bodies are bad responses", async () => {
  assert.equal((await failure({ status: 200, text: "<html>nope</html>" })).kind, "bad_response");
  assert.equal((await failure({ status: 200, text: "" })).kind, "bad_response");
  assert.equal((await failure({ status: 204 })).kind, "bad_response");
});

test("a header value with a line break is refused before any request", async () => {
  const { fetch, requests } = fixtureFetch({ status: 200, json: {} });
  await assert.rejects(postJson(req({ headers: { authorization: "Bearer a\r\nx-evil: 1" } }), { fetch }), (e: unknown) => e instanceof AdapterError && e.kind === "invalid_request");
  assert.equal(requests.length, 0);
});
