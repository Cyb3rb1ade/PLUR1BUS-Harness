/** Production configuration reaches each terminal through wireExternalAgents. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CollabStore } from "../../src/collab/store.ts";
import { runWithAgentScope, scopeFor } from "../../src/collab/scope.ts";
import type { DelegationTarget } from "../../src/collab/target.ts";
import { wireExternalAgents } from "../../src/composition/external-agents.ts";
import { ExternalDelegationTarget } from "../../src/external-agents/delegation.ts";
import { GitWorktreeProvisioner } from "../../src/external-agents/provisioner.ts";
import { SessionStore } from "../../src/session/store.ts";
import { lastNonce, rig } from "../approvals/service-helpers.ts";
import { owner } from "../collab/helpers.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { limitsHelper } from "./fixture.ts";

test("live tools.sandbox.maxTasks=2 reaches wired ACP terminal containment", async () => {
  if (process.platform === "win32") return;
  const temp = tempDir("q3-config-");
  const home = join(temp, "home");
  const state = join(home, "state"), repo = join(temp, "repo");
  mkdirSync(state, { recursive: true }); mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-m", "init"]);
  const collab = new CollabStore({ path: join(state, "collab.sqlite") });
  const project = collab.createProject({ name: "Limits", owner: "u-owner" });
  collab.setRepo(project.id, { repoPath: repo, baseBranch: "main" });
  new GitWorktreeProvisioner(collab, state).fork({ projectId: project.id });
  const sessions = new SessionStore({ path: ":memory:" });
  const approvals = await rig();
  const who = owner({ kind: "person" });
  const config = { tools: { sandbox: { maxTasks: 2 } }, agents: { worker: { engine: { kind: "external" as const, connector: "agy" as const, timeoutMs: 20000 } } } };
  const input = new PassThrough(), output = new PassThrough();
  const pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  let sequence = 0, failure: unknown;
  const request = (method: string, params: object) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = `a-${++sequence}`;
    pending.set(id, { resolve, reject });
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const create = async (command: string, args: string[]) => {
    const timer = setInterval(() => {
      if (!approvals.service.list({ status: "pending" }).length) return;
      const nonce = lastNonce(approvals);
      assert.equal(approvals.service.decide({ requestId: nonce.id, nonce: nonce.nonce, decision: "approve", person: who.userId, surface: 3 }).ok, true);
    }, 10);
    try { return String((await request("terminal/create", { command, args, outputByteLimit: 8192 })).terminalId); }
    finally { clearInterval(timer); }
  };
  const scenario = async () => {
    if (process.platform === "darwin") {
      const terminalId = await create("/usr/bin/perl", ["-e", "for(1..4){if(fork()==0){sleep 2;exit 0}}sleep 2"]);
      await assert.rejects(request("terminal/wait_for_exit", { terminalId }), /task-limit-exceeded/);
    } else {
      const terminalId = await create("/usr/bin/cat", ["/proc/self/limits"]);
      assert.equal((await request("terminal/wait_for_exit", { terminalId })).exitCode, 0);
      const result = await request("terminal/output", { terminalId });
      assert.match(String(result.output), /Max processes\s+3\s+3/); // two target tasks plus bwrap's init
    }
    config.tools.sandbox.maxTasks = 0;
    const terminalId = await create("/usr/bin/true", []);
    await assert.rejects(request("terminal/wait_for_exit", { terminalId }), /sandbox-unavailable/);
  };
  const reply = (id: unknown, result: unknown) => input.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  output.on("data", data => {
    for (const line of String(data).trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.method === "initialize") reply(message.id, { protocolVersion: 1 });
      else if (message.method === "session/new") reply(message.id, { sessionId: "s" });
      else if (message.method === "session/prompt") void scenario().catch(error => { failure = error; }).finally(() => reply(message.id, { stopReason: "end_turn" }));
      else {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request?.reject(new Error(message.error.data.reason)); else request?.resolve(message.result);
      }
    }
  });
  const options: { delegationTargets?: readonly DelegationTarget[] } = {};
  wireExternalAgents({ home, config: () => config, agents: { workspaceOf: () => null },
    permissions: { current: () => ({ service: approvals.service }), open: async () => ({ service: approvals.service }) }, logger: { info() {} } },
  options, () => ({ store: sessions }), () => collab,
  deps => new ExternalDelegationTarget({ ...deps, limitsHelper, connect: () => ({ input, output, stop() {} }) }));
  try {
    await runWithAgentScope(scopeFor("worker", project.id), () => options.delegationTargets![0]!.run({ agentId: "worker", principal: who,
      question: "Check limit", context: "", signal: new AbortController().signal }));
    if (failure) throw failure;
  } finally { approvals.service.dispose(); approvals.stores.db.close(); sessions.close(); collab.close(); }
});


test("configured ACP deadlines above ten minutes are preserved and bounded at one hour", async t => {
  if (process.platform === "win32") return;
  const { readEngine } = await import("../../src/external-agents/engine.ts");
  const { launchExternalAgent } = await import("../../src/external-agents/launcher.ts");
  assert.equal(readEngine({ engine: { kind: "external", connector: "agy", timeoutMs: 1800000 } })?.connector, "agy");
  assert.deepEqual(readEngine({ engine: { kind: "external", connector: "agy", timeoutMs: 3600001 } }), { kind: "external", connector: null });
  const cwd = tempDir("q3-timeout-");
  await assert.rejects(launchExternalAgent({ argv: ["/usr/bin/sleep", "3600"], cwd, probe: true, timeoutMs: 3600001 }), /sandbox-unavailable/);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handle = await launchExternalAgent({ argv: ["/usr/bin/sleep", "3600"], cwd, probe: true, limitsHelper, timeoutMs: 1800000 });
  try {
    t.mock.timers.tick(600001);
    assert.equal(handle.exitStatus.reason, undefined);
    t.mock.timers.tick(1199999);
    assert.equal(handle.exitStatus.reason, "timeout");
    t.mock.timers.tick(100);
    await handle.exited;
  } finally { handle.stop(); t.mock.timers.tick(100); await handle.exited; }
});
