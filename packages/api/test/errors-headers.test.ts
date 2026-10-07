import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_CODES } from "@plur1bus/rpc-schema";
import { ApiError, errorBody, errors, fromCoreError, statusOfCode } from "../src/errors.ts";
import { CSP, securityHeaders } from "../src/headers.ts";
import { redactFields, REDACTED } from "../src/redact.ts";

test("error/1 body: schema id, closed error code, message, optional reason", () => {
  assert.deepEqual(errorBody(errors.unauthenticated()), { schema: "error/1", error: "E_UNAUTHORIZED", message: "authentication required", reason: "no-session" });
  assert.deepEqual(errorBody(new ApiError(500, "E_INTERNAL", "x")), { schema: "error/1", error: "E_INTERNAL", message: "x" });
  assert.throws(() => new ApiError(400, "E_MADE_UP" as never, "x"));
});

test("every HTTP-layer error uses a member of the closed enum and a status matching its class", () => {
  const all = [errors.unauthenticated(), errors.forbidden("csrf"), errors.notFound(), errors.methodNotAllowed(["GET"]), errors.badRequest("r", "m"), errors.unsupportedMedia(), errors.tooLarge(1), errors.rateLimited(3), errors.timeout(), errors.misdirected(), errors.internal()];
  for (const e of all) assert.ok(ERROR_CODES.includes(e.error), e.error);
  assert.deepEqual(all.map((e) => e.status), [401, 403, 404, 405, 400, 415, 413, 429, 504, 421, 500]);
  assert.equal(errors.rateLimited(3).headers["Retry-After"], "3");
  assert.equal(errors.methodNotAllowed(["GET", "POST"]).headers.Allow, "GET, POST");
});

test("every ErrorCode maps to an HTTP status", () => {
  for (const c of ERROR_CODES) assert.ok(statusOfCode(c) >= 400, c);
});

test("a core error keeps its code; a core fault or refusal of the API's own credentials is a bad gateway; anything else is unreachable", () => {
  const rpc = (error: string, message: string, reason?: string) => Object.assign(new Error(message), { error, ...(reason ? { reason } : {}) });
  const nf = fromCoreError(rpc("E_AGENT_UNKNOWN", "unknown agent", "x")); assert.deepEqual([nf.status, nf.error, nf.reason], [404, "E_AGENT_UNKNOWN", "x"]);
  const internal = fromCoreError(rpc("E_INTERNAL", "stack at /home/me/secret.ts:1")); assert.deepEqual([internal.status, internal.error, internal.message], [502, "E_CORE_UNAVAILABLE", "the core failed to answer"]);
  assert.equal(fromCoreError(rpc("E_UNAUTHORIZED", "bad token")).status, 502);
  assert.equal(fromCoreError(new Error("ECONNREFUSED")).status, 503);
  assert.equal(fromCoreError("boom").error, "E_CORE_UNAVAILABLE");
  const own = errors.forbidden("x"); assert.equal(fromCoreError(own), own);
});

test("CSP forbids scripts, framing, base and forms; HSTS only with TLS", () => {
  assert.ok(!/unsafe-inline|unsafe-eval|script-src/.test(CSP));
  assert.match(CSP, /default-src 'none'/); assert.match(CSP, /frame-ancestors 'none'/);
  const plain = securityHeaders(false); const tls = securityHeaders(true);
  assert.equal(plain["Content-Security-Policy"], CSP);
  assert.equal(plain["X-Content-Type-Options"], "nosniff");
  assert.equal(plain["Strict-Transport-Security"], undefined);
  assert.match(tls["Strict-Transport-Security"]!, /max-age=\d+/);
});

test("redactFields replaces fields named like credentials, recursively", () => {
  const out = redactFields({ route: "x", ownerToken: "T", headers: { cookie: "c", accept: "a" }, list: [{ csrfToken: "z" }], Authorization: "b", n: 1 });
  assert.deepEqual(out, { route: "x", ownerToken: REDACTED, headers: { cookie: REDACTED, accept: "a" }, list: [{ csrfToken: REDACTED }], Authorization: REDACTED, n: 1 });
});
