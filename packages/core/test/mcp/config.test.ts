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
  // ADR-014 ruling 2 / audit mcp #4: trust belongs to the installation scope. An agent-scoped definition can never carry it,
  // whatever the allowlist says, and a vetted installation server does not make a same-named agent server vetted.
  it("operator-vetted is settable only in the installation scope (fail closed for an agent scope)", () => {
    const agent = { kind: "agent", agentId: "bernd" };
    assert.equal(code(() => validateDefinition({ ...stdio(), scope: agent, trust: "operator-vetted" }, policy)), "invalid-config");
    assert.equal(validateDefinition({ ...stdio(), scope: agent, trust: "untrusted" }, policy).trust, "untrusted");
    assert.equal(validateDefinition({ ...stdio(), scope: agent }, policy).trust, "untrusted");
    assert.equal(validateDefinition({ ...stdio(), scope: { kind: "installation" }, trust: "operator-vetted" }, policy).trust, "operator-vetted");
  });
});

// Audit mcp #2 (note): the allowlist names a program, not its argv. An allowlisted interpreter given inline code is
// arbitrary code, so those flags need an explicit, per-command approval (`inlineCodeCommands`).
describe("mcp stdio interpreter flags", () => {
  const interp = { allowedCommands: ["node", "python3", "sh", "/usr/bin/python3.12", "/opt/tools/server"] };
  const withArgs = (command: string, args: string[]) => stdio({ command, args });
  it("refuses inline-code flags on an allowlisted interpreter", () => {
    const cases: Array<[string, string[]]> = [
      ["node", ["-e", "process.exit(0)"]], ["node", ["--eval", "1"]], ["node", ["--eval=1"]], ["node", ["-p", "1"]], ["node", ["-pe", "1"]],
      ["node", ["--no-warnings", "-e", "1"]], ["node", ["-r", "./x.js", "-e", "1"]],
      ["python3", ["-c", "import os"]], ["python3", ["-Ic", "import os"]], ["python3", ["-cimport os"]], ["python3", ["-u", "-W", "ignore", "-c", "x"]],
      ["sh", ["-c", "id"]], ["sh", ["-lc", "id"]], ["sh", ["-ec", "id"]], ["sh", ["-o", "pipefail", "-c", "id"]],
      ["/usr/bin/python3.12", ["-c", "x"]],
    ];
    for (const [command, args] of cases) assert.equal(code(() => validateDefinition(withArgs(command, args), interp)), "not-allowed", `${command} ${args.join(" ")}`);
  });
  it("does not leak the inline code into the error", () => {
    try { validateDefinition(withArgs("node", ["-e", "SECRET-CODE-MARKER"]), interp); assert.fail("accepted"); }
    catch (e) { assert.ok(e instanceof McpClientError); assert.ok(!e.message.includes("SECRET-CODE-MARKER"), e.message); }
    try { validateDefinition(withArgs("python3", ["-cSECRET-CODE-MARKER"]), interp); assert.fail("accepted"); }
    catch (e) { assert.ok(e instanceof McpClientError); assert.ok(!e.message.includes("SECRET-CODE-MARKER"), e.message); }
  });
  it("keeps a normal script, with its own flags, allowed", () => {
    for (const [command, args] of [
      ["node", ["server.js"]], ["node", ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", "server.ts", "--port", "8080"]],
      ["node", ["server.js", "-e", "prod", "-p", "8080"]], ["node", ["--experimental-strip-types", "server.ts", "-p", "8080"]], ["node", ["--enable-source-maps", "--no-warnings", "server.js", "-e", "x"]], ["node", ["--", "-e"]],
      ["python3", ["server.py", "-c", "config.yaml"]], ["python3", ["-u", "-W", "ignore", "server.py", "-c", "cfg"]], ["python3", ["-m", "my_server", "-c", "cfg"]],
      ["sh", ["start.sh", "-c", "cfg"]], ["/opt/tools/server", ["-e", "-c"]],
    ] as Array<[string, string[]]>) assert.equal(code(() => validateDefinition(withArgs(command, args), interp)), "none", `${command} ${args.join(" ")}`);
  });
  it("allows inline code only for a command that is approved by name, not for its siblings", () => {
    const approved = { allowedCommands: ["node", "python3"], inlineCodeCommands: ["node"] };
    assert.equal(code(() => validateDefinition(withArgs("node", ["-e", "1"]), approved)), "none");
    assert.equal(code(() => validateDefinition(withArgs("python3", ["-c", "1"]), approved)), "not-allowed");
    // An approval does not widen the allowlist.
    assert.equal(code(() => validateDefinition(withArgs("node", ["-e", "1"]), { allowedCommands: [], inlineCodeCommands: ["node"] })), "not-allowed");
  });
});

it("timeouts accept only the declared names, not inherited object keys", async () => {
  for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    const raw = JSON.parse(`{"name":"x","transport":{"type":"http","url":"https://example.test/mcp"},"timeouts":{"${key}":100}}`);
    assert.throws(() => validateDefinition(raw, { allowedCommands: [] }), /unknown timeout/, key);
  }
});

describe("mcp server definition: command resolution and interpreter search paths", () => {
  it("refuses to let a server definition set PATH, PATHEXT or an interpreter's module search path", () => {
    for (const k of ["PATH", "Path", "path", "PATHEXT", "pathext", "PYTHONHOME", "PERL5LIB", "RUBYLIB"]) {
      assert.equal(code(() => validateDefinition(stdio({ env: { [k]: "/tmp/x" } }), policy)), "invalid-config", k);
    }
  });
  it("still accepts ordinary variables, so legitimate servers keep working", () => {
    const d = validateDefinition(stdio({ env: { MY_PATH_HINT: "/x", PATHS: "y", API_REGION: "eu" } }), policy);
    assert.deepEqual(d.transport.type === "stdio" ? Object.keys(d.transport.env).sort() : [], ["API_REGION", "MY_PATH_HINT", "PATHS"]);
  });
});
