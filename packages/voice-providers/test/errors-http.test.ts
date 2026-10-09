import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceProviderError, errorFromStatus, parseRetryAfter, redact, RETRYABLE_CODES } from "../src/errors.ts";
import { HttpClient } from "../src/http.ts";
import { assertSecureTransport } from "../src/util.ts";
import { resolveSecret } from "../src/secret.ts";
import { SENTINEL_KEY, json, startFakeVendor } from "./helpers/fake-vendor.ts";
import { toVoiceUsage } from "../src/types.ts";

test("status mapping: 401/403 auth, 429 rate_limited with Retry-After, 5xx overloaded, 4xx invalid_request, 408/504 timeout", () => {
  assert.equal(errorFromStatus(401, "p", "", null).code, "auth");
  assert.equal(errorFromStatus(403, "p", "", null).code, "auth");
  const r = errorFromStatus(429, "p", "", "12");
  assert.deepEqual([r.code, r.retryAfterMs, r.status, r.retryable], ["rate_limited", 12000, 429, true]);
  assert.equal(errorFromStatus(503, "p", "", null).code, "overloaded");
  assert.equal(errorFromStatus(529, "p", "", null).code, "overloaded");
  assert.equal(errorFromStatus(422, "p", "bad voice", null).code, "invalid_request");
  assert.equal(errorFromStatus(504, "p", "", null).code, "timeout");
  assert.equal(errorFromStatus(418, "p", "", null).code, "bad_response");
  assert.ok(!errorFromStatus(401, "p", "", null).retryable);
  assert.deepEqual([...RETRYABLE_CODES].sort(), ["network", "overloaded", "rate_limited", "timeout"]);
});

test("Retry-After accepts seconds and HTTP dates, clamps to an hour, and ignores junk", () => {
  assert.equal(parseRetryAfter("5"), 5000);
  assert.equal(parseRetryAfter("1.5"), 1500);
  assert.equal(parseRetryAfter("999999"), 3_600_000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(""), undefined);
  assert.equal(parseRetryAfter("soon"), undefined);
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.equal(parseRetryAfter("Thu, 08 Oct 2026 12:00:30 GMT", () => now), 30_000);
  assert.equal(parseRetryAfter("Thu, 08 Oct 2026 11:00:00 GMT", () => now), 0);
});

test("redaction scrubs given secrets, key query parameters, bearer tokens and key headers", () => {
  const secret = "sk-live-abcdef123456";
  assert.equal(redact(`oops ${secret} here`, [secret]), "oops [redacted] here");
  assert.match(redact("GET /ws?key=AIzaSyABCDEF123456&x=1"), /key=\[redacted\]&x=1/);
  assert.match(redact("Authorization: Bearer abcdefghijklmnop"), /Bearer \[redacted\]/);
  assert.match(redact('{"xi-api-key": "abcdefgh12345678"}'), /\[redacted\]/);
  const e = new VoiceProviderError("auth", `failed with ${secret}`, { secrets: [secret], cause: new Error(secret) });
  assert.ok(!e.message.includes(secret));
  assert.ok(!JSON.stringify(e).includes(secret));
  assert.ok(!String(e.stack).includes(secret));
});

test("transport: https/wss always, plain http/ws only to loopback, junk refused", () => {
  assert.doesNotThrow(() => assertSecureTransport("https://api.example.com/x", "p"));
  assert.doesNotThrow(() => assertSecureTransport("wss://api.example.com/x", "p"));
  assert.doesNotThrow(() => assertSecureTransport("http://127.0.0.1:1/x", "p"));
  assert.doesNotThrow(() => assertSecureTransport("ws://localhost:1/x", "p"));
  for (const bad of ["http://api.example.com/x", "ws://example.com", "ftp://x", "not a url", "http://127.0.0.1.evil.com/"]) assert.throws(() => assertSecureTransport(bad, "p"), (e) => e instanceof VoiceProviderError && e.code === "config", bad);
});

test("HttpClient retries 429/5xx up to the limit using the injected sleep, never retries 4xx, and refuses redirects", async () => {
  let n = 0;
  const v = await startFakeVendor({ http: (req, res) => {
    n++;
    if (req.url === "/flaky") { if (n < 3) json(res, 503, {}); else json(res, 200, { ok: true }); }
    else if (req.url === "/bad") json(res, 400, { detail: "no" });
    else if (req.url === "/redir") { res.writeHead(302, { location: "http://127.0.0.1:1/" }); res.end(); }
    else json(res, 200, {});
  } });
  try {
    const waits: number[] = [];
    const c = new HttpClient({ provider: "p", sleep: async (ms) => { waits.push(ms); }, retries: 2 });
    assert.deepEqual(await c.json(`${v.httpUrl}/flaky`), { ok: true });
    assert.equal(waits.length, 2);
    n = 0;
    await assert.rejects(c.json(`${v.httpUrl}/bad`), (e) => e instanceof VoiceProviderError && e.code === "invalid_request");
    assert.equal(n, 1);
    await assert.rejects(c.request(`${v.httpUrl}/redir`), (e) => e instanceof VoiceProviderError);
    const never = new HttpClient({ provider: "p", sleep: async () => {}, retries: 1 });
    n = -5;
    await assert.rejects(never.request(`${v.httpUrl}/flaky`, { signal: AbortSignal.abort() }), (e) => e instanceof VoiceProviderError && e.code === "aborted");
  } finally { await v.close(); }
});

test("a connection refusal is a network error with the secret scrubbed", async () => {
  const c = new HttpClient({ provider: "p", sleep: async () => {}, retries: 0, secrets: [SENTINEL_KEY] });
  await assert.rejects(c.request(`http://127.0.0.1:1/?key=${SENTINEL_KEY}`), (e) => e instanceof VoiceProviderError && e.code === "network" && !e.message.includes(SENTINEL_KEY));
});

test("resolveSecret drops lookup errors and rejects empty or control-character values", async () => {
  await assert.rejects(resolveSecret(async () => { throw new Error(`vault says ${SENTINEL_KEY}`); }, "r", "p"), (e) => e instanceof VoiceProviderError && e.code === "auth" && !e.message.includes(SENTINEL_KEY));
  await assert.rejects(resolveSecret(async () => "", "r", "p"), (e) => e instanceof VoiceProviderError && e.code === "auth");
  await assert.rejects(resolveSecret(async () => "bad\nkey", "r", "p"), (e) => e instanceof VoiceProviderError && e.code === "auth");
  await assert.rejects(resolveSecret(async () => "k", undefined, "p"), (e) => e instanceof VoiceProviderError && e.code === "auth");
  assert.equal(await resolveSecret(async () => "good", "r", "p"), "good");
});

test("usage maps onto core's VoiceUsage so the caller can hand it to VoiceBudgetPort.record unchanged", () => {
  assert.deepEqual(toVoiceUsage({ provider: "p", operation: "asr", seconds: 2.5 }), { seconds: 2.5, costMicros: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(toVoiceUsage({ provider: "p", operation: "realtime", inputTokens: 4, outputTokens: 9 }, 120), { seconds: 0, costMicros: 120, inputTokens: 4, outputTokens: 9 });
});
