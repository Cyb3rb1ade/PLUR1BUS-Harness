/** The real launch boundary must refuse macOS before even a sandbox probe creates a process. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { lookupEvent, validateRecord } from "@plur1bus/log-schema";
import { launchExternalAgent, LaunchError } from "../../src/external-agents/launcher.ts";
import { containedTerminal } from "../../src/external-agents/containment.ts";
import { discoverConnectors } from "../../src/external-agents/discovery.ts";
import { wireExternalAgents } from "../../src/composition/external-agents.ts";
import { runWithAgentScope, scopeFor } from "../../src/collab/scope.ts";
import { ExternalDelegationTarget } from "../../src/external-agents/delegation.ts";
import { CollabError } from "../../src/collab/errors.ts";
import { SessionStore } from "../../src/session/store.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { mountOptions, provisionFixture } from "./fixture.ts";

const refusal = { reason: "sandbox-unavailable", cause: "macos-acceptance-pending" };

function forbidProcesses(t: TestContext, host: NodeJS.Platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: host });
  let attempts = 0;
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const)
    t.mock.method(childProcess, method, () => { attempts++; throw new Error("unexpected process creation"); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, "platform", descriptor); });
  return () => assert.equal(attempts, 0, "refusal must precede every process creation boundary");
}

for (const [host, platform] of [["darwin", undefined], ["darwin", "linux"], ["linux", "darwin"]] as const) {
  for (const kind of ["agent", "terminal", "discovery"] as const) test(`${kind}: macOS refuses without a process (host=${host}, override=${platform ?? "none"})`, async t => {
    const root = tempDir("acp-macos-policy-");
    const home = join(root, "home"), repo = join(root, "repo");
    mkdirSync(home); mkdirSync(repo);
    childProcess.execFileSync("git", ["-C", repo, "init", "-b", "main"], { stdio: "pipe" });
    childProcess.execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-m", "fixture"], { stdio: "pipe" });
    const worktree = provisionFixture(home, repo);
    const options = { home, worktree, cwd: worktree, ...mountOptions(worktree), ...(platform ? { platform } : {}) };
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), "PRIVATE-CREDENTIAL", { mode: 0 });
    writeFileSync(join(root, "agy"), "PRIVATE-EXECUTABLE", { mode: 0o755 });
    const refusal = { reason: "sandbox-unavailable", ...(host === "darwin" ? { cause: "macos-acceptance-pending" } : {}) };
    const noProcesses = forbidProcesses(t, host);
    try {
      if (kind === "agent") {
        for (const probe of [false, true]) await assert.rejects(launchExternalAgent({ ...options, argv: [process.execPath], probe }),
          (error: unknown) => error instanceof LaunchError && error.reason === refusal.reason && error.cause === refusal.cause);
      } else if (kind === "terminal") {
        const events: unknown[] = [];
        assert.deepEqual(await containedTerminal({ ...options, argv: [process.execPath], log: (event, fields) => events.push({ event, fields }) }), { ok: false, ...refusal });
        assert.deepEqual(events, host === "darwin" ? [{ event: "external.agent.refused", fields: { process: "terminal", ...refusal } }] : []);
      } else {
        const events: unknown[] = [];
        const results = await discoverConnectors({ ...options, pathEnv: root, log: (event, fields) => events.push({ event, fields }) });
        const found = results.find(row => row.id === "agy")!;
        assert.equal(found.protocol, "unprobed");
        assert.equal(found.version, null);
        assert.equal(found.reason, refusal.reason);
        assert.equal((found as { cause?: string }).cause, refusal.cause);
        assert.equal(results.find(row => row.id === "codex")?.login[0]?.exists, true);
        assert.doesNotMatch(JSON.stringify(results), /PRIVATE/);
        assert.deepEqual(events, host === "darwin" ? [{ event: "external.agent.refused", fields: { process: "discovery", ...refusal } }] : []);
      }
    } finally { noProcesses(); }
  });
}

test("the composed Core target logs the bounded macOS refusal cause", async t => {
  const root = tempDir("acp-macos-core-");
  const sessions = new SessionStore({ path: ":memory:" });
  t.after(() => sessions.close());
  const events: { event: string; fields?: Record<string, number | string> }[] = [];
  const options: Parameters<typeof wireExternalAgents>[1] = { projectWorktrees: { root: () => root } };
  wireExternalAgents({ home: root, config: () => ({ agents: { worker: { engine: { kind: "external", connector: "agy" } } } }),
    agents: { workspaceOf: () => root }, permissions: { current: () => null, open: async () => { throw new Error("must not open approvals"); } },
    logger: { info: (event, fields) => events.push({ event, ...(fields ? { fields } : {}) }) } }, options,
  () => ({ store: sessions }), () => { throw new Error("must not prepare a mount"); });
  const noProcesses = forbidProcesses(t, "darwin");
  await assert.rejects(runWithAgentScope(scopeFor("worker", "project"), () => options.delegationTargets![0]!.run({ agentId: "worker",
    question: "Work", context: "", signal: new AbortController().signal })), { reason: "sandbox-unavailable" });
  assert.deepEqual(events, [{ event: "external.agent.refused", fields: { process: "connector", ...refusal } }]);
  const entry = lookupEvent(events[0]!.event);
  assert.ok(entry, "the emitted Core event must have a bounded catalogue schema");
  assert.deepEqual(validateRecord({ ...entry.examples[0], attrs: events[0]!.fields }), { ok: true, entry });
  noProcesses();
});

for (const host of ["darwin", "win32"] as const) test(`${host}: delegation rejects before every dependency even with connect installed`, async t => {
  const sessions = new SessionStore({ path: ":memory:" });
  t.after(() => sessions.close());
  const calls: string[] = [], events: unknown[] = [];
  const unexpected = (name: string): never => { calls.push(name); throw new Error(`unexpected ${name}`); };
  const target = new ExternalDelegationTarget({ home: "/missing-home",
    engineOf: () => unexpected("engine"), worktreeOf: () => unexpected("worktree/provisioner"),
    mountOf: () => unexpected("mount"), sessions: () => { calls.push("sessions"); return sessions; },
    approvals: async () => unexpected("approvals"), connect: () => unexpected("connect"),
    log: (event, fields) => events.push({ event, fields }) });
  const noProcesses = forbidProcesses(t, host);
  const expected = { reason: "sandbox-unavailable", ...(host === "darwin" ? { cause: "macos-acceptance-pending" } : {}) };
  // No scope and an already-aborted signal: platform refusal must be the first production step.
  for (const signal of [AbortSignal.abort(), new AbortController().signal]) await assert.rejects(target.run({ agentId: "worker", question: "Work", context: "", signal }),
    (error: unknown) => error instanceof CollabError && error.reason === expected.reason && error.cause === expected.cause);
  assert.deepEqual(calls, []);
  assert.deepEqual(sessions.listSessions({ owner: "external:worker" }).sessions, []);
  assert.deepEqual(events, host === "darwin" ? [1, 2].map(() => ({ event: "external.agent.refused", fields: { process: "connector", ...expected } })) : []);
  noProcesses();
});
