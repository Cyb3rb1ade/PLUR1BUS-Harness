import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
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
  const collab = createCollab({ path: db, home });
  const project = collab.createProject(who, { name: "Gate" });
  collab.addAgent(who, project.id, "worker");
  collab.bindRepo(who, project.id, repo, "main");
  const store = new CollabStore({ path: db });
  const fork = new GitWorktreeProvisioner(store, join(home, "state")).fork({ projectId: project.id });
  const port = provisionedWorktreePort(store, () => "/workspace");
  const card = collab.boardStore.createCard(project.id, {
    title: "Coding", description: "Implement the change.", columnId: collab.boardStore.columns(project.id)[0]!.id,
  }, { kind: "person", id: who.userId });
  collab.boardStore.assign(project.id, card.id, { kind: "agent", id: "worker" }, true, { kind: "person", id: who.userId });
  const events: object[] = [];
  const gate = new CodingGate({ path: ":memory:", audit: (event) => events.push(event), verifier });
  return { collab, store, gate, project, card, fork, port, events };
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
