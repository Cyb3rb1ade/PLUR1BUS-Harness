import { composedAgentRunner } from "../../src/composition/collaboration.ts";
import { alsAgentScopePort, runWithAgentScope, scopeFor } from "../../src/collab/scope.ts";
import { composeTools } from "../../src/composition/tools.ts";
import { rig } from "../approvals/service-helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CodingGate } from "../../src/collab/coding-gate.ts";
import type { VerifierPort } from "../../src/collab/verifier.ts";
import { createCollab } from "../../src/collab/service.ts";
import { CollabStore } from "../../src/collab/store.ts";
import { codingCompletionTool } from "../../src/collab/coding-surface.ts";
import { GitWorktreeProvisioner, provisionedWorktreePort } from "../../src/external-agents/provisioner.ts";
import { ToolDispatcher } from "../../src/tools/dispatcher.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { owner } from "../collab/helpers.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const who = owner({ kind: "person" });

function repoWithVerifier(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, ".plur1bus-verifiers.json"), JSON.stringify({
    commands: { format: ["true"], lint: ["true"], typecheck: ["true"], test: ["true"] },
  }));
  writeFileSync(join(dir, "code.ts"), "export const n = 1;\n");
  git("add", ".");
  git("commit", "-m", "init");
}

function opened(verifier: VerifierPort) {
  const root = tempDir("m6b-d98-");
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(join(home, "state"), { recursive: true });
  repoWithVerifier(repo);
  const db = join(home, "state", "collab.sqlite");
  const collab = createCollab({ path: db, home, provisionWorktrees: true });
  const project = collab.createProject(who, { name: "Gate" });
  collab.addAgent(who, project.id, "worker");
  collab.bindRepo(who, project.id, repo, "main");
  const store = new CollabStore({ path: db });
  const fork = store.liveWorktree(project.id, null)!;
  const port = provisionedWorktreePort(store, () => "/workspace", join(home, "state"));
  const card = collab.boardStore.createCard(project.id, {
    title: "Coding", description: "Implement the change.", columnId: collab.boardStore.columns(project.id)[0]!.id,
  }, { kind: "person", id: who.userId });
  collab.boardStore.assign(project.id, card.id, { kind: "agent", id: "worker" }, true, { kind: "person", id: who.userId });
  const events: object[] = [];
  const gate = new CodingGate({ path: ":memory:", audit: (event) => events.push(event), verifier });
  const cardPath = port.root("worker", project.id, card.id)!;
  return { home, collab, store, gate, project, card, fork: { ...fork, path: cardPath }, port, events };
}

async function complete(box: ReturnType<typeof opened>) {
  const o = { gate: box.gate, collab: box.collab, worktrees: box.port };
  const registry = new ToolRegistry();
  registry.register(codingCompletionTool(o, { projectId: box.project.id } as never, () => who));
  const dispatcher = new ToolDispatcher({
    registry,
    approvals: { async request() { throw new Error("unexpected ask"); } },
    grants: { get: () => undefined, list: () => [] },
    clock: { now: () => Date.now() },
    policyContext: () => ({ overrides: { "shell.exec": "allowed" } }),
  });
  return dispatcher.call(
    { id: "complete", name: "coding_complete", args: { projectId: box.project.id, cardId: box.card.id } },
    { agentId: "worker", principal: who.userId, surface: 1, signal: new AbortController().signal },
  );
}

test("coding_complete verifies the provisioned worktree", async () => {
  let seen = "";
  const box = opened({ async run(root) { seen = root; return { ok: true, exitCode: 0, output: "" }; } });
  try {
    assert.equal(realpathSync(box.port.root("worker", box.project.id, box.card.id)!), realpathSync(box.fork.path));
    const result = await complete(box);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(realpathSync(seen), realpathSync(box.fork.path));
    const done = box.collab.boardStore.columns(box.project.id).find((c) => c.titleKey === "project.board.done");
    assert.equal(box.collab.boardStore.getCard(box.project.id, box.card.id).columnId, done?.id);
  } finally { box.gate.close(); box.collab.close(); box.store.close(); }
});

