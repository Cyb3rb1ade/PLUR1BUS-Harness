/** Review reproductions use the real ACP target, D109 approval service and filesystem/terminal sinks. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runWithAgentScope, scopeFor } from "../../src/collab/scope.ts";
import { targetRunner } from "../../src/collab/target.ts";
import type { AgentRunInput } from "../../src/collab/runner.ts";
import { ExternalDelegationTarget } from "../../src/external-agents/delegation.ts";
import { SessionStore } from "../../src/session/store.ts";
import { lastNonce, rig } from "../approvals/service-helpers.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { mountOptions, provisionFixture } from "./fixture.ts";

type Request = (method: string, params: object) => Promise<Record<string, any>>;
async function scenario(setup: (worktree: string) => { beforePolicy(count: number): void; run(request: Request): Promise<void> }) {
  const root = tempDir("q3-approved-target-");
  const home = join(root, "home"), repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-m", "init"]);
  const worktree = provisionFixture(home, repo), mount = mountOptions(worktree);
  const action = setup(worktree), permissions = await rig(), sessions = new SessionStore({ path: ":memory:" });
  const push = permissions.events.push.bind(permissions.events);
  permissions.events.push = (...events) => {
    const result = push(...events);
    for (const event of events) if (event.name === "approval.requested") queueMicrotask(() => {
      const n = lastNonce(permissions);
      assert.equal(permissions.service.decide({ requestId: n.id, nonce: n.nonce, person: "owner", surface: 3, decision: "approve" }).ok, true);
    });
    return result;
  };
  const input = new PassThrough(), output = new PassThrough();
  const pending = new Map<string, { resolve(value: Record<string, any>): void; reject(error: Error): void }>();
  let seq = 0, calls = 0, failure: unknown;
  const request: Request = (method, params) => new Promise((resolve, reject) => {
    const id = `a-${++seq}`; pending.set(id, { resolve, reject });
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const reply = (id: unknown, result: unknown) => input.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  output.on("data", chunk => {
    for (const line of String(chunk).trim().split("\n")) {
      const m = JSON.parse(line);
      if (m.method === "initialize") reply(m.id, { protocolVersion: 1 });
      else if (m.method === "session/new") reply(m.id, { sessionId: "s" });
      else if (m.method === "session/prompt") void action.run(request).catch(e => { failure = e; }).finally(() => reply(m.id, { stopReason: "end_turn" }));
      else { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p?.reject(new Error(m.error.data.reason)); else p?.resolve(m.result); }
    }
  });
  const target = new ExternalDelegationTarget({ home, worktreeOf: () => worktree, mountOf: () => mount.mount, limitsHelper: mount.limitsHelper,
    engineOf: () => ({ kind: "external", connector: "agy", timeoutMs: 30000, maxTurns: 1 }), sessions: () => sessions,
    approvals: async () => { action.beforePolicy(++calls); return permissions.service; }, connect: () => ({ input, output, stop() {} }) });
  try {
    await runWithAgentScope(scopeFor("worker", "project"), () => target.run({ agentId: "worker", principal: { kind: "person", userId: "owner", role: "owner" }, question: "Code", context: "", signal: new AbortController().signal }));
    if (failure) throw failure;
  } finally { sessions.close(); permissions.service.dispose(); permissions.stores.db.close(); }
}

test("allow_once cannot redirect approved bytes through a symlink swapped during authorization", async () => {
  if (process.platform === "win32") return;
  await scenario(worktree => {
    const approved = join(worktree, "approved.txt"), victim = join(worktree, "not-approved.txt");
    writeFileSync(approved, "original"); writeFileSync(victim, "victim original");
    return {
      beforePolicy(count) { if (count === 2) { unlinkSync(approved); symlinkSync(victim, approved); } },
      async run(request) {
        const result = await request("session/request_permission", { toolCall: { toolCallId: "call-1", rawInput: { path: approved, content: "APPROVED BYTES" } }, options: [{ kind: "allow_once", optionId: "once" }] });
        assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "once" } });
        await assert.rejects(request("fs/write_text_file", { toolCallId: "call-1", path: approved, content: "APPROVED BYTES" }), /symbolic link|identity|changed/);
        assert.equal(readFileSync(victim, "utf8"), "victim original");
      },
    };
  });
});

for (const target of ["cwd", "command"]) test(`an approved terminal ${target} cannot be reselected after authorization`, async () => {
  if (process.platform === "win32") return;
  await scenario(worktree => {
    const a = join(worktree, "approved"), b = join(worktree, "unapproved"), marker = join(b, "marker");
    mkdirSync(b);
    if (target === "cwd") mkdirSync(a); else cpSync("/usr/bin/true", a);
    return {
      beforePolicy(count) {
        if (count !== 1) return;
        renameSync(a, a + "-old"); symlinkSync(target === "cwd" ? b : "/usr/bin/touch", a);
      },
      async run(request) {
        const created = await request("terminal/create", target === "cwd" ? { command: "/usr/bin/touch", args: ["marker"], cwd: a }
          : { command: a, args: [marker], cwd: worktree });
        await assert.rejects(request("terminal/wait_for_exit", { terminalId: created.terminalId }), /identity-changed|sandbox-unavailable/);
        assert.equal(existsSync(marker), false);
      },
    };
  });
});

test("a validated read-only external consult refuses before opening a connection or touching a worktree", async () => {
  const home = tempDir("q3-readonly-");
  const worktree = join(home, "tree"); mkdirSync(worktree);
  const file = join(worktree, "reviewed.txt"); writeFileSync(file, "original");
  const sessions = new SessionStore({ path: ":memory:" });
  let connected = 0, trees = 0;
  const target = new ExternalDelegationTarget({ home, engineOf: () => ({ kind: "external", connector: "agy", timeoutMs: 5000, maxTurns: 1 }),
    worktreeOf: () => { trees++; return worktree; }, sessions: () => sessions, approvals: async () => null,
    connect: () => { connected++; throw Error("must not connect"); } });
  const handoff: NonNullable<AgentRunInput["handoff"]> = {
    contract: { schema: "plur1bus.handoff/1", id: "ho_review", kind: "consult", from: { agent: "author", session: "session" }, to: { agent: "reviewer" },
      task: { id: "task", project: "project", card: "card" }, objective: "Review only", doneWhen: ["reviewed"],
      constraints: { must: [], mustNot: ["write"], scope: { paths: ["**"], tools: ["file.read", "file.list", "file.stat"] } },
      authority: { mayDecide: [], mustAsk: [], approvalsHeld: [] }, budget: { tokens: 2000, toolCalls: 5, deadline: "2099-01-01T00:00:00Z", modelTier: "standard" },
      returnContract: { format: "plur1bus.return/1", maxTokens: 2000, outputSchema: { type: "string" }, citationsRequired: false } },
    context: { person: "owner", taskId: "task", sessionId: "session", fromAgent: "author", projectId: "project", readOnlyWorktree: worktree,
      approvals: { get() { return undefined; } } as never, grants: { get() { return undefined; } } as never, now: Date.now, audit() {} },
  };
  try {
    await assert.rejects(runWithAgentScope(scopeFor("reviewer", "project"), () => targetRunner([target]).run({ agentId: "reviewer", principal: { kind: "person", userId: "owner", role: "owner" },
      question: "Review", context: "", handoff, signal: new AbortController().signal })), /read-only review is unavailable/);
    assert.equal(connected, 0); assert.equal(trees, 0);
    assert.equal(sessions.listSessions({ owner: "owner" }).sessions.length, 0);
    assert.equal(readFileSync(file, "utf8"), "original");
  } finally { sessions.close(); }
});
