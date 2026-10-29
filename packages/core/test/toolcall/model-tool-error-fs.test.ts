/** N1 typed file-tool messages survive the actual adapter/dispatcher path; raw diagnostics remain unchanged. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { composeTools, ToolAdapterError } from "../../src/composition/tools.ts";
import { modelToolError } from "../../src/toolcall/model-tool-error.ts";
import { ToolDispatcher } from "../../src/tools/dispatcher.ts";
import { FsFailure } from "../../src/tools/fs/failure.ts";
import { createFsTools } from "../../src/tools/fs/tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { readTool, turnRequest, useTempDirs } from "../composition/helpers.ts";

const tmp = useTempDirs("n1-fs-detail-");
const GRANTS = { get: () => undefined, list: () => [] };
const CTX = { agentId: "a1", principal: "owner", surface: 3 as const, signal: new AbortController().signal };

it("preserves the actual composed file tool's FsFailure message and hint byte for byte", async () => {
  const root = tmp.make();
  const home = tmp.make();
  const roots = [{ id: "fixture", path: root }];
  const path = join(root, "missing.txt");
  const file = createFsTools({ roots }).tools.find(tool => tool.name === "file.read")!;
  const expected = await file.execute({ path }, { signal: CTX.signal });
  assert.ok(expected.isError);
  const registry = await composeTools({ home, roots, audit: { append() {} }, grants: GRANTS }, turnRequest());
  const dispatcher = new ToolDispatcher({ registry, grants: GRANTS, clock: { now: () => 1 },
    approvals: { request: async () => ({ approved: false }) } });
  const raw = await dispatcher.call({ id: "fs", name: "file.read", args: { path } }, CTX);
  assert.ok(raw.isError);
  assert.equal(raw.error.message, "file.read failed: tool-failed");
  assert.equal(raw.error.sourceCode, "tool-failed");
  const safe = modelToolError(raw);
  assert.equal(safe.error.code, "tool-failed");
  assert.equal(safe.error.message, expected.error.message);
  assert.equal(safe.error.hint, expected.error.hint);
  assert.equal(safe.error.sourceCode, expected.error.code);
  assert.equal(raw.error.message, "file.read failed: tool-failed");
  assert.equal(raw.error.sourceCode, "tool-failed");
  assert.equal(safe.error.typedFailure, undefined);
});

it("preserves a directly thrown FsFailure's typed message and hint while retaining raw diagnostics", async () => {
  const registry = new ToolRegistry();
  const error = new FsFailure("not-found", "no such file");
  registry.register(readTool("file.read", async () => { throw error; }));
  const dispatcher = new ToolDispatcher({ registry, grants: GRANTS, clock: { now: () => 1 },
    approvals: { request: async () => ({ approved: false }) } });
  const raw = await dispatcher.call({ id: "fs", name: "file.read", args: { path: "missing.txt" } }, CTX);
  assert.ok(raw.isError);
  assert.equal(raw.error.message, "file.read failed: no such file");
  const safe = modelToolError(raw);
  assert.equal(safe.error.message, error.message);
  assert.equal(safe.error.hint, error.hint);
  assert.equal(safe.error.sourceCode, "not-found");
});

it("redacts validated adapter details instead of treating them as trusted model text", async () => {
  const registry = new ToolRegistry();
  registry.register(readTool("file.read", async () => {
    throw new ToolAdapterError("tool-failed", { isError: true, error: {
      code: "not-found", message: "cannot read /home/alice/project/report.txt secret-12345\n    at privateStack",
      hint: "try /Users/alice/project/report.txt secret-12345",
    } });
  }));
  const dispatcher = new ToolDispatcher({ registry, grants: GRANTS, clock: { now: () => 1 },
    approvals: { request: async () => ({ approved: false }) } });
  const raw = await dispatcher.call({ id: "fs", name: "file.read", args: { path: "missing.txt" } }, CTX);
  assert.ok(raw.isError);
  const safe = modelToolError(raw, ["secret-12345"], { home: "/srv/operator" });
  assert.equal(safe.error.message, "cannot read /home/<user>/project/report.txt [REDACTED:secret]");
  assert.equal(safe.error.hint, "try /Users/<user>/project/report.txt [REDACTED:secret]");
  assert.doesNotMatch(JSON.stringify(safe), /alice|privateStack|secret-12345/);
});

it("ignores arbitrary exception details and malformed adapter payloads", async () => {
  for (const error of [
    Object.assign(new Error("ordinary"), { detail: { isError: true,
      error: { code: "not-found", message: "must not replace", hint: "must not replace" } } }),
    new ToolAdapterError("tool-failed", { isError: true,
      error: { code: "not-found", message: "must not replace", hint: { nested: "invalid" } } }),
  ]) {
    const registry = new ToolRegistry();
    registry.register(readTool("file.read", async () => { throw error; }));
    const dispatcher = new ToolDispatcher({ registry, grants: GRANTS, clock: { now: () => 1 },
      approvals: { request: async () => ({ approved: false }) } });
    const raw = await dispatcher.call({ id: "fs", name: "file.read", args: { path: "missing.txt" } }, CTX);
    assert.ok(raw.isError);
    const safe = modelToolError(raw);
    assert.doesNotMatch(safe.error.message, /must not replace/);
    assert.equal(safe.error.hint, undefined);
    assert.equal(safe.error.typedFailure, undefined);
  }
});

it("falls back to the original failure when typed-detail extraction throws", async () => {
  class BrokenFsFailure extends FsFailure {
    override toResult(): never { throw new Error("conversion failed"); }
  }
  const brokenDetail = { isError: true, get error(): never { throw new Error("detail getter failed"); } };
  const brokenMessage = { isError: true, error: {
    code: "not-found", get message(): never { throw new Error("message getter failed"); },
  } };
  for (const error of [
    new ToolAdapterError("tool-failed", brokenDetail),
    new ToolAdapterError("tool-failed", brokenMessage),
    new BrokenFsFailure("not-found", "no such file"),
  ]) {
    const registry = new ToolRegistry();
    registry.register(readTool("file.read", async () => { throw error; }, { limits: { timeoutMs: 1 } }));
    const dispatcher = new ToolDispatcher({ registry, grants: GRANTS, clock: { now: () => 1 },
      approvals: { request: async () => ({ approved: false }) } });
    const raw = await dispatcher.call({ id: "fs", name: "file.read", args: { path: "missing.txt" } }, CTX);
    assert.ok(raw.isError);
    assert.equal(raw.error.code, "tool-failed");
    assert.equal(raw.error.message, `file.read failed: ${error.message}`);
    assert.equal(raw.error.typedFailure, undefined);
    const safe = modelToolError(raw);
    assert.equal(safe.error.message, raw.error.message);
    assert.equal(safe.error.hint, undefined);
  }
});
