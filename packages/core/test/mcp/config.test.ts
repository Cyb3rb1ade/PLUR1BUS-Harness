import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateDefinition } from "../../src/mcp/config.ts";
import { McpClientError } from "../../src/mcp/errors.ts";

const policy = { allowedCommands: ["node", "/opt/tools/server"] };
const stdio = (over: Record<string, unknown> = {}) => ({ name: "docs", transport: { type: "stdio", command: "node", args: ["s.js"], ...over } });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof McpClientError ? e.code : `other:${String(e)}`; } return "none"; };

describe("mcp server definition", () => {
  it("normalises a stdio definition with fail-closed defaults", () => {
    const d = validateDefinition(stdio(), policy);
    assert.equal(d.scope.kind, "installation");
    assert.equal(d.trust, "untrusted");
    assert.deepEqual(d.transport, { type: "stdio", command: "node", args: ["s.js"], env: {}, fromHost: [] });
    assert.equal(d.timeouts.callMs, 60_000);
  });
  it("refuses stdio when the allowlist is empty (fail closed)", () => {
    assert.equal(code(() => validateDefinition(stdio(), { allowedCommands: [] })), "not-allowed");
  });
  it("requires an exact allowlist match for a bare name and for an absolute path", () => {
    assert.equal(code(() => validateDefinition(stdio({ command: "python3" }), policy)), "not-allowed");
    assert.equal(code(() => validateDefinition(stdio({ command: "/opt/tools/server" }), policy)), "none");
    assert.equal(code(() => validateDefinition(stdio({ command: "/opt/tools/other" }), policy)), "not-allowed");
  });
  it("rejects a command carrying arguments, a relative path or shell syntax", () => {
    for (const command of ["node s.js", "./node", "node;ls", "sh -c x", "$(node)", "../node"]) {
      assert.equal(code(() => validateDefinition(stdio({ command }), { allowedCommands: [command, "node"] })), "invalid-config", command);
    }
  });
  it("rejects loader-injection environment variables and bad names", () => {
    for (const k of ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "ld_library_path"]) {
      assert.equal(code(() => validateDefinition(stdio({ env: { [k]: "x" } }), policy)), "invalid-config", k);
    }
    assert.equal(code(() => validateDefinition(stdio({ env: { "A B": "x" } }), policy)), "invalid-config");
    assert.equal(code(() => validateDefinition(stdio({ fromHost: ["NODE_OPTIONS"] }), policy)), "invalid-config");
  });
  it("validates names and scope", () => {
    assert.equal(code(() => validateDefinition({ ...stdio(), name: "Bad Name" }, policy)), "invalid-config");
    assert.equal(code(() => validateDefinition({ ...stdio(), scope: { kind: "agent" } }, policy)), "invalid-config");
    assert.equal(code(() => validateDefinition({ ...stdio(), scope: { kind: "everyone" } }, policy)), "invalid-config");
    assert.deepEqual(validateDefinition({ ...stdio(), scope: { kind: "agent", agentId: "bernd" } }, policy).scope, { kind: "agent", agentId: "bernd" });
  });
  it("allows http only to loopback, https elsewhere, and never with URL credentials", () => {
    const http = (url: string, headers?: unknown) => ({ name: "r", transport: { type: "http", url, ...(headers ? { headers } : {}) } });
    assert.equal(code(() => validateDefinition(http("http://127.0.0.1:9/mcp"), policy)), "none");
    assert.equal(code(() => validateDefinition(http("http://localhost:9/mcp"), policy)), "none");
    assert.equal(code(() => validateDefinition(http("http://[::1]:9/mcp"), policy)), "none");
    assert.equal(code(() => validateDefinition(http("https://example.com/mcp"), policy)), "none");
    assert.equal(code(() => validateDefinition(http("http://example.com/mcp"), policy)), "invalid-config");
    assert.equal(code(() => validateDefinition(http("https://u:p@example.com/mcp"), policy)), "invalid-config");
    assert.equal(code(() => validateDefinition(http("ftp://example.com/mcp"), policy)), "invalid-config");
    assert.equal(code(() => validateDefinition(http("https://example.com/mcp", { Authorization: "a\r\nX: y" }), policy)), "invalid-config");
  });
  it("bounds timeouts", () => {
    assert.equal(code(() => validateDefinition({ ...stdio(), timeouts: { callMs: 1 } }, policy)), "invalid-config");
    assert.equal(code(() => validateDefinition({ ...stdio(), timeouts: { nope: 1000 } }, policy)), "invalid-config");
    assert.equal(validateDefinition({ ...stdio(), timeouts: { callMs: 1000 } }, policy).timeouts.callMs, 1000);
  });
  it("does not allow operator-vetted to be spelled any other way", () => {
    assert.equal(code(() => validateDefinition({ ...stdio(), trust: "trusted" }, policy)), "invalid-config");
    assert.equal(validateDefinition({ ...stdio(), trust: "operator-vetted" }, policy).trust, "operator-vetted");
  });
});
