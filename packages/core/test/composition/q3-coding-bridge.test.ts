/** Production root binding and coding completion, with optional test-only card provisioning. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaults } from "@plur1bus/config-schema";
import { createAgentRegistry } from "../../src/agents.ts";
import { openTurnComposition, type CompositionDeps } from "../../src/composition/index.ts";
import { createIdentityService } from "../../src/identity/service.ts";
import { layout } from "../../src/paths.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { ToolAdapterError } from "../../src/tools/tool-adapter-error.ts";
import { ToolDispatcher } from "../../src/tools/dispatcher.ts";
import { rig } from "../approvals/service-helpers.ts";
import { owner } from "../collab/helpers.ts";
import { GitWorktreeProvisioner } from "../../src/external-agents/provisioner.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import type { TurnProviderOptions } from "../../src/composition/provider.ts";
import { limitsHelper } from "../external-agents/fixture.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("composed ACP targets remain external after the A2A target list is assembled", async () => {
  const home = join(tempDir("q3-target-routing-"), "home");
  const cfg = defaults();
  cfg.agents.lead = {};
  // An invalid external record must fail closed rather than run a local model.
  cfg.agents.worker = { engine: { kind: "external", connector: "agy", maxTurns: 0 } };
  for (const id of ["lead", "worker"]) mkdirSync(join(home, "agents", id, "workspace"), { recursive: true });
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; }, async close() {} } as never;
  const approvals = await rig(), who = owner();
  const identity = createIdentityService({ dbPath: join(home, "identity.sqlite"), clock: Date.now, audit() {} });
  let localCalls = 0;
  const c = await openTurnComposition({ home, config: () => cfg, engine: {} as never,
    agents: createAgentRegistry({ config: () => cfg }, layout(home), log), logger: log,
    secrets: createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink() }),
    egress: { decide: async () => ({ allowed: false }) } as never,
    permissions: { current: () => ({ ...approvals.stores, service: approvals.service }), open: async () => ({ ...approvals.stores, service: approvals.service }) } as never,
    resolveCollaborationPerson: id => id === who.userId ? who : null,
    audit: memoryAuditSink(), identity, clock: Date.now, signal: new AbortController().signal,
    isStopping: () => false, notify() {}, options: {
      providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() {} } }] } },
      createTurnProvider: () => ({ id: "fixture", telemetry: {} as never, async *stream() { localCalls++; yield { type: "delta", text: "unexpected local fallback" }; } }),
    } });
  try {
    assert.ok(c.collab);
    const project = c.collab.createProject(who, { name: "Routing" });
    for (const id of ["lead", "worker"]) c.collab.addAgent(who, project.id, id);
    await assert.rejects(c.collab.consult({ principal: who, projectId: project.id, fromAgent: "lead", toAgent: "worker", question: "Check routing", context: "" }),
      { reason: process.platform === "linux" ? "connector-unavailable" : "sandbox-unavailable" });
    assert.equal(localCalls, 0, "an external record must never fall through to the local provider");
  } finally { await c.close(); identity.close(); approvals.service.dispose(); approvals.stores.db.close(); }
});

for (const provisionCard of [false, true]) test(provisionCard
  ? "production bind → local coding delegation → coding_complete with a test-provisioned card tree and real verifier"
  : "production bind/createCard/assign refuses completion and review without a card checkout", async t => {
  if (provisionCard && process.platform === "win32") return; // The native coding verifier currently has no Windows backend.
  const dir = tempDir("q3-composition-"), home = join(dir, "home"), repo = join(dir, "repo");
  const cfg = defaults(); cfg.agents.lead = {}; cfg.agents.coder = {};
  if (!provisionCard) cfg.collaboration.fanoutEnabled = true;
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; }, async close() {} } as never;
  for (const id of ["lead", "coder"]) mkdirSync(join(home, "agents", id, "workspace"), { recursive: true });
  if (provisionCard) {
    mkdirSync(join(home, "bin"), { recursive: true }); copyFileSync(limitsHelper, join(home, "bin", "plur1bus-sandbox-limits"));
  }
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  writeFileSync(join(repo, "notes.md"), "before\n");
  writeFileSync(join(repo, "verify.cjs"), "const fs=require('node:fs');if(fs.readFileSync('notes.md','utf8')!=='local coding turn\\n')process.exit(1);console.log(process.cwd());\n");
  writeFileSync(join(repo, ".plur1bus-verifiers.json"), JSON.stringify({ commands: Object.fromEntries(["format", "lint", "typecheck", "test"].map(kind => [kind, [process.execPath, "verify.cjs"]])) }));
  git("add", "."); git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", "init");
  const approvals = await rig(), who = owner();
  const identity = createIdentityService({ dbPath: join(home, "identity.sqlite"), clock: Date.now, audit() {} });
  let projectId = "", cardId = "", seen = "";
  let completion: { verification: { checks: { ok: boolean; evidence: string }[] } } | undefined;
  let toolsForTurn: TurnProviderOptions["toolsForTurn"];
  const options: NonNullable<CompositionDeps["options"]> = {
    tools: { exec: { mode: "allowlist", allowlist: [{ program: "/usr/bin/touch" }] } },
    providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() {} } }] } },
    createTurnProvider: o => { toolsForTurn = o.toolsForTurn; return ({ id: "fixture", telemetry: {} as never, async *stream(req) {
      if (req.messages[0]?.text.startsWith("Acceptance check only")) {
        yield { type: "delta", text: JSON.stringify({ schema: "plur1bus.ack/1", inReplyTo: "ho_bridge", objective: "Code", status: "ok", blockingQuestions: [] }) };
        return;
      }
      assert.ok(req.codingWorktree, "the production runner must select the provisioned tree");
      seen = req.codingWorktree;
      const registry = await o.toolsForTurn!(req);
      const dispatcher = new ToolDispatcher({ registry, approvals: approvals.service, grants: approvals.stores.grants,
        clock: { now: Date.now }, policyContext: () => ({ overrides: { "fs.write": "allowed", "shell.exec": "allowed" } }) });
      const ctx = { agentId: "coder", principal: who.userId, signal: req.signal, surface: 1 as const };
      const execTool = registry.get("exec.run")!, execute = execTool.execute;
      let failure: unknown;
      // Observe the real adapter failure; the dispatcher intentionally bounds its public envelope.
      const get = registry.get.bind(registry);
      t.mock.method(registry, "get", (name: string) => name === "exec.run" ? { ...execTool,
        execute: async (...args: Parameters<typeof execute>) => {
          try { return await execute(...args); } catch (error) { failure = error; throw error; }
        },
      } : get(name));
      const marker = join(seen, "native-must-not-start");
      const refused = await dispatcher.call({ id: "bridge-exec", name: "exec.run",
        args: { program: "/usr/bin/touch", args: [marker], cwd: seen } }, ctx);
      assert.equal(refused.isError, true, JSON.stringify(refused));
      assert.ok(failure instanceof ToolAdapterError);
      assert.match(JSON.stringify(failure.detail), /spawn-failed/);
      assert.match(JSON.stringify(failure.detail), /sandbox path is deny-listed/);
      assert.equal(existsSync(marker), false);
      const written = await dispatcher.call({ id: "bridge-write", name: "file.write", args: { path: "notes.md", content: "local coding turn\n", overwrite: true } }, ctx);
      assert.equal(written.isError, false, JSON.stringify(written));
      const result = await dispatcher.call({ id: "bridge-complete", name: "coding_complete", args: { projectId, cardId } }, ctx);
      assert.equal(result.isError, false, JSON.stringify(result));
      completion = result.value as typeof completion;
      yield { type: "delta", text: "Done" };
    } }); },
  };
  const c = await openTurnComposition({ home, config: () => cfg, engine: {} as never,
    agents: createAgentRegistry({ config: () => cfg }, layout(home), log), logger: log,
    secrets: createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink() }),
    egress: { decide: async () => ({ allowed: false }) } as never,
    permissions: { current: () => ({ ...approvals.stores, service: approvals.service }), open: async () => ({ ...approvals.stores, service: approvals.service }) } as never,
    resolveCollaborationPerson: id => id === who.userId ? who : null,
    audit: memoryAuditSink(), identity, clock: Date.now, signal: new AbortController().signal,
    isStopping: () => false, notify() {}, options });
  try {
    assert.ok(c.collab);
    const project = c.collab.createProject(who, { name: "Bridge" }); projectId = project.id;
    for (const id of ["lead", "coder"]) c.collab.addAgent(who, projectId, id);
    c.collab.bindRepo(who, projectId, repo, "main");
    const root = c.collab.worktreeStore.liveWorktree(projectId, null)!;
    const card = c.collab.boardStore.createCard(projectId, { title: "Code", description: "Verify locally", columnId: c.collab.boardStore.columns(projectId)[0]!.id }, { kind: "person", id: who.userId }); cardId = card.id;
    c.collab.boardStore.assign(projectId, cardId, { kind: "agent", id: "coder" }, true, { kind: "person", id: who.userId });
    assert.equal(c.collab.worktreeStore.liveWorktree(projectId, cardId), null);
    if (!provisionCard) {
      const before = c.collab.boardStore.getCard(projectId, cardId);
      const worktrees = git("worktree", "list", "--porcelain").toString();
      const checkoutFiles = readdirSync(join(home, "state", "worktrees"), { recursive: true });
      const req = { sessionId: "missing-card-tree", agentId: "coder", projectId, authenticatedPerson: who.userId,
        principal: who.userId, summaries: [], memory: "", messages: [], signal: new AbortController().signal };
      assert.ok(toolsForTurn);
      const registry = await toolsForTurn(req);
      const ctx = { agentId: "coder", principal: who.userId, signal: req.signal, surface: 1 as const };
      const conflict = (message: string) => (error: unknown) => error instanceof RpcError
        && error.error === "E_CONFLICT" && error.message === message;
      await assert.rejects(registry.get("coding_complete")!.execute({ projectId, cardId }, ctx), conflict("bound coding worktree unavailable"));
      const methods = guardMethods({ "task.complete": c.surfaceMethods["task.complete"]! }, { now: Date.now, resolve: () => who });
      await assert.rejects(methods["task.complete"]!({ projectId, cardId }, { signal: req.signal } as never), conflict("bound coding worktree unavailable"));
      await assert.rejects(registry.get("request_review")!.execute({ projectId, cardId, toAgent: "lead", objective: "Review" }, ctx), conflict("review worktree unavailable"));
      assert.equal(c.collab.worktreeStore.liveWorktree(projectId, cardId), null);
      assert.equal(c.collab.worktreeStore.previousWorktree(projectId, cardId), null);
      assert.deepEqual(c.collab.worktreeStore.liveWorktree(projectId, null), root);
      assert.deepEqual(c.collab.boardStore.getCard(projectId, cardId), before);
      assert.equal(git("worktree", "list", "--porcelain").toString(), worktrees);
      assert.deepEqual(readdirSync(join(home, "state", "worktrees"), { recursive: true }), checkoutFiles);
      assert.equal(readFileSync(join(root.path, "notes.md"), "utf8"), "before\n");
      assert.equal(readFileSync(join(repo, "notes.md"), "utf8"), "before\n");
      assert.equal(seen, "");
      return;
    }
    new GitWorktreeProvisioner(c.collab.worktreeStore, join(home, "state")).fork({ projectId, cardId });
    const done = await c.collab.delegate({ principal: who, projectId, fromAgent: "lead", toAgent: "coder", task: "Code", acceptanceCriteria: "verified",
      handoff: {
        contract: { schema: "plur1bus.handoff/1", id: "ho_bridge", kind: "delegate", from: { agent: "lead", session: "session" }, to: { agent: "coder" },
          task: { id: "task", project: projectId, card: cardId }, objective: "Code", doneWhen: ["local change verified"],
          constraints: { must: [], mustNot: [], scope: { paths: ["**"], tools: [] } }, authority: { mayDecide: [], mustAsk: [], approvalsHeld: [] },
          budget: { tokens: 2000, toolCalls: 5, deadline: "2099-01-01T00:00:00Z", modelTier: "standard" },
          returnContract: { format: "plur1bus.return/1", maxTokens: 2000, outputSchema: { type: "string" }, citationsRequired: false } },
        context: { person: who.userId, taskId: "task", sessionId: "session", fromAgent: "lead", projectId,
          approvals: approvals.stores.approvals, grants: approvals.stores.grants, now: Date.now, audit() {} },
      } }).done;
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    assert.equal(seen, c.collab.worktreeStore.liveWorktree(projectId, cardId)!.path);
    assert.notEqual(seen, root.path);
    assert.equal(readFileSync(join(seen, "notes.md"), "utf8"), "local coding turn\n");
    assert.equal(readFileSync(join(root.path, "notes.md"), "utf8"), "before\n");
    assert.equal(completion?.verification.checks.length, 4);
    const expected = createHash("sha256").update(seen + "\n").digest("hex");
    for (const check of completion!.verification.checks) { assert.equal(check.ok, true); assert.equal(check.evidence, expected); }
    assert.equal(c.collab.boardStore.getCard(projectId, cardId).columnId, c.collab.boardStore.columns(projectId).find(col => col.titleKey === "project.board.done")!.id);
  } finally { await c.close(); identity.close(); approvals.service.dispose(); approvals.stores.db.close(); }
});
