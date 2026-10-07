import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyResponsesHttp, classifyResponsesStreamError, parseRateLimitReset } from "../../src/responses/errors.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const body = (message: string, code: string | null, type = "invalid_request_error", extra: object = {}): string => JSON.stringify({ error: { message, type, param: null, code, ...extra } });
const http = (status: number, b: string, headers: Record<string, string> = {}) => classifyResponsesHttp(status, new Headers(headers), b, NOW, (s) => s);
const ev = (code: string | null, message = "m", type?: string) => classifyResponsesStreamError({ type: "error", code, message, param: null, ...(type ? { error_type: type } : {}) }, (s) => s);
const failed = (code: string | null, message = "m") => classifyResponsesStreamError({ error: { code, message } }, (s) => s);

test("HTTP statuses and OpenAI error codes map onto the taxonomy", () => {
  const cases: [number, string, string, string, boolean][] = [
    [401, "invalid_api_key", "auth", "auth", false],
    [403, "unsupported_country_region_territory", "auth", "auth", false],
    [429, "rate_limit_exceeded", "rate_limit", "rate_limit", true],
    [429, "insufficient_quota", "rate_limit", "rate_limit", false],
    [500, "server_error", "overloaded", "overloaded", true],
    [503, "server_is_overloaded", "overloaded", "overloaded", true],
    [400, "context_length_exceeded", "context_length", "context_length", false],
    [404, "model_not_found", "invalid_request", "invalid_request", false],
    [400, "invalid_value", "invalid_request", "invalid_request", false],
  ];
  for (const [status, code, , kind, retryable] of cases) {
    const e = http(status, body("m", code));
    assert.equal(e.kind, kind, `${status} ${code}`);
    assert.equal(e.retryable, retryable, `${status} ${code} retryable`);
    assert.equal(e.status, status);
    assert.equal(e.code, code);
  }
  assert.equal(http(400, body("Your input exceeds the context window of this model. Please adjust your input and try again.", null)).kind, "context_length");
});

test("a prompt flagged by the usage policy is a content-filter refusal, not a plain bad request", () => {
  const e = http(400, body("Invalid prompt: your prompt was flagged as potentially violating our usage policy.", "invalid_prompt"));
  assert.equal(e.kind, "invalid_request");
  assert.equal(e.contentFiltered, true);
  assert.equal(e.retryable, false);
  assert.equal(http(400, body("Invalid prompt: something else.", "invalid_prompt")).contentFiltered, false);
});

