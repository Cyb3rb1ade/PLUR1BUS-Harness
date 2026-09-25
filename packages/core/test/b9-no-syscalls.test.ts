// B9 / T3 (spec criterion 8, milestones M1 acceptance 10): 0 socket and 0 spawn calls during recall
// assembly. The cross-platform proxy for a syscall trace: every Node entry point that opens a socket or
// spawns a process is wrapped with a counter while one `memory.recall` runs through an in-process core.
//
// Limits of this proxy (it is not a kernel-level syscall trace):
// - Only the module-object functions listed in TARGETS are wrapped. `syncBuiltinESMExports()` makes ESM
//   named imports see the wrappers, but a CJS module that destructured a function before `patch()` ran
//   (`const { spawn } = require("node:child_process")` at load time) keeps the original and is not counted.
// - Native addons (e.g. LanceDB, onnxruntime) open sockets or threads below JavaScript and are invisible here.
// - `fetch`/undici, `http2`, `worker_threads` and `net.Socket#connect` on a pre-built Socket are not wrapped.
// - The flat-embedder seam is used, so no model loading or download path is exercised.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { connect, type CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { createCore, type Core } from "../src/core.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";

const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };

const TARGETS: Array<[string, Record<string, unknown>, string[]]> = [
  ["net", net as unknown as Record<string, unknown>, ["createConnection", "connect", "createServer"]],
  ["tls", tls as unknown as Record<string, unknown>, ["connect"]],
  ["child_process", childProcess as unknown as Record<string, unknown>, ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]],
  ["dgram", dgram as unknown as Record<string, unknown>, ["createSocket"]],
  ["http", http as unknown as Record<string, unknown>, ["request", "get"]],
  ["https", https as unknown as Record<string, unknown>, ["request", "get"]],
];

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "p1b-b9-"));
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 } };
  cfg.engine.duplicateThreshold = 1.01; // flat embedder: every vector is equal, see core.test.ts
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

describe("B9 — no socket or spawn calls during recall assembly", () => {
  const counts = new Map<string, number>();
  const originals: Array<[Record<string, unknown>, string, unknown]> = [];
  let core: Core; let c: CoreClient;
  const home = newHome();

  function patch(): void {
    for (const [mod, obj, names] of TARGETS) {
      for (const name of names) {
        const orig = obj[name] as (...a: unknown[]) => unknown;
        if (typeof orig !== "function") continue;
        const key = `${mod}.${name}`; counts.set(key, 0);
        originals.push([obj, name, orig]);
        obj[name] = function counted(this: unknown, ...args: unknown[]) { counts.set(key, (counts.get(key) ?? 0) + 1); return orig.apply(this, args); };
      }
    }
    syncBuiltinESMExports(); // named `import { spawn } from "node:child_process"` bindings see the wrapper too
  }
  function restore(): void {
    for (const [obj, name, orig] of originals.splice(0)) obj[name] = orig;
    syncBuiltinESMExports();
  }

  before(async () => {
    core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
    // Seed one fact and warm the store so the measured recall is a steady-state assembly.
    const cap = await c.call<any>("memory.capture", { caller, agentId: "bernd", sessionKey: "s1", messages: [{ role: "user", content: "Please remember that the roadmap review is on Thursday at ten." }, { role: "assistant", content: "Noted." }] });
    assert.ok(cap.stored >= 1, JSON.stringify(cap));
    await c.call("memory.recall", { caller, agentId: "bernd", sessionKey: "s0", query: "warm-up", joined: true });
  });
  after(async () => {
    restore();
    try { await c?.close(); await core?.stop({ budgetMs: 5000 }); }
    finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("one memory.recall over an open connection makes 0 socket/spawn calls", async () => {
    patch();
    let r: any;
    try { r = await c.call<any>("memory.recall", { caller, agentId: "bernd", sessionKey: "s2", query: "when is the roadmap review", joined: true }); }
    finally { restore(); }
    assert.equal(r.degraded, null, JSON.stringify(r.degraded));
    assert.match(r.joined.text, /roadmap review/i);
    const nonZero = [...counts].filter(([, n]) => n > 0);
    assert.ok(counts.size >= 15, `instrumented ${counts.size} entry points`);
    assert.deepEqual(nonZero, [], `socket/spawn calls during recall: ${JSON.stringify(nonZero)}`);
  });

  it("the counters are live (sanity: a wrapped spawn is counted)", () => {
    patch();
    try { childProcess.spawnSync(process.execPath, ["-e", ""]); }
    finally { restore(); }
    assert.equal(counts.get("child_process.spawnSync"), 1);
  });
});
