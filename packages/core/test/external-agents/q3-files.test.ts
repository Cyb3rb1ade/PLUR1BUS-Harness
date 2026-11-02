/** Q3: special files never occupy a libuv worker, and cancellation precedes every side effect. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { containedRead, containedWrite } from "../../src/external-agents/containment.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("FIFO reads and writes refuse before blocking the worker pool", async () => {
  if (process.platform === "win32") return;
  const worktree = tempDir("acp-fifo-");
  const home = join(worktree, "home");
  mkdirSync(home);
  const fifo = join(worktree, "pipe");
  execFileSync("mkfifo", [fifo]);
  const box = { worktree, home };
  await assert.rejects(containedRead(box, fifo), /regular/);
  await assert.rejects(containedWrite(box, fifo, "x"));
});

test("an aborted write creates no file", async () => {
  const worktree = tempDir("acp-abort-");
  const home = join(worktree, "home");
  mkdirSync(home);
  const path = join(worktree, "new");
  await assert.rejects(containedWrite({ worktree, home, signal: AbortSignal.abort() }, path, "x"));
  assert.equal(existsSync(path), false);
});

test("abort during the verified-open parent check prevents O_CREAT", async () => {
  const { canonicalisePath, openVerified } = await import("../../src/policy/paths.ts");
  const { constants } = await import("node:fs");
  const worktree = tempDir("acp-open-abort-");
  const path = join(worktree, "new");
  const resolved = await canonicalisePath(path, { roots: [{ id: "wt", path: worktree }], deny: [], access: "write" });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const abort = new AbortController();
  const pending = openVerified(resolved, constants.O_CREAT | constants.O_WRONLY | constants.O_NONBLOCK, abort.signal);
  abort.abort();
  await assert.rejects(pending);
  assert.equal(existsSync(path), false);
});
