/** Handwritten agent-side v1 requests exercise real terminal containment and run cleanup. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runWithAgentScope, scopeFor } from "../../src/collab/scope.ts";
import { ExternalDelegationTarget } from "../../src/external-agents/delegation.ts";
import { readEngine } from "../../src/external-agents/engine.ts";
import { SessionStore } from "../../src/session/store.ts";
import { mountOptions, provisionFixture } from "./fixture.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("v1 terminals stream bounded output, enforce four slots, release and stop at run end; memory stays off wire", async () => {
  if (process.platform === "win32") return;
  const root = tempDir("q3-lifecycle-");
  const home = join(root, "home"), repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-m", "init"]);
  const worktree = provisionFixture(home, repo);
  const mount = mountOptions(worktree);
  const config = { agents: { worker: { engine: { kind: "external" as const, connector: "agy" as const, timeoutMs: 20000 }, persona: { prompt: "CONFIG-MEMORY-MARKER" } } } };
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const sessions = new SessionStore({ path: ":memory:" });
  const input = new PassThrough(), output = new PassThrough();
  const wire: string[] = [];
  const responses = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  let id = 0;
  const request = (method: string, params: object) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const key = `agent-${++id}`;
    responses.set(key, { resolve, reject });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params: { sessionId: "s", ...params } }) + "\n");
  });
  const reply = (id: unknown, result: unknown) => input.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const terminal = async (script: string) => String((await request("terminal/create", { command: process.execPath, args: ["-e", script], cwd: worktree, outputByteLimit: 32 })).terminalId);
  let failure: unknown;
  let leftover = "";
  const scenario = async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await terminal(`let n=0;setInterval(()=>{require('fs').writeFileSync('heartbeat-${i}',String(++n));process.stdout.write('x'.repeat(100))},20)`));
    await assert.rejects(terminal(""), /terminal-limit/);
    for (let i = 0; i < 100; i++) {
      const snapshot = await request("terminal/output", { terminalId: ids[0] });
      assert.equal(snapshot.exitStatus, undefined);
      if (snapshot.truncated) { assert.equal(Buffer.byteLength(String(snapshot.output)), 32); break; }
      if (i === 99) assert.fail("terminal did not stream");
      await delay(20);
    }
    await request("terminal/release", { terminalId: ids[0] });
    const count = readFileSync(join(worktree, "heartbeat-0"), "utf8");
    await delay(100);
    assert.equal(readFileSync(join(worktree, "heartbeat-0"), "utf8"), count);
    await assert.rejects(request("terminal/output", { terminalId: ids[0] }), /terminal/);
    const completed = await terminal("process.exit(7)");
    assert.deepEqual(await request("terminal/wait_for_exit", { terminalId: completed }), { exitCode: 7 });
    assert.deepEqual((await request("terminal/output", { terminalId: completed })).exitStatus, { exitCode: 7 });
    await request("terminal/release", { terminalId: completed });
    leftover = join(worktree, "heartbeat-1");
  };
  output.on("data", (data: Buffer) => {
    for (const line of data.toString().trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.method) wire.push(line);
      if (message.method === "initialize") reply(message.id, { protocolVersion: 1 });
      else if (message.method === "session/new") reply(message.id, { sessionId: "s" });
      else if (message.method === "session/prompt") void scenario().catch(error => { failure = error; }).finally(() => reply(message.id, { stopReason: "end_turn" }));
      else {
        const pending = responses.get(message.id);
        responses.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.data.reason));
        else pending?.resolve(message.result);
      }
    }
  });
  const target = new ExternalDelegationTarget({ home, engineOf: () => readEngine(config.agents.worker),
    worktreeOf: () => worktree, mountOf: () => mount.mount, limitsHelper: mount.limitsHelper,
    sessions: () => sessions, approvals: async () => null, policyContext: () => ({ overrides: { "shell.exec": "allowed" } }),
    connect: () => ({ input, output, stop() {} }) });
  try {
    await runWithAgentScope(scopeFor("worker", "project"), () => target.run({ agentId: "worker", question: "Code", context: "CONTEXT-MEMORY-MARKER", signal: new AbortController().signal }));
    if (failure) throw failure;
    assert.equal(wire.length, 3);
    assert.doesNotMatch(wire.join("\n"), /MEMORY-MARKER|memoryExposure/);
    const final = readFileSync(leftover, "utf8");
    await delay(100);
    assert.equal(readFileSync(leftover, "utf8"), final);
  } finally { sessions.close(); }
});
