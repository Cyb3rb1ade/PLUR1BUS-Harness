import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as index from "../src/index.ts";
import * as audit from "../src/audit.ts";
import * as clock from "../src/clock.ts";
import * as errors from "../src/errors.ts";
import * as headers from "../src/headers.ts";
import * as login from "../src/login.ts";
import * as memoryStores from "../src/memory-stores.ts";
import * as password from "../src/password.ts";
import * as rateLimit from "../src/rate-limit.ts";
import * as redact from "../src/redact.ts";
import * as routes from "../src/routes.ts";
import * as server from "../src/server.ts";
import * as session from "../src/session.ts";
import * as notices from "../src/notices.ts";
import * as auditQueue from "../src/audit-queue.ts";
import * as staticFiles from "../src/static.ts";
import * as challenge from "../src/challenge.ts";
import * as tokens from "../src/tokens.ts";
import * as totp from "../src/totp.ts";
import * as openapi from "../src/openapi.ts";
import * as ownerToken from "../src/owner-token.ts";
import * as coreLink from "../src/core-link.ts";

const sources: Record<string, Record<string, unknown>> = {
  audit, clock, errors, headers, login, memoryStores, password, rateLimit, redact, routes, server, session, notices, auditQueue, staticFiles, challenge, tokens, totp, openapi, ownerToken, coreLink,
};

describe("index barrel", () => {
  for (const [name, mod] of Object.entries(sources)) {
    it(`re-exports every runtime export of ${name}, by identity`, () => {
      const names = Object.keys(mod);
      assert.ok(names.length > 0, name);
      for (const n of names) {
        assert.ok(n in index, `${name}.${n} is missing from the barrel`);
        assert.equal((index as Record<string, unknown>)[n], mod[n], `${name}.${n} differs`);
      }
    });
  }

  it("exposes the public entry points", () => {
    for (const n of ["createApiServer", "createCoreLink", "ensureOwnerToken", "ROUTES", "buildOpenApi", "SessionStore", "RateLimiter", "TokenService", "TotpService", "PasswordLogin", "ApiError"]) {
      assert.ok(n in index, n);
    }
    assert.equal(typeof index.createApiServer, "function");
    assert.equal(typeof index.createCoreLink, "function");
    assert.equal(typeof index.ensureOwnerToken, "function");
    assert.ok(Array.isArray(index.ROUTES));
  });

  it("has no export that is undefined and no default export", () => {
    const ns = index as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(ns)) assert.notEqual(v, undefined, k);
    assert.equal("default" in ns, false);
  });

  it("importing it again gives the same module (no state per import) and starts no server", async () => {
    const again = await import("../src/index.ts");
    assert.equal(again, index);
    assert.equal(typeof index.DEFAULT_LIMITS.maxConnections, "number");
  });
});
