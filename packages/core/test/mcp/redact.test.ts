import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRedactor, REDACTED, isSensitiveName } from "../../src/mcp/redact.ts";
import { buildChildEnv } from "../../src/mcp/env.ts";

describe("mcp redaction", () => {
  it("removes every occurrence, longest secret first, plus the URL-encoded form", () => {
    const r = createRedactor(["hunter2-long", "hunter2"]);
    assert.equal(r.redact("a hunter2-long b hunter2 c"), `a ${REDACTED} b ${REDACTED} c`);
    assert.equal(createRedactor(["p@ss word"]).redact("x p%40ss%20word y"), `x ${REDACTED} y`);
  });
  it("ignores values too short to redact without shredding logs", () => {
    assert.equal(createRedactor(["abc"]).redact("abc abc"), "abc abc");
  });
  it("knows sensitive names", () => {
    for (const n of ["API_KEY", "GITHUB_TOKEN", "Authorization", "db_password", "SESSION_ID"]) assert.ok(isSensitiveName(n), n);
    assert.ok(!isSensitiveName("LOG_LEVEL"));
  });
  it("buildChildEnv passes declared variables only, flags secrets, reports missing fromHost", () => {
    const e = buildChildEnv({ type: "stdio", command: "node", args: [], env: { LOG_LEVEL: "debug", API_KEY: "k-123456" }, fromHost: ["FROM_HOST", "ABSENT"] }, { FROM_HOST: "host-secret-1", UNRELATED: "no" });
    assert.deepEqual(e.env, { LOG_LEVEL: "debug", API_KEY: "k-123456", FROM_HOST: "host-secret-1" });
    assert.deepEqual(e.names, ["API_KEY", "FROM_HOST", "LOG_LEVEL"]);
    assert.deepEqual(e.secrets.sort(), ["host-secret-1", "k-123456"]);
    assert.deepEqual(e.missing, ["ABSENT"]);
  });
});
