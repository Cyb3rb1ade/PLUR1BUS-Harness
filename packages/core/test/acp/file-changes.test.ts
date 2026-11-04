/** ACP full-file diffs require exact evidence; a unified patch never stands in for unknown old contents. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpFileChanges, MAX_DIFF_CONTENT_BYTES, MAX_RETAINED_FILE_CALLS } from "../../src/acp/file-changes.ts";

const patch = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
function output(value: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ tool: "file.write", callId: "c", isError: false, value: {
    rootId: "coding-worktree", path: "file.ts", ...value,
  }, ...extra });
}

test("a complete UTF-8 write and Core-created proof produce a genuine ACP diff without reading files", () => {
  const changes = new AcpFileChanges("/canonical/work");
  const content = "\ufeffhello\r\n😀\r\n";
  changes.call("c", "file.write", { path: "file.ts", content });
  assert.deepEqual(changes.result("c", output({ created: true, bytesWritten: Buffer.byteLength(content) })), [{
    type: "diff", path: "/canonical/work/file.ts", oldText: null, newText: content,
  }]);
});

test("the actual persisted Core result is paired by event id even when its body omits dispatcher ids", () => {
  const changes = new AcpFileChanges("/canonical/work");
  changes.call("c", "file.write", { path: "file.ts", content: "new\n" });
  const result = JSON.stringify({ isError: false, truncated: false,
    value: { rootId: "coding-worktree", path: "file.ts", bytesWritten: 4, created: true } });
  assert.deepEqual(changes.result("c", result), [{ type: "diff", path: "/canonical/work/file.ts",
    oldText: null, newText: "new\n" }]);
});

test("a successful existing-file write has an explicitly labelled text patch, never invented oldText", () => {
  const changes = new AcpFileChanges("/canonical/work");
  changes.call("c", "file.write", { path: "file.ts", content: "new\n", overwrite: true });
  const result = changes.result("c", output({ created: false, bytesWritten: 4, diff: patch }));
  assert.equal(result?.[0]?.type, "content");
  assert.match(JSON.stringify(result), /Unified text patch/);
  assert.match(JSON.stringify(result), /complete before\/after contents unavailable/);
  assert.equal(JSON.stringify(result).includes('"oldText"'), false);
  assert.ok(JSON.stringify(result).includes("@@ -1 +1 @@"));
});

test("a truncated file.edit diff remains a labelled truncated text patch", () => {
  const changes = new AcpFileChanges("/canonical/work");
  changes.call("c", "file.edit", { path: "file.ts", edits: [{ old: "old", new: "new" }] });
  const result = changes.result("c", output({ unifiedDiff: patch, truncated: true }, { tool: "file.edit" }));
  assert.equal(result?.[0]?.type, "content");
  assert.match(JSON.stringify(result), /Unified text patch \(truncated/);
  assert.equal(JSON.stringify(result).includes('"oldText"'), false);
});

test("oversized full content falls back to text even when Core proved a newly-created file", () => {
  const changes = new AcpFileChanges("/canonical/work");
  const content = "x".repeat(MAX_DIFF_CONTENT_BYTES + 1);
  changes.call("c", "file.write", { path: "file.ts", content });
  const result = changes.result("c", output({ created: true, bytesWritten: content.length, diff: patch }));
  assert.equal(result?.[0]?.type, "content");
  assert.match(JSON.stringify(result), /size limit/);
});

test("binary encoding, failed calls, mismatched bytes and paths outside the bound worktree cannot become full diffs", () => {
  const cases = [
    { args: { encoding: "base64" }, value: {} },
    { args: {}, value: {}, extra: { isError: true } },
    { args: {}, value: { bytesWritten: 3 } },
    { args: {}, value: { path: "../foreign.ts" } },
    { args: {}, value: { path: "/foreign.ts" } },
    { args: {}, value: { path: "C:\\foreign.ts" } },
    { args: {}, value: { rootId: "another-root" } },
    { args: {}, value: {}, extra: { callId: "foreign" } },
  ];
  for (const item of cases) {
    const changes = new AcpFileChanges("/canonical/work");
    changes.call("c", "file.write", { path: "file.ts", content: "new\n", ...item.args });
    const result = changes.result("c", output({ created: true, bytesWritten: 4, diff: patch, ...item.value },
      item.extra));
    assert.equal(result?.some(part => part.type === "diff"), false, JSON.stringify(item));
  }
});

test("a Windows canonical worktree produces an absolute Windows diff path; an absent binding remains text", () => {
  const windows = new AcpFileChanges("C:\\canonical\\work");
  windows.call("c", "file.write", { path: "file.ts", content: "new\n" });
  assert.deepEqual(windows.result("c", output({ created: true, bytesWritten: 4 })), [{
    type: "diff", path: "C:\\canonical\\work\\file.ts", oldText: null, newText: "new\n",
  }]);
  const unbound = new AcpFileChanges();
  unbound.call("c", "file.write", { path: "file.ts", content: "new\n" });
  assert.equal(unbound.result("c", output({ created: true, bytesWritten: 4, diff: patch }))?.[0]?.type, "content");
});

test("large Unicode patches remain bounded valid Unicode and say that the displayed patch was clipped", () => {
  const changes = new AcpFileChanges("/canonical/work");
  changes.call("c", "file.edit", {});
  const result = changes.result("c", output({ diff: "😀".repeat(100_000) }, { tool: "file.edit" }));
  assert.equal(result?.[0]?.type, "content");
  const text = result?.[0]?.type === "content" ? result[0].content.text : "";
  assert.equal(text.isWellFormed(), true);
  assert.ok(Buffer.byteLength(text) < 40_000);
  assert.match(text, /display clipped/);
});

test("evicting bounded full-text metadata retains an honest text patch for the older file result", () => {
  const changes = new AcpFileChanges("/canonical/work");
  for (let i = 0; i <= MAX_RETAINED_FILE_CALLS; i++) {
    changes.call(`c${i}`, "file.write", { path: "file.ts", content: "new\n" });
  }
  const result = changes.result("c0", JSON.stringify({ isError: false,
    value: { rootId: "coding-worktree", path: "file.ts", created: true, bytesWritten: 4, diff: patch } }));
  assert.equal(result?.[0]?.type, "content");
  assert.match(JSON.stringify(result), /Unified text patch/);
});
