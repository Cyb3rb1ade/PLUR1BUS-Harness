import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { AcpServer } from "../../src/acp/server.ts";
import { encodeLine, MAX_LINE_BYTES } from "../../src/acp/framing.ts";
import { ACP_ERROR, ACP_MAX_UPDATES, ACP_PROTOCOL_VERSION } from "../../src/acp/protocol.ts";
import { alsAgentScopePort, scopeFor } from "../../src/collab/scope.ts";
import { createCollab } from "../../src/collab/service.ts";
import { CollabStore } from "../../src/collab/store.ts";
import { composedAgentRunner } from "../../src/composition/collaboration.ts";
import { bindExternalOrigin, externalSubject } from "../../src/composition/external-agents.ts";
import { subjectForOrigin } from "../../src/composition/protocols.ts";
import { containedWrite } from "../../src/external-agents/containment.ts";
import { AcpClient, AcpClientError, type AcpClientHandlers } from "../../src/external-agents/acp-client.ts";
import { ExternalDelegationTarget } from "../../src/external-agents/delegation.ts";
import { acpMemoryExposure } from "../../src/external-agents/engine.ts";
import { LaunchError, launchExternalAgent } from "../../src/external-agents/launcher.ts";
import { GitWorktreeProvisioner } from "../../src/external-agents/provisioner.ts";
import { SessionStore } from "../../src/session/store.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { ToolDispatcher, type DispatchContext } from "../../src/tools/dispatcher.ts";
import { ToolRegistry, type ToolDef } from "../../src/tools/registry.ts";
import { lastNonce, rig as approvalRig, tick } from "../approvals/service-helpers.ts";
import { owner } from "../collab/helpers.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const handlers = (over: Partial<AcpClientHandlers> = {}): AcpClientHandlers => ({
  async readText() { return "ok"; },
  async writeText() {},
  async permission() { return { outcome: "cancelled" }; },
  async terminal() { return {}; },
  onUpdate() {},
  ...over,
});

function pipes() {
  const fromAgent = new PassThrough();
  const toAgent = new PassThrough();
  const lines: string[] = [];
  let buf = "";
  toAgent.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl >= 0) { lines.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); nl = buf.indexOf("\n"); }
  });
  return { fromAgent, toAgent, lines };
}

function client(p: ReturnType<typeof pipes>, over: Partial<AcpClientHandlers> = {}, forbiddenPayload?: readonly string[]) {
  return new AcpClient({ input: p.fromAgent, output: p.toAgent, handlers: handlers(over), ...(forbiddenPayload ? { forbiddenPayload } : {}) });
}

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("the client completes initialize and session/new against AcpServer", async () => {
  const cwd = tempDir("m6b-acp-loop-");
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const seen: string[] = [];
  const server = new AcpServer({
    input: c2s, output: s2c,
    backend: {
      async createSession() { return { sessionId: "ses_loop" }; },
      async prompt(_a, onUpdate) { onUpdate({ type: "text", text: "hello-from-agent" }); return { state: "completed" }; },
      async cancel() {},
    },
  });
  const done = server.run();
  const acp = new AcpClient({
    input: s2c, output: c2s, handlers: handlers({ onUpdate: (params) => seen.push(JSON.stringify(params)) }),
    forbiddenPayload: ["MEMORY-MARKER", "memoryExposure", JSON.stringify(acpMemoryExposure())],
  });
  assert.equal((await acp.initialize()).protocolVersion, ACP_PROTOCOL_VERSION);
  const id = await acp.newSession(cwd, []);
  assert.equal(id, "ses_loop");
  assert.equal((await acp.prompt(id, "ping")).stopReason, "end_turn");
  assert.ok(seen.some((line) => line.includes("hello-from-agent")));
  c2s.end();
  await done;
});

test("a different protocol version is refused", async () => {
  const p = pipes();
  const acp = client(p);
  const pending = acp.initialize();
  await until(() => p.lines.length > 0);
  const req = JSON.parse(p.lines[0]!) as { id: number };
  assert.equal(JSON.parse(p.lines[0]!).params.protocolVersion, 1);
  assert.equal(JSON.parse(p.lines[0]!).params.clientCapabilities.fs.readTextFile, true);
  assert.equal(JSON.parse(p.lines[0]!).params.clientCapabilities.terminal, true);
  p.fromAgent.write(encodeLine({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 2 } }));
  await assert.rejects(pending, (e: unknown) => e instanceof AcpClientError && e.reason === "protocol-version");
});

