/** CLI-1 host commands reuse the D98 runner; direct checks are advisory and read-only diffs never run Git hooks. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/session/store.ts";
import { CodingSessions } from "../../src/coding/sessions.ts";
import { CodingActions } from "../../src/coding/actions.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { createRedactor } from "../../src/logs/redact.ts";
import type { VerifierPort } from "../../src/collab/verifier.ts";

const who = { userId: "owner", role: "owner", kind: "person" } as const;
const caller = { channel: "cli", accountId: "host", userId: "owner" } as const;
async function rig(t: TestContext, verifier: VerifierPort) {
  const dir = mkdtempSync(join(tmpdir(), "coding-actions-")),
    root = join(dir, "repo"),
    home = join(dir, "home");
  mkdirSync(root);
  mkdirSync(home);
  execFileSync("git", ["init", "-q", root]);
  const store = new SessionStore({ path: ":memory:" });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const coding = new CodingSessions({
    home,
    store: () => store,
    storeFor: () => store,
    ephemeral: () => store,
    agents: { workspaceOf: () => root } as never,
    roots: () => [{ id: "repo", path: root }],
    grants: { list: () => [], get: () => undefined },
    clock: Date.now,
    audit: memoryAuditSink(),
  });
  const opened = await coding.open({ caller, agentId: "a", root }, who, { connectionId: "call", surface: 3 });
  const actions = new CodingActions({
    coding,
    storeFor: () => store,
    verifier,
    redact: (text) => createRedactor({ secrets: ["fixture-sensitive-value"] }).text(text),
  });
  const params = { caller, sessionId: opened.session.id };
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return { root, store, coding, actions, params, git };
}

test("advisory checks use the same four verifier kinds, need no independent review and preserve transcript rows", async (t) => {
  const calls: string[] = [];
  const r = await rig(t, {
    async run(_root, command, options) {
      assert.equal(options.networkAllowed, false);
      calls.push(command.kind);
      return { ok: true, exitCode: 0, output: "fixture-sensitive-value\npassed" };
    },
  });
  writeFileSync(
    join(r.root, "package.json"),
    JSON.stringify({ scripts: { "format:check": "check", lint: "check", typecheck: "check", test: "check" } }),
  );
  writeFileSync(join(r.root, "large.ts"), "new source line\n".repeat(250));
  const before = r.store.listMessages(r.params.sessionId);
  const result = await r.actions.check(r.params, who, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.equal(result.advisory, true);
  assert.deepEqual(calls, ["format", "lint", "typecheck", "test"]);
  assert.ok(result.checks.every((c) => !c.output.includes("fixture-sensitive-value")));
  assert.deepEqual(r.store.listMessages(r.params.sessionId), before);
});

test("checks pass through cancellation and an uncommitted manifest cannot opt into network access", async (t) => {
  const ac = new AbortController();
  const r = await rig(t, {
    async run(_root, command, options) {
      assert.equal(command.kind, "test");
      assert.equal(options.signal, ac.signal);
      assert.equal(options.networkAllowed, false);
      ac.abort();
      return { ok: false, exitCode: null, reason: "aborted", output: "" };
    },
  });
  writeFileSync(
    join(r.root, ".plur1bus-verifiers.json"),
    JSON.stringify({
      networkAllowed: true,
      commands: Object.fromEntries(["format", "lint", "typecheck", "test"].map((kind) => [kind, ["node", "--test"]])),
    }),
  );
  const result = await r.actions.check({ ...r.params, kind: "test" }, who, ac.signal);
  assert.equal(result.ok, false);
  assert.equal(result.checks[0]?.reason, "aborted");
});

test("diff pages retain Unicode and redact secrets; folded call diffs can be read without changing Git state", async (t) => {
  const r = await rig(t, {
    async run() {
      return { ok: true, exitCode: 0, output: "" };
    },
  });
  writeFileSync(join(r.root, "file.ts"), "before\n");
  r.git("add", ".");
  r.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
  writeFileSync(join(r.root, "file.ts"), "after 🧩 fixture-sensitive-value\n");
  const index = readFileSync(join(r.root, ".git", "index"));
  const diff = await r.actions.diff(r.params, who);
  assert.ok(diff.diff.includes("after 🧩"));
  assert.ok(!diff.diff.includes("fixture-sensitive-value"));
  const turn = r.store.beginTurn(r.params.sessionId, "task", 1);
  const patch = Array.from({ length: 60 }, (_, i) => `+line ${i} 🧩`).join("\n");
  r.store.appendEvent(turn.turn.id, "tool.call", { id: "edit", name: "file.edit", args: { path: "file.ts" } });
  r.store.appendEvent(turn.turn.id, "tool.result", {
    id: "edit",
    output: JSON.stringify({ isError: false, value: { diff: patch } }),
  });
  r.store.completeTurn(turn.turn.id, { text: "done", tokens: 1 });
  let text = "",
    offset = 0;
  do {
    const page = await r.actions.diff({ ...r.params, callId: "edit", offset, limit: 53 }, who);
    text += page.diff;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (true);
  assert.equal(text, patch);
  assert.deepEqual(readFileSync(join(r.root, ".git", "index")), index);
});

test("read-only diff never executes a repository textconv or external-diff command", async (t) => {
  const r = await rig(t, {
    async run() {
      return { ok: true, exitCode: 0, output: "" };
    },
  });
  writeFileSync(join(r.root, "file.ts"), "before\n");
  writeFileSync(join(r.root, ".gitattributes"), "*.ts diff=unsafe\n");
  r.git("add", ".");
  r.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
  const marker = join(r.root, "hook-ran");
  const script = join(r.root, "untrusted.sh");
  writeFileSync(script, '#!/bin/sh\ntouch "' + marker.replaceAll('"', '\\"') + '"\n', { mode: 0o700 });
  r.git("config", "diff.unsafe.textconv", script);
  r.git("config", "diff.external", script);
  writeFileSync(join(r.root, "file.ts"), "after\n");
  assert.ok((await r.actions.diff(r.params, who)).diff.includes("+after"));
  assert.equal(existsSync(marker), false);
});

test("native diff never executes a clean filter from included repository configuration", async (t) => {
  const r = await rig(t, {
    async run() {
      return { ok: true, exitCode: 0, output: "" };
    },
  });
  writeFileSync(join(r.root, "file.ts"), "before\n");
  r.git("add", ".");
  r.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
  const marker = join(r.root, "filter-executed"),
    script = join(r.root, "filter.cjs"),
    include = join(r.root, "filters.cfg");
  writeFileSync(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');process.stdin.pipe(process.stdout);`,
  );
  const command = `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`;
  writeFileSync(include, `[filter "trap"]\n clean = ${JSON.stringify(command)}\n`);
  r.git("config", "--local", "include.path", include);
  writeFileSync(join(r.root, ".gitattributes"), "*.ts filter=trap\n");
  writeFileSync(join(r.root, "file.ts"), "after raw bytes\n");
  const index = readFileSync(join(r.root, ".git", "index"));
  const diff = await r.actions.diff(r.params, who);
  assert.equal(existsSync(marker), false, "a human read-only diff cannot execute a repository program");
  assert.match(diff.diff, /after raw bytes/);
  assert.deepEqual(readFileSync(join(r.root, ".git", "index")), index);
});
