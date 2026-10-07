import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildOpenApi, buildSurfaceMarkdown } from "../src/openapi.ts";
import { buildHandlers, ROUTES } from "../src/routes.ts";
import { fakeCore } from "./helpers.ts";
import { noopAudit } from "../src/audit.ts";
import { FakeClock } from "../src/clock.ts";
import { OWNER, SessionStore, ownerTokenVerifier } from "../src/session.ts";

const doc = buildOpenApi() as any;

test("every route is in the document and every operation in the document is a route", () => {
  const fromDoc: string[] = [];
  for (const [path, ops] of Object.entries<any>(doc.paths)) for (const [method, op] of Object.entries<any>(ops)) { fromDoc.push(`${method.toUpperCase()} ${path} ${op.operationId}`); }
  assert.deepEqual(fromDoc.sort(), ROUTES.map((r) => `${r.method} ${r.path} ${r.id}`).sort());
  assert.equal(new Set(ROUTES.map((r) => r.id)).size, ROUTES.length, "operation ids are unique");
});

test("every route has a handler and every handler a route", () => {
  const d = { core: fakeCore(), sessions: new SessionStore(new FakeClock()), verifyOwner: ownerTokenVerifier("x".repeat(40)), clock: new FakeClock(), tls: false, principal: OWNER, healthTimeoutMs: 10, log: { info() {}, warn() {} }, audit: noopAudit };
  assert.deepEqual(Object.keys(buildHandlers(d)).sort(), ROUTES.map((r) => r.id).sort());
});

test("the document says what the server enforces: cookie auth except login, CSRF on writes, the shared failure statuses, x-stability on every operation", () => {
  assert.equal(doc.openapi, "3.1.0");
  for (const r of ROUTES) {
    const op = doc.paths[r.path][r.method.toLowerCase()];
    assert.equal(op["x-stability"] !== undefined && op["x-since"] !== undefined, true, r.id);
    assert.deepEqual(op.security, r.auth === "session" ? [{ cookieAuth: [] }] : [], r.id);
    assert.equal(Boolean(op.parameters?.some((p: any) => p.name === "X-CSRF-Token")), r.csrf, r.id);
    for (const s of ["401", "403", "413", "421", "429", "504"]) assert.ok(op.responses[s], `${r.id} ${s}`);
    assert.ok(op.responses[String(r.successStatus)], r.id);
  }
  assert.equal(doc.components.securitySchemes.cookieAuth.in, "cookie");
  assert.equal(doc.paths["/api/v1/session"].post.requestBody.required, true);
});

test("every $ref in the document resolves", () => {
  const refs: string[] = []; JSON.stringify(doc, (_k, v) => { if (v && typeof v === "object" && typeof v.$ref === "string") refs.push(v.$ref); return v; });
  assert.ok(refs.length > 0);
  for (const r of refs) { const name = r.replace("#/components/schemas/", ""); assert.ok(doc.components.schemas[name], r); }
});

test("the checked-in docs/openapi.json and docs/api-surface.md are what the generator produces (pnpm docs:gen)", () => {
  const read = (f: string) => readFileSync(new URL(`../../../docs/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(read("openapi.json"), JSON.stringify(doc, null, 2) + "\n");
  assert.equal(read("api-surface.md"), buildSurfaceMarkdown());
});