test("initialize and session/new carry no memory marker", async () => {
  const p = pipes();
  const acp = client(p, {}, ["MEMORY-MARKER", "memoryExposure", JSON.stringify(acpMemoryExposure())]);
  const pending = acp.initialize();
  await until(() => p.lines.length === 1);
  assert.equal(p.lines[0]!.includes("MEMORY-MARKER"), false);
  assert.equal(p.lines[0]!.includes("memoryExposure"), false);
  p.fromAgent.write(encodeLine({ jsonrpc: "2.0", id: JSON.parse(p.lines[0]!).id, result: { protocolVersion: 1 } }));
  await pending;
  await assert.rejects(() => acp.newSession("/tmp/MEMORY-MARKER"), (e: unknown) => e instanceof AcpClientError && e.reason === "payload-contained-memory");
  assert.equal(p.lines.length, 1);
});

test("unknown methods are -32601, unknown notifications are counted, and a stray result is ignored", async () => {
  const p = pipes();
  let stray = 0;
  const acp = new AcpClient({ input: p.fromAgent, output: p.toAgent, handlers: handlers(), log: (event) => { if (event === "unknown-response") stray += 1; } });
  p.fromAgent.write(encodeLine({ jsonrpc: "2.0", id: "m", method: "agent/evil", params: { path: "x" } }));
  p.fromAgent.write(encodeLine({ jsonrpc: "2.0", method: "session/not-a-real-update", params: {} }));
  p.fromAgent.write(encodeLine({ jsonrpc: "2.0", id: 404, result: { ok: true } }));
  await until(() => p.lines.length >= 1 && stray === 1 && acp.ignoredNotifications === 1);
  const error = JSON.parse(p.lines[0]!) as { error: { code: number } };
  assert.equal(error.error.code, ACP_ERROR.methodNotFound);
});

test("an update flood fails the prompt", async () => {
  const p = pipes();
  const acp = client(p);
  const pending = acp.prompt("s", "hi");
  await until(() => p.lines.length === 1);
  for (let i = 0; i < ACP_MAX_UPDATES + 1; i++) {
    p.fromAgent.write(encodeLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } }));
  }
  await assert.rejects(pending, (e: unknown) => e instanceof AcpClientError && e.reason === "update-limit");
});

test("an overlong line fails the open request", async () => {
  const p = pipes();
  const acp = client(p);
  const pending = acp.initialize();
  await until(() => p.lines.length === 1);
  p.fromAgent.write(Buffer.alloc(MAX_LINE_BYTES + 2, 0x61));
  p.fromAgent.write(Buffer.from("\n"));
  await assert.rejects(pending, (e: unknown) => e instanceof AcpClientError && e.reason === "line-too-long");
});

test("a path outside the worktree is not written", async () => {
  const root = tempDir("m6b-acp-path-");
  const work = join(root, "wt");
  const outside = join(root, "outside.txt");
  mkdirSync(work);
  const p = pipes();
  const acp = client(p, { writeText: (path, content) => containedWrite({ worktree: work, home: root }, path, content) });
  p.fromAgent.write(encodeLine({ jsonrpc: "2.0", id: 3, method: "fs/write_text_file", params: { path: outside, content: "nope" } }));
  await until(() => p.lines.length >= 1);
  const reply = JSON.parse(p.lines[0]!) as { error?: { code: number } };
  assert.equal(typeof reply.error?.code, "number");
  assert.equal(readOrNull(outside), null);
  acp.cancel("s");
});

