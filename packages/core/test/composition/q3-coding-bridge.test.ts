/** The production composition owns provisioning, the local runner and coding_complete. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { ToolDispatcher } from "../../src/tools/dispatcher.ts";
import { rig } from "../approvals/service-helpers.ts";
import { owner } from "../collab/helpers.ts";
import { limitsHelper } from "../external-agents/fixture.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("production bind → local coding delegation → coding_complete uses its lazy card tree and real verifier", async () => {
  if (process.platform === "win32") return; // The native coding verifier currently has no Windows backend.
  const dir = tempDir("q3-composition-"), home = join(dir, "home"), repo = join(dir, "repo");
  const cfg = defaults(); cfg.agents.lead = {}; cfg.agents.coder = {};
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; }, async close() {} } as never;
  for (const id of ["lead", "coder"]) mkdirSync(join(home, "agents", id, "workspace"), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true }); copyFileSync(limitsHelper, join(home, "bin", "plur1bus-sandbox-limits"));
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
  const options: NonNullable<CompositionDeps["options"]> = {
    providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() {} } }] } },
    createTurnProvider: o => ({ id: "fixture", telemetry: {} as never, async *stream(req) {
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
      const written = await dispatcher.call({ id: "bridge-write", name: "file.write", args: { path: "notes.md", content: "local coding turn\n", overwrite: true } }, ctx);
      assert.equal(written.isError, false, JSON.stringify(written));
      const result = await dispatcher.call({ id: "bridge-complete", name: "coding_complete", args: { projectId, cardId } }, ctx);
      assert.equal(result.isError, false, JSON.stringify(result));
      completion = result.value as typeof completion;
      yield { type: "delta", text: "Done" };
    } }),
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
