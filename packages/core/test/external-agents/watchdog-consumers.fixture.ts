/** No native process: exercise production consumers with a validated fd record and delayed exit metadata. */
import assert from "node:assert/strict";
import { lookupEvent, validateRecord } from "@plur1bus/log-schema";
import { mock } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { WatchdogDetailBuffer, type WatchdogDetail } from "../../src/external-agents/watchdog-detail.ts";
import type { LaunchHandle } from "../../src/external-agents/launcher.ts";
import { connectorArgv, CONNECTORS } from "../../src/external-agents/engine.ts";
import { SessionStore } from "../../src/session/store.ts";
import { runWithAgentScope, scopeFor } from "../../src/collab/scope.ts";

const detail: WatchdogDetail = { version: 1, cause: "task-info-unavailable", operation: "task-info", phase: "runtime",
  sample: 2, elapsedMicros: 1234, pid: 321, returned: 0, expected: 96, errno: 3, probeReturned: 0, probeErrno: 0,
  ppid: 123, pgid: 123, status: 5, startSeconds: 1700000000, startMicros: 500, processRssBytes: 0, count: 2, rssBytes: 1048576 };

function failedHandle(trusted: boolean, version = false, transportError = false): LaunchHandle {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const exitStatus: LaunchHandle["exitStatus"] = {};
  let finish!: (code: number) => void;
  const exited = new Promise<number | null>(resolve => { finish = resolve; });
  const fail = async () => {
    // A syntactically valid-looking stderr record must not become a trusted cause.
    stderr.end(JSON.stringify(detail) + "\nPRIVATE-CHILD-STDERR\n");
    if (transportError) stdout.destroy(Object.assign(new Error("PRIVATE-TRANSPORT-ERROR"), { detail }));
    else stdout.end();
    await tick(); // ACP closes before the actual helper close/metadata boundary.
    if (trusted) {
      const buffer = new WatchdogDetailBuffer();
      buffer.accept(Buffer.from(JSON.stringify(detail)));
      const parsed = buffer.finish();
      assert.ok(parsed);
      exitStatus.detail = parsed;
    }
    exitStatus.exitCode = 125;
    finish(125);
  };
  if (version) void tick().then(fail);
  else stdin.once("data", () => { void fail(); });
  return { stdin, stdout, stderr, pid: undefined, stop() {}, exited, exitStatus };
}

const mode = process.argv[2];
let trustedDiscovery = true;
let launchCalls = 0;
const launcher = await import("../../src/external-agents/launcher.ts");
mock.module(new URL("../../src/external-agents/launcher.ts", import.meta.url).href, { namedExports: {
  ...launcher,
  launchExternalAgent: async (o: { argv: string[] }) => { launchCalls++; return failedHandle(trustedDiscovery, o.argv.includes("--version")); },
} });
const { ExternalDelegationTarget, externalRunLink } = await import("../../src/external-agents/delegation.ts");
const { discoverConnectors } = await import("../../src/external-agents/discovery.ts");
const root = mkdtempSync(join(tmpdir(), "watchdog-consumers-"));
try {
  assert.deepEqual(CONNECTORS.map(connectorArgv), [null, null, null, null], "real connector argv stays disabled");
  if (mode === "connector") {
    for (const trusted of [true, false]) {
      const sessions = new SessionStore({ path: ":memory:" });
      const events: { event: string; fields?: Record<string, number | string> }[] = [];
      const handle = failedHandle(trusted, false, !trusted);
      const target = new ExternalDelegationTarget({ home: root, engineOf: () => ({ kind: "external", connector: "agy", timeoutMs: 5000, maxTurns: 1 }),
        worktreeOf: () => root, sessions: () => sessions, approvals: async () => null,
        connect: () => {
          const link = externalRunLink(handle); // The exact production adapter, without bypassing connectorArgv.
          assert.equal(link.exited, handle.exited);
          assert.equal(link.exitStatus, handle.exitStatus);
          return link;
        }, log: (event, fields) => events.push({ event, ...(fields ? { fields } : {}) }) });
      try {
        await assert.rejects(runWithAgentScope(scopeFor("worker", "project"), () => target.run({ agentId: "worker",
          principal: { kind: "person", userId: "owner", role: "owner" }, question: "Work", context: "", signal: new AbortController().signal })),
          { reason: trusted ? "closed" : "transport-error" });
        await handle.exited; await tick();
        assert.deepEqual(events, trusted ? [{ event: "sandbox.watchdog.failure", fields: { process: "connector", ...detail } }] : []);
        if (trusted) {
          const emitted = events[0]!;
          const entry = lookupEvent(emitted.event);
          assert.ok(entry, "the actual emitted event must be registered");
          assert.deepEqual(validateRecord({ ...entry.examples[0], attrs: emitted.fields }), { ok: true, entry });
        }
        assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
      } finally { sessions.close(); }
    }
    assert.equal(launchCalls, 0, "the existing connect seam does not enable a real connector");
  } else if (mode === "discovery") {
    const binDir = join(root, "bin"); mkdirSync(binDir);
    writeFileSync(join(binDir, "agy"), "fixture", { mode: 0o755 });
    for (const trusted of [true, false]) {
      trustedDiscovery = trusted;
      const found = await discoverConnectors({ home: root, pathEnv: binDir, platform: "linux" });
      assert.deepEqual(found.find(probe => probe.id === "agy"), {
        id: "agy", effort: "best-effort", bin: join(binDir, "agy"), version: null, protocol: "refused", reason: "closed",
        ...(trusted ? { diagnostics: { version: detail, initialize: detail } } : {}),
        login: [{ path: join(root, ".agy"), exists: false }, { path: join(root, ".gemini"), exists: false }],
      });
      assert.doesNotMatch(JSON.stringify(found), /PRIVATE/);
    }
    assert.equal(launchCalls, 4, "both probes consume the actual launch result in each case");
  } else assert.fail("unknown consumer fixture mode");
} finally { rmSync(root, { recursive: true, force: true }); }