test("the child process does not inherit a parent secret and Windows is refused", async () => {
  const cwd = tempDir("m6b-acp-env-");
  const previous = process.env.SUPER_SECRET;
  process.env.SUPER_SECRET = "hunter2";
  try {
    const handle = launchExternalAgent({ argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"], cwd, timeoutMs: 10_000 });
    let out = "";
    handle.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    await handle.exited;
    const env = JSON.parse(out) as Record<string, string>;
    assert.equal(env.SUPER_SECRET, undefined);
    assert.equal("P1B_SECRET" in env, false);
  } finally {
    if (previous === undefined) delete process.env.SUPER_SECRET;
    else process.env.SUPER_SECRET = previous;
  }
  assert.throws(() => launchExternalAgent({ argv: [process.execPath, "-e", ""], cwd, platform: "win32" }), (e: unknown) => e instanceof LaunchError && e.reason === "sandbox-unavailable");
  assert.throws(() => launchExternalAgent({ argv: ["/bin/bash", "-lc", "true"], cwd }), (e: unknown) => e instanceof LaunchError && e.reason === "argv");
});

test("a tool call in an acp-agent session is decided as subject acp-agent", async () => {
  const r = await approvalRig();
  const sessions = new SessionStore({ path: ":memory:" });
  const acp = sessions.createSession({ kind: "acp", agentId: "coder", owner: "u-owner", origin: "acp-agent" });
  const internal = sessions.createSession({ kind: "acp", agentId: "coder", owner: "u-owner" });
  bindExternalOrigin((id) => sessions.getSession(id)?.origin ?? null);
  try {
    assert.equal(subjectForOrigin("acp-agent"), "acp-agent");
    assert.equal(subjectForOrigin(null), "agent");
    assert.deepEqual(externalSubject({ sessionId: acp.id, agentId: "coder" }).subject?.kind, "acp-agent");
    assert.equal(externalSubject({ sessionId: internal.id, agentId: "coder" }).subject, undefined);
    const registry = new ToolRegistry();
    const tool: ToolDef = {
      name: "fs.read", description: "read", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } } },
      capability: "fs.read", effect: "read", risk: "low", trust: "first-party",
      classify: () => ({ targets: ["/outside/a.txt"], access: "read", flags: { outsideRoots: true, denyListHit: false } }),
      execute: async () => ({ content: "" }),
    };
    registry.register(tool);
    const dispatcher = new ToolDispatcher({
      registry, approvals: r.service, grants: r.stores.grants, clock: r.clock, timers: r.timers,
      policyContext: (ctx) => ({ ...r.service.policyContext()(ctx), ...externalSubject(ctx) }),
    });
    const ctx = (sessionId: string): DispatchContext => ({ agentId: "coder", principal: "u-owner", sessionId, surface: 3, signal: new AbortController().signal });
    const first = dispatcher.call({ id: "c1", name: "fs.read", args: { path: "/outside/a.txt" } }, ctx(acp.id));
    await tick();
    const row = r.service.list({ status: "pending" })[0];
    assert.ok(row);
    assert.equal(row!.subject.kind, "acp-agent");
    assert.equal(row!.subject.id, "coder");
    r.service.dispose();
    assert.equal((await first).isError, true);
  } finally {
    bindExternalOrigin(() => undefined);
    sessions.close();
    r.service.dispose();
  }
});

test("delegate_task runs the stub in the worktree, asks a person, and refuses an outside write", async () => {
  const root = tempDir("m6b-acp-delegate-");
  const home = join(root, "home");
  const repo = join(root, "repo");
  const outside = join(root, "outside.txt");
  mkdirSync(join(home, "state"), { recursive: true });
  gitInit(repo);
  const previous = process.env.SUPER_SECRET;
  process.env.SUPER_SECRET = "hunter2";
  const script = join(root, "stub.cjs");
  writeFileSync(script, stubSource(outside));
  const sessionStore = new SessionStore({ path: join(home, "state", "sessions.sqlite") });
  const approvals = await approvalRig();
  const who = owner({ kind: "person" });
  const target = new ExternalDelegationTarget({
    engineOf: (id) => id === "coder" ? { kind: "external", connector: "agy", maxTurns: 20, timeoutMs: 30_000 } : null,
    worktreeOf: (agentId, projectId) => provisioned.root(agentId, projectId, ""),
    home,
    sessions: () => sessionStore,
    approvals: async () => approvals.service,
    forbiddenPayload: ["MEMORY-MARKER"],
    connect: ({ cwd, signal, timeoutMs }) => {
      const handle = launchExternalAgent({ argv: [process.execPath, script], cwd, signal, timeoutMs });
      return { input: handle.stdout, output: handle.stdin, stop: handle.stop };
    },
  });
  let provisioned: { root(agentId: string, projectId: string, cardId: string): string | null } = { root: () => null };
  const collab = createCollab({
    path: join(home, "state", "collab.sqlite"), home,
    sessions: () => sessionStore,
    runner: composedAgentRunner(new FakeChatProvider(), alsAgentScopePort(), home, [target]),
  });
  const collabStore = new CollabStore({ path: join(home, "state", "collab.sqlite") });
  try {
    const project = collab.createProject(who, { name: "Auth rework" });
    collab.addAgent(who, project.id, "lead");
    collab.addAgent(who, project.id, "coder");
    collab.bindRepo(who, project.id, repo, "main");
    const fork = new GitWorktreeProvisioner(collabStore, join(home, "state")).fork({ projectId: project.id });
    provisioned = { root: () => fork.path };
    const handle = collab.delegate({ principal: who, projectId: project.id, fromAgent: "lead", toAgent: "coder", task: "write a note", acceptanceCriteria: "note exists" });
    const requested = await Promise.race([
      handle.done.then((task) => { throw new Error(task.error ?? task.status); }),
      waitEvent(approvals),
    ]);
    const row = approvals.service.get(requested.id);
    assert.equal(row?.subject.kind, "acp-agent");
    const decision = approvals.service.decide({ requestId: requested.id, nonce: requested.nonce, decision: "approve", person: who.userId, surface: 3 });
    assert.equal(decision.ok, true, JSON.stringify(decision));
    const task = await handle.done;
    assert.equal(task.status, "succeeded", `${task.error ?? ""}\n${task.result ?? ""}`);
    assert.equal(task.targetKind, "external");
    assert.match(task.result ?? "", /inside=ok/);
    const note = readFileSync(join(fork.path, "note.txt"), "utf8");
    assert.equal(note, "ok");
    assert.equal(readOrNull(outside), null);
    const transcript = sessionStore.listSessions({ owner: who.userId }).sessions.find((s) => s.origin === "acp-agent");
    assert.ok(transcript);
    const blob = sessionStore.listEvents(transcript!.id).map((e) => JSON.stringify(e.data)).join("\n");
    assert.match(blob, /mcp=0/);
    assert.match(blob, /marker=false/);
    assert.match(blob, /secret=no/);
    assert.match(blob, /outside=refused/);
    assert.match(blob, /term=0/);
    assert.ok(blob.includes(realpathSync(fork.path)) || blob.includes(fork.path));
    const trace = collab.listTraces(who, project.id)[0];
    assert.ok(trace);
    const replay = collab.replay(who, trace!.traceId, trace!.spans[0]!.spanId);
    assert.ok(replay.events.length > 0);
  } finally {
    if (previous === undefined) delete process.env.SUPER_SECRET;
    else process.env.SUPER_SECRET = previous;
    approvals.service.dispose();
    collab.close();
    collabStore.close();
    sessionStore.close();
  }
});

