import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAnthropicHttp, classifyAnthropicStreamError } from "../../src/anthropic/errors.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const body = (type: string, message: string): string => JSON.stringify({ type: "error", error: { type, message }, request_id: "req_synthetic" });
const http = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  classifyAnthropicHttp(status, new Headers(headers), body(type, message), NOW, (s) => s);
const frame = (type: string, message = "m") => classifyAnthropicStreamError({ type: "error", error: { type, message } }, (s) => s);

test("HTTP statuses map onto the taxonomy", () => {
  const cases: [number, string, string, string, boolean][] = [
    [401, "authentication_error", "invalid x-api-key", "auth", false],
    [403, "permission_error", "not allowed", "auth", false],
    [402, "billing_error", "billing", "auth", false],
    [400, "invalid_request_error", "messages: field required", "invalid_request", false],
    [404, "not_found_error", "model: nope", "invalid_request", false],
    [413, "request_too_large", "Request exceeds the maximum allowed number of bytes.", "invalid_request", false],
    [429, "rate_limit_error", "slow down", "rate_limit", true],
    [500, "api_error", "internal", "overloaded", true],
    [504, "api_error", "gateway", "overloaded", true],
    [529, "overloaded_error", "Overloaded", "overloaded", true],
  ];
  for (const [status, type, message, kind, retryable] of cases) {
    const e = http(status, type, message);
    assert.equal(e.kind, kind, `${status} ${type}`);
    assert.equal(e.retryable, retryable, `${status} retryable`);
    assert.equal(e.status, status);
    assert.equal(e.providerType, type);
    assert.equal(e.providerMessage, message);
  }
});

test("429 keeps retry-after (seconds and HTTP-date) as retryAfterMs", () => {
  assert.equal(http(429, "rate_limit_error", "x", { "retry-after": "7" }).retryAfterMs, 7_000);
  assert.equal(http(429, "rate_limit_error", "x", { "retry-after": "Wed, 07 Oct 2026 12:00:30 GMT" }).retryAfterMs, 30_000);
  assert.equal(http(429, "rate_limit_error", "x").retryAfterMs, undefined);
  assert.equal(http(529, "overloaded_error", "x", { "retry-after": "3" }).retryAfterMs, 3_000);
});

test("a prompt that is too long is context_length, not a plain invalid_request", () => {
  for (const m of [
    "prompt is too long: 215000 tokens > 200000 maximum",
    "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000, decrease input length or `max_tokens` and try again",
  ]) {
    const e = http(400, "invalid_request_error", m);
    assert.equal(e.kind, "context_length", m);
    assert.equal(e.retryable, false);
    assert.equal(e.status, 400);
    assert.equal(e.providerType, "invalid_request_error");
  }
});

test("Anthropic reports an empty credit balance as a 400: that is an auth/billing problem, not a malformed request", () => {
  const e = http(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
  assert.equal(e.kind, "auth");
  assert.equal(e.retryable, false);
  assert.equal(e.status, 400);
});

test("a body that is not JSON still classifies by status", () => {
  const e = classifyAnthropicHttp(529, new Headers(), "<html>overloaded</html>", NOW, (s) => s);
  assert.equal(e.kind, "overloaded");
  assert.equal(e.code, undefined);
});

test("provider text is redacted before it is stored", () => {
  const e = classifyAnthropicHttp(401, new Headers(), body("authentication_error", "bad key sk-ant-SECRET0123456789"), NOW, (s) => s.split("sk-ant-SECRET0123456789").join("[redacted]"));
  assert.equal(e.providerMessage, "bad key [redacted]");
  assert.equal(e.message.includes("SECRET"), false);
});

test("error events inside a 200 stream map onto the taxonomy", () => {
  const cases: [string, string, boolean][] = [
    ["overloaded_error", "overloaded", true],
    ["api_error", "overloaded", true],
    ["rate_limit_error", "rate_limit", true],
    ["authentication_error", "auth", false],
    ["permission_error", "auth", false],
    ["billing_error", "auth", false],
    ["invalid_request_error", "invalid_request", false],
    ["not_found_error", "invalid_request", false],
    ["request_too_large", "invalid_request", false],
    ["something_new_error", "unknown", false],
  ];
  for (const [type, kind, retryable] of cases) {
    const e = frame(type);
    assert.equal(e.kind, kind, type);
    assert.equal(e.retryable, retryable, `${type} retryable`);
    assert.equal(e.providerType, type);
    assert.equal(e.status, undefined, "an in-stream error has no HTTP status");
  }
  assert.equal(frame("invalid_request_error", "prompt is too long: 215000 tokens > 200000 maximum").kind, "context_length");
  assert.equal(frame("invalid_request_error", "Your credit balance is too low").kind, "auth");
});

test("an in-stream error that is not the documented shape is unknown, never retried, never a crash", () => {
  for (const v of [null, "boom", 7, {}, { type: "error" }, { type: "error", error: "plain text" }, { type: "error", error: { message: 5 } }]) {
    const e = classifyAnthropicStreamError(v, (s) => s);
    assert.equal(e.kind, "unknown");
    assert.equal(e.retryable, false);
  }
});

test("in-stream provider text is redacted and bounded", () => {
  const e = classifyAnthropicStreamError({ type: "error", error: { type: "api_error", message: `leak sk-ant-SECRET0123456789 ${"x".repeat(2000)}` } }, (s) => s.split("sk-ant-SECRET0123456789").join("[redacted]"));
  assert.ok((e.providerMessage ?? "").startsWith("leak [redacted]"));
  assert.ok((e.providerMessage ?? "").length <= 500);
  assert.equal(e.message.includes("SECRET"), false);
});
