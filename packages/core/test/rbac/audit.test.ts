import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJsonlAuditSink, memoryAuditSink, type AuditEvent } from "../../src/rbac/audit.ts";

const ev = (action: string, over: Partial<AuditEvent> = {}): AuditEvent => ({ at: 1, actor: { user: "u1", host: "h" }, action, target: "t", detail: { a: 1 }, ...over });

describe("audit sinks", () => {
  it("the memory sink keeps copies, so a later mutation cannot rewrite history", () => {
    const sink = memoryAuditSink();
    const e = ev("x");
    sink.append(e);
    (e.detail as Record<string, unknown>)["a"] = 2;
    assert.equal(sink.events[0]?.detail["a"], 1);
  });

  it("the JSONL sink writes the five-key line shape of crates/plur1bus/src/audit.rs, append only", () => {
    const dir = mkdtempSync(join(tmpdir(), "p1b-audit-"));
    try {
      const path = join(dir, "logs", "audit.log");
      const sink = createJsonlAuditSink(path);
      sink.append(ev("break-glass.granted"));
      const first = readFileSync(path, "utf8");
      sink.append(ev("break-glass.expired", { actor: { user: "system", host: "h" } }));
      const text = readFileSync(path, "utf8");
      assert.ok(text.startsWith(first), "the first line is never rewritten");
      const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(lines.length, 2);
      assert.deepEqual(Object.keys(lines[0]!).sort(), ["action", "actor", "at", "detail", "target"]);
      assert.equal(lines[1]!["action"], "break-glass.expired");
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("re-restricts an existing, too-open file and keeps its content", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "p1b-audit-"));
    try {
      const path = join(dir, "audit.log");
      writeFileSync(path, "{\"old\":true}\n");
      chmodSync(path, 0o644);
      createJsonlAuditSink(path).append(ev("x"));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.ok(readFileSync(path, "utf8").startsWith("{\"old\":true}\n"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a write failure throws, so callers that audit-before-effect fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "p1b-audit-"));
    try {
      // The parent of the log path is a regular file: the directory cannot be created.
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "");
      assert.throws(() => createJsonlAuditSink(join(blocker, "audit.log")).append(ev("x")));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
