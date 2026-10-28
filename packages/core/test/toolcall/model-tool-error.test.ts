/** N1 model-bound failure redaction, diagnostic classification and log-path invariance. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { modelToolError } from "../../src/toolcall/model-tool-error.ts";
import { ToolDispatcher, type ToolFailure, type ToolResult } from "../../src/tools/dispatcher.ts";
import { ToolRegistry, type ToolDef } from "../../src/tools/registry.ts";
import { FsFailure } from "../../src/tools/fs/failure.ts";
import { createWriter } from "../../src/logs/writer.ts";

const CTX = {
  agentId: "agent", principal: "owner", surface: 3 as const, signal: new AbortController().signal,
};
const TOOL: ToolDef = {
  name: "demo.read", description: "Read a fixture", inputSchema: { type: "object" },
  capability: "sys.read", effect: "read", risk: "low", trust: "first-party", execute: async () => null,
};
const GRANTS = { list: () => [], get: () => undefined };
const failure = (error: ToolFailure["error"]): ToolFailure => ({
  callId: "call", tool: "demo.read", isError: true, error,
  provenance: {
    origin: { system: "tool:demo.read", agent: "agent", principal: "owner", trust: "first-party" },
    hops: 1, transformedBy: [],
  },
  meta: { decision: "allow", durationMs: 0, bytes: 0 },
});

async function dispatched(source: string, path: string): Promise<ToolFailure> {
  const registry = new ToolRegistry();
  const text = `cannot open ${path}\n    at privateStack (${path}:4:2)`;
  const net = { capability: "net.submit", effect: "external", risk: "medium" } as const;
  registry.register({
    ...TOOL, ...(source === "approval" || source === "denial" ? net : {}),
    ...(source === "classify" ? { classify() { throw new Error(text); } } : {}),
    execute: async () => { throw new Error(text); },
  });
  const dispatcher = new ToolDispatcher({
    registry, grants: GRANTS, clock: { now: () => 1 },
    approvals: { async request() {
      if (source === "approval") throw new Error(text);
      return { approved: false, reason: text };
    } },
    ...(source === "audit" ? { audit: { record() { throw new Error(text); } } } : {}),
  });
  const request = source === "internal"
    ? { id: "call", name: "demo.read", get args() { throw new Error(text); } }
    : { id: "call", name: "demo.read", args: {} };
  const result = await dispatcher.call(request, CTX);
  assert.ok(result.isError);
  return result;
}

const PATHS = [
  ["/home/alice/project/report.txt", "/home/<user>/project/report.txt"],
  ["/var/home/alice/project/report.txt", "/var/home/<user>/project/report.txt"],
  ["/Users/alice/project/report.txt", "/Users/<user>/project/report.txt"],
  [String.raw`C:\Users\alice\project\report.txt`, String.raw`C:\Users\<user>\project\report.txt`],
  ["C:/Users/alice/project/report.txt", "C:/Users/<user>/project/report.txt"],
  [String.raw`\\?\C:\Users\alice\project\report.txt`, String.raw`\\?\C:\Users\<user>\project\report.txt`],
  ["/mnt/c/Users/alice/project/report.txt", "/mnt/c/Users/<user>/project/report.txt"],
] as const;

describe("N1 modelToolError", () => {
  for (const [path, sanitized] of PATHS) {
    it(`hides the username in ${path} without removing useful path segments`, () => {
      const original = failure({ code: "tool-failed", message: `cannot read ${path}\n    at leakedStack (${path}:1:2)` });
      const result = modelToolError(original, [], { home: "/srv/operator", platform: "linux" });
      assert.equal(result.error.message, `cannot read ${sanitized}`);
      assert.equal(result.error.code, "tool-failed");
      assert.equal(original.error.message, `cannot read ${path}\n    at leakedStack (${path}:1:2)`);
      assert.ok(!JSON.stringify(result).includes("alice"));
      assert.ok(!JSON.stringify(result).includes("leakedStack"));
    });
  }

  it("replaces the injected home and its realpath only at directory boundaries", () => {
    const original = failure({
      code: "tool-denied", message: "/srv/alice/home/a /private/alice/home/b /srv/alice/homestead/c alice",
    });
    const result = modelToolError(original, [], { home: "/srv/alice/home", realHome: "/private/alice/home" });
    assert.equal(result.error.message, "~/a ~/b /srv/alice/homestead/c alice");
  });

  it("replaces the process home by default", () => {
    const result = modelToolError(failure({ code: "tool-failed", message: `cannot read ${homedir()}/report.txt` }));
    assert.equal(result.error.message, "cannot read ~/report.txt");
  });

  it("matches injected homes case-insensitively on Darwin and Windows", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const result = modelToolError(failure({ code: "tool-failed", message: "/srv/ALICE/home/report.txt" }), [], {
        home: "/srv/alice/home", platform,
      });
      assert.equal(result.error.message, "~/report.txt");
    }
    const result = modelToolError(failure({ code: "tool-failed", message: "/srv/ALICE/home/report.txt" }), [], {
      home: "/srv/alice/home", platform: "linux",
    });
    assert.equal(result.error.message, "/srv/ALICE/home/report.txt");
  });

  it("replaces a Windows home including the extended-path prefix", () => {
    const result = modelToolError(failure({
      code: "tool-failed", message: String.raw`cannot read \\?\C:\Users\Alice\project\report.txt`,
    }), [], { home: String.raw`C:\Users\Alice`, platform: "win32" });
    assert.equal(result.error.message, String.raw`cannot read ~\project\report.txt`);
  });

  it("redacts secrets and credential paths before sanitizing ordinary home paths", () => {
    const secret = "known-secret-12345";
    const result = modelToolError(failure({
      code: "tool-failed", message: `cannot open /home/alice/.ssh/id_ed25519 with ${secret}\nprivate stack`,
    }), [secret], { home: "/home/alice" });
    assert.match(result.error.message, /^cannot open <deny:ssh>\/…#[0-9a-f]{6} with \[REDACTED:secret\]$/);
  });

  it("bounds thrown tool messages at 300 characters and only retains valid source codes", () => {
    for (const sourceCode of ["not-found", "fs.io_error", "ENOENT", "/home/alice/private", "x".repeat(65)]) {
      const result = modelToolError(failure({ code: "tool-failed", message: "!".repeat(400), sourceCode }));
      assert.equal(result.error.message.length, 300);
      assert.equal(result.error.sourceCode, ["not-found", "fs.io_error"].includes(sourceCode) ? sourceCode : undefined);
    }
  });

  it("sanitizes every typed-error string while retaining issues, hints and rule names", () => {
    const original = failure({
      code: "tool-call-invalid", message: "invalid /home/alice/report.txt", hint: "try /Users/alice/report.txt",
      issues: [{
        path: "/home/alice/report.txt", expected: "file C:/Users/alice/report.txt", got: "secret-value-12345",
        message: String.raw`check C:\Users\alice\report.txt`,
      }],
    });
    const result = modelToolError(original, ["secret-value-12345"], { home: "/srv/operator" });
    assert.equal(result.error.code, "tool-call-invalid");
    assert.equal(result.error.hint, "try /Users/<user>/report.txt");
    assert.deepEqual(result.error.issues, [{
      path: "/home/<user>/report.txt", expected: "file C:/Users/<user>/report.txt", got: "[REDACTED:secret]",
      message: String.raw`check C:\Users\<user>\report.txt`,
    }]);
    assert.deepEqual(modelToolError(failure({ code: "tool-denied", message: "refused by policy (policy-never: deny-list)" })).error,
      { code: "tool-denied", message: "refused by policy (policy-never: deny-list)" });
  });

  it("sanitizes envelope strings as well as error details without mutating the original", () => {
    const original = failure({ code: "tool-denied", message: "no" });
    original.callId = "/home/alice/call";
    original.provenance.origin.principal = "/home/alice/person";
    original.provenance.transformedBy = ["/home/alice/transform"];
    const result = modelToolError(original, [], { home: "/srv/operator" });
    assert.equal(result.callId, "/home/<user>/call");
    assert.equal(result.provenance.origin.principal, "/home/<user>/person");
    assert.deepEqual(result.provenance.transformedBy, ["/home/<user>/transform"]);
    assert.equal(original.provenance.origin.principal, "/home/alice/person");
  });

  it("bounds the complete model envelope when validation details are oversized", () => {
    const original = failure({ code: "tool-call-invalid", message: "invalid", issues: Array.from({ length: 500 }, () => ({
      path: "/home/alice/x", expected: "!".repeat(500), got: "!".repeat(500), message: "!".repeat(500),
    })) });
    const result = modelToolError(original);
    assert.ok(JSON.stringify(result).length <= 4096);
    assert.equal(result.error.code, "tool-call-invalid");
    assert.ok(result.provenance);
    assert.ok(result.meta);
  });

  const SOURCES = [
    ["tool", "tool-failed", undefined],
    ["classify", "tool-denied", "The tool call could not be classified safely."],
    ["approval", "tool-not-approved", "The approval service is unavailable; the tool did not run."],
    ["internal", "tool-failed", "The tool call failed because of an internal error."],
    ["audit", "tool-denied", "The audit trail is unavailable; the tool did not run."],
    ["denial", "tool-not-approved", undefined],
  ] as const;
  for (const [source, code, fixedText] of SOURCES) {
    it(`sanitizes ${source} failures across all username-path forms and an injected home`, async () => {
      for (const path of [...PATHS.map(([path]) => path), "/srv/alice/home/report.txt"]) {
        const raw = await dispatched(source, path);
        const original = structuredClone(raw);
        const result = modelToolError(raw, [], { home: "/srv/alice/home" });
        const serialized = JSON.stringify(result);
        assert.equal(result.error.code, code);
        assert.ok(!serialized.includes("alice"), serialized);
        assert.ok(!serialized.includes("privateStack"), serialized);
        assert.ok(!serialized.includes("/srv/alice/home"), serialized);
        assert.equal(result.error.internalFailure, undefined);
        if (fixedText) assert.equal(result.error.message, fixedText);
        assert.deepEqual(raw, original);
      }
    });
  }

  it("does not interpret a person's approval-failed denial as a port exception", () => {
    const result = modelToolError(failure({
      code: "tool-not-approved", message: "not approved: approval failed: keep /home/alice/private.txt private",
    }), [], { home: "/srv/operator" });
    assert.equal(result.error.message, "not approved: approval failed: keep /home/<user>/private.txt private");
  });

  it("sanitizes a real ENOENT under an injected temporary home", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1b-n1-error-"));
    const home = join(root, "alice");
    try {
      await mkdir(home);
      const registry = new ToolRegistry();
      registry.register({ ...TOOL, execute: async () => readFile(join(home, "report.txt"), "utf8") });
      const dispatcher = new ToolDispatcher({ registry, grants: GRANTS, clock: { now: () => 1 },
        approvals: { request: async () => ({ approved: false }) } });
      const raw = await dispatcher.call({ id: "enoent", name: TOOL.name, args: {} }, CTX);
      assert.ok(raw.isError);
      assert.ok(raw.error.message.includes(home));
      const result = modelToolError(raw, [], { home });
      assert.equal(result.error.code, "tool-failed");
      assert.match(result.error.message, /ENOENT/);
      assert.match(result.error.message, /~\/report.txt/);
      assert.ok(!JSON.stringify(result).includes(home));
      assert.ok(!JSON.stringify(result).includes("alice"));
      assert.equal(result.error.sourceCode, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the FsFailure message and hint byte for byte", () => {
    const fs = new FsFailure("not-found", "Nothing exists at that path.").toResult();
    const original = failure({ code: "tool-failed", sourceCode: fs.error.code, message: fs.error.message,
      hint: fs.error.hint });
    const result = modelToolError(original);
    assert.equal(result.error.message, fs.error.message);
    assert.equal(result.error.hint, fs.error.hint);
    assert.equal(result.error.sourceCode, "not-found");
  });

  it("keeps typed FsFailure tool values successful and unchanged", async () => {
    const expected = new FsFailure("not-found", "Nothing exists at that path.").toResult();
    const registry = new ToolRegistry();
    registry.register({ ...TOOL, execute: async () => expected });
    const dispatcher = new ToolDispatcher({ registry, grants: GRANTS, clock: { now: () => 1 },
      approvals: { request: async () => ({ approved: false }) } });
    const raw = await dispatcher.call({ id: "fs", name: TOOL.name, args: {} }, CTX);
    const modelBound: ToolResult = raw.isError ? modelToolError(raw) : raw;
    assert.equal(modelBound, raw);
    assert.ok(!modelBound.isError);
    assert.deepEqual(modelBound.value, expected);
  });

  it("leaves the same error's diagnostic log path intact after model sanitization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "p1b-n1-log-"));
    const path = "/home/alice/project/report.txt";
    const error = new Error(`cannot open ${path}\n    at privateStack (${path}:4:2)`);
    const writer = createWriter({ dir, role: "core", source: { kind: "harness", id: "core", version: "0.1.0" },
      timers: false, now: () => 1 });
    try {
      const raw = failure({ code: "tool-failed", message: error.message });
      const result = modelToolError(raw, [], { home: "/home/alice" });
      writer.writeLegacy("error", "tool failed", { err: error, detail: raw });
      writer.close();
      const names = (await readdir(dir)).filter(name => name.endsWith(".log"));
      const contents = (await Promise.all(names.map(name => readFile(join(dir, name), "utf8")))).join("\n");
      assert.ok(contents.includes(path), contents);
      assert.ok(contents.includes("privateStack"), contents);
      assert.ok(!JSON.stringify(result).includes("alice"));
      assert.ok(raw.error.message.includes(path));
    } finally {
      writer.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