test("a verifier that writes during the run is refused", async () => {
  const box = opened({
    async run(root) {
      writeFileSync(join(root, "during.txt"), "changed");
      return { ok: true, exitCode: 0, output: "" };
    },
  });
  try {
    const before = box.collab.boardStore.getCard(box.project.id, box.card.id).columnId;
    const result = await complete(box);
    assert.equal(result.isError, true);
    assert.ok(box.events.some((event) => (event as { reason?: string }).reason === "worktree-changed-during-verification"));
    assert.equal(box.collab.boardStore.getCard(box.project.id, box.card.id).columnId, before);
  } finally { box.gate.close(); box.collab.close(); box.store.close(); }
});

test("production bind, local coding turn and completion use the same provisioned card checkout", async () => {
  const box = opened({ async run() { return { ok: true, exitCode: 0, output: "" }; } });
  const approvals = await rig();
  const signal = new AbortController().signal;
  try {
    let seen = "";
    const runner = composedAgentRunner({ id: "fixture", async *stream(req) {
      if (req.messages[0]?.text.startsWith("Acceptance check only")) {
        yield { type: "delta", text: JSON.stringify({ schema: "plur1bus.ack/1", inReplyTo: "ho_test", objective: "Code", status: "ok", blockingQuestions: [] }) };
        return;
      }
      assert.equal(req.codingWorktree, box.fork.path);
      seen = req.codingWorktree!;
      const registry = await composeTools({ home: box.home, roots: [], audit: { append() {} } as never,
        grants: { get: () => undefined, list: () => [] } }, req);
      const dispatcher = new ToolDispatcher({ registry, approvals: approvals.service,
        grants: approvals.stores.grants, clock: { now: Date.now },
        policyContext: () => ({ overrides: { "fs.write": "allowed" } }) });
      const written = await dispatcher.call({ id: "write", name: "file.write", args: { path: "notes.txt", content: "local coding turn" } },
        { agentId: "worker", principal: who.userId, signal, surface: 1 });
      assert.equal(written.isError, false, JSON.stringify(written));
      yield { type: "delta", text: "Done" };
    } }, alsAgentScopePort(), box.home, [], undefined, box.port);
    await runWithAgentScope(scopeFor("worker", box.project.id), () => runner.run({
      agentId: "worker", principal: who, question: "Code", context: "", signal,
      handoff: {
        contract: { schema: "plur1bus.handoff/1", id: "ho_test", kind: "delegate", from: { agent: "lead", session: "session" },
          to: { agent: "worker" }, task: { id: "task", project: box.project.id, card: box.card.id }, objective: "Code", doneWhen: ["local change verified"],
          constraints: { must: [], mustNot: [], scope: { paths: ["**"], tools: [] } },
          authority: { mayDecide: [], mustAsk: [], approvalsHeld: [] },
          budget: { tokens: 2000, toolCalls: 5, deadline: "2099-01-01T00:00:00Z", modelTier: "standard" },
          returnContract: { format: "plur1bus.return/1", maxTokens: 2000, outputSchema: { type: "string" }, citationsRequired: false } },
        context: { person: who.userId, taskId: "task", sessionId: "session", fromAgent: "lead", projectId: box.project.id,
          approvals: approvals.stores.approvals, grants: approvals.stores.grants, now: Date.now, audit() {} },
      },
    }));
    assert.equal(seen, box.port.root("worker", box.project.id, box.card.id));
    const result = await complete(box);
    assert.equal(result.isError, false, JSON.stringify(result));
  } finally {
    approvals.service.dispose(); approvals.stores.db.close();
    box.gate.close(); box.collab.close(); box.store.close();
  }
});

test("coding verification refuses a FIFO manifest before reading it", async () => {
  if (process.platform === "win32") return;
  const box = opened({ async run() { return { ok: true, exitCode: 0, output: "" }; } });
  try {
    const path = join(box.fork.path, ".plur1bus-verifiers.json");
    unlinkSync(path);
    execFileSync("mkfifo", [path]);
    await assert.rejects(box.gate.verify({ task: "fifo", root: box.fork.path, signal: new AbortController().signal }), /bounded regular file/);
  } finally { box.gate.close(); box.collab.close(); box.store.close(); }
});