function waitEvent(r: Awaited<ReturnType<typeof approvalRig>>): Promise<{ id: string; nonce: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("approval was not requested")), 20_000);
    const poll = () => {
      const hit = [...r.events].reverse().find((e) => e.name === "approval.requested");
      if (hit) { clearTimeout(timer); resolve(lastNonce(r)); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function readOrNull(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });
}

function stubSource(outside: string): string {
  return `const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let marker = false;
const q = [];
let busy = false;
let wait = null;
rl.on("line", (line) => {
  if (line.includes("MEMORY-MARKER") || line.includes("memoryExposure")) marker = true;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method) { if (wait && msg.id === wait.id) { const w = wait; wait = null; w.resolve(msg); } return; }
  q.push(msg);
  drain();
});
function drain() {
  if (busy) return;
  const msg = q.shift();
  if (!msg) return;
  busy = true;
  Promise.resolve(handle(msg)).finally(() => { busy = false; drain(); });
}
function request(method, params) {
  const id = Math.floor(Math.random() * 1e9);
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => { wait = { id, resolve }; });
}
async function handle(msg) {
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  else if (msg.method === "session/new") {
    global.cwd = msg.params && msg.params.cwd;
    global.mcp = Array.isArray(msg.params && msg.params.mcpServers) ? msg.params.mcpServers.length : -1;
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "stub" } });
  } else if (msg.method === "session/prompt") {
    await request("session/request_permission", { sessionId: "stub", options: [{ optionId: "allow", kind: "allow_once", name: "allow" }] });
    const outside = await request("fs/write_text_file", { path: ${JSON.stringify(outside)}, content: "nope" });
    const inside = await request("fs/write_text_file", { path: "note.txt", content: "ok" });
    const created = await request("terminal/create", { command: "/usr/bin/true", args: [] });
    const id = created.result && created.result.terminalId;
    let term = created.error ? "err" : "missing";
    if (id) {
      await request("terminal/output", { terminalId: id });
      const waited = await request("terminal/wait_for_exit", { terminalId: id });
      term = waited.result ? String(waited.result.exitCode) : "err";
      await request("terminal/release", { terminalId: id });
    }
    const text = "cwd=" + global.cwd + " mcp=" + global.mcp + " marker=" + marker + " secret=" + (process.env.SUPER_SECRET ? "yes" : "no") + " outside=" + (outside.error ? "refused" : "wrote") + " inside=" + (inside.error ? "refused" : "ok") + " term=" + term;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "stub", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  } else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}
`;
}