test("429: retry-after wins; else the x-ratelimit reset of the exhausted limit; else the smaller reset; else nothing", () => {
  const rl = (headers: Record<string, string>) => http(429, body("slow", "rate_limit_exceeded"), headers).retryAfterMs;
  assert.equal(rl({ "retry-after": "7", "x-ratelimit-reset-requests": "1s" }), 7_000);
  assert.equal(rl({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1s", "x-ratelimit-remaining-tokens": "500", "x-ratelimit-reset-tokens": "6m0s" }), 1_000);
  assert.equal(rl({ "x-ratelimit-remaining-requests": "10", "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "6m0s" }), 360_000);
  assert.equal(rl({ "x-ratelimit-reset-requests": "20ms", "x-ratelimit-reset-tokens": "2s" }), 20);
  assert.equal(rl({ "x-ratelimit-reset-tokens": "1h2m3.5s" }), 3_723_500);
  assert.equal(rl({ "x-ratelimit-reset-requests": "soon" }), undefined);
  assert.equal(rl({}), undefined);
  assert.equal(rl({ "x-ratelimit-reset-requests": "9999h" }), 24 * 60 * 60 * 1000, "capped at 24 h");
  assert.equal(http(500, body("x", "server_error"), { "x-ratelimit-reset-requests": "1s" }).retryAfterMs, undefined, "only a 429 reads the limit headers");
});

test("parseRateLimitReset reads Go-style durations and nothing else", () => {
  for (const [s, ms] of [["1s", 1000], ["0s", 0], ["1.5s", 1500], ["20ms", 20], ["6m0s", 360_000], ["1h", 3_600_000], ["2h1m1s", 7_261_000]] as const) assert.equal(parseRateLimitReset(s), ms, s);
  for (const s of ["", "s", "1", "1 s", "-1s", "1d", "1s2", "NaN", "1e3s", " 1s"]) assert.equal(parseRateLimitReset(s), undefined, JSON.stringify(s));
  assert.equal(parseRateLimitReset(null), undefined);
});

test("a ChatGPT-plan usage limit is a rate_limit that retrying will not fix, with the reset it reports", () => {
  const e = http(429, body("The usage limit has been reached", null, "usage_limit_reached", { plan_type: "plus", resets_in_seconds: 1234 }));
  assert.equal(e.kind, "rate_limit");
  assert.equal(e.retryable, false);
  assert.equal(e.retryAfterMs, 1_234_000);
  assert.equal(e.providerType, "usage_limit_reached");
  assert.equal(http(429, body("x", null, "usage_limit_reached", { resets_in_seconds: "soon" })).retryAfterMs, undefined);
});

test("a body that is not JSON, or a {detail} body, still classifies by status", () => {
  assert.equal(classifyResponsesHttp(502, new Headers(), "<html>bad gateway</html>", NOW, (s) => s).kind, "overloaded");
  const d = classifyResponsesHttp(401, new Headers(), JSON.stringify({ detail: "token expired" }), NOW, (s) => s);
  assert.equal(d.kind, "auth");
  assert.equal(d.providerMessage, "token expired");
});

test("provider text is redacted before it is stored", () => {
  const e = classifyResponsesHttp(401, new Headers(), body("Incorrect API key provided: sk-SECRET0123456789", "invalid_api_key"), NOW, (s) => s.split("sk-SECRET0123456789").join("[redacted]"));
  assert.equal(e.providerMessage, "Incorrect API key provided: [redacted]");
  assert.equal(e.message.includes("SECRET"), false);
});

test("error and response.failed events inside a 200 stream map onto the taxonomy", () => {
  const cases: [string, string, boolean][] = [
    ["server_error", "overloaded", true],
    ["rate_limit_exceeded", "rate_limit", true],
    ["insufficient_quota", "rate_limit", false],
    ["usage_limit_reached", "rate_limit", false],
    ["invalid_api_key", "auth", false],
    ["context_length_exceeded", "context_length", false],
    ["invalid_prompt", "invalid_request", false],
    ["invalid_image_url", "invalid_request", false],
    ["unsupported_value", "invalid_request", false],
    ["model_not_found", "invalid_request", false],
    ["some_new_code", "unknown", false],
  ];
  for (const [code, kind, retryable] of cases) {
    for (const make of [ev, failed]) {
      const e = make(code);
      assert.equal(e.kind, kind, code);
      assert.equal(e.retryable, retryable, `${code} retryable`);
      assert.equal(e.code, code);
      assert.equal(e.status, undefined, "an in-stream error has no HTTP status");
    }
  }
  assert.equal(failed("invalid_prompt", "Invalid prompt: your prompt was flagged as potentially violating our usage policy.").contentFiltered, true);
  assert.equal(failed("invalid_prompt", "nope").contentFiltered, false);
  assert.equal(failed(null, "The server is overloaded, try again.").kind, "unknown");
});

test("an in-stream error that is not the documented shape is unknown, never retried, never a crash", () => {
  for (const v of [null, "boom", 7, {}, { type: "error" }, { error: "plain" }, { error: { message: 5 } }]) {
    const e = classifyResponsesStreamError(v, (s) => s);
    assert.equal(e.kind, "unknown");
    assert.equal(e.retryable, false);
  }
});

test("in-stream provider text is redacted and bounded", () => {
  const e = classifyResponsesStreamError({ type: "error", code: "server_error", message: `leak sk-SECRET0123456789 ${"x".repeat(2000)}` }, (s) => s.split("sk-SECRET0123456789").join("[redacted]"));
  assert.ok((e.providerMessage ?? "").startsWith("leak [redacted]"));
  assert.ok((e.providerMessage ?? "").length <= 500);
  assert.equal(e.message.includes("SECRET"), false);
});
