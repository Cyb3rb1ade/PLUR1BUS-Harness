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

it("redacts individual lines of a declared multiline secret before stderr line logging", () => {
  const r = createRedactor(); r.add("fake-secret-line-one\nfake-secret-line-two", true);
  assert.equal(r.redact("value=fake-secret-line-one"), "value=[REDACTED]");
  assert.equal(r.redact("value=fake-secret-line-two"), "value=[REDACTED]");
});

it("values() hands the registered forms, longest first, to the D111 stderr framer (#750)", () => {
  const r = createRedactor(["fake secret value"]); r.add("short-one", true);
  const values = r.values();
  assert.ok(values.includes("fake secret value") && values.includes(encodeURIComponent("fake secret value")) && values.includes("short-one"));
  assert.deepEqual([...values], [...values].sort((a, b) => b.length - a.length));
  (values as string[]).length = 0;
  assert.equal(r.values().length, 3, "callers get a copy, not the redactor's own list");
});
