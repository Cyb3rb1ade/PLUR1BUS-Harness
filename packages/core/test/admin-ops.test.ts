import { randomUUID } from "node:crypto";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { type CoreClient } from "@plur1bus/module-api";
import { connect } from "./helpers/connect.ts";
import { defaults } from "@plur1bus/config-schema";
import { validateResult } from "@plur1bus/rpc-schema";
import { ADMIN_METHODS, buildAdminMethods } from "../src/admin-ops.ts";
import type { AgentRegistry } from "../src/agents.ts";
import { createCore, type Core } from "../src/core.ts";
import type { HarnessLogger } from "../src/logger.ts";
import { layout } from "../src/paths.ts";
import { flatEmbedder, flatTestInternals } from "./helpers/flat-embedder.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };
const badCaller = { ...caller, userId: "u".repeat(129) };

function newHome(o: { legacyStore?: boolean } = {}): string {
  const home = tempDir("p1b-admin-");
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  if (o.legacyStore) {
    // A non-empty store without a schema marker predates the marker: the engine reads it as version "0".
    mkdirSync(layout(home).lancedb, { recursive: true });
    writeFileSync(join(layout(home).lancedb, "legacy.txt"), "written before the schema marker existed\n");
  }
  return home;
}

const rejectsWith = (error: string, reason?: string) => (e: any) => {
  assert.equal(e.error, error, `${e.error} ${e.reason}: ${e.message}`);
  if (reason !== undefined) assert.equal(e.reason, reason, e.message);
  return true;
};

async function valid<T>(method: string, p: Promise<T>): Promise<T> {
  const r = await p;
  assert.deepEqual(validateResult(method, r), { ok: true }, `${method}: ${JSON.stringify(r)}`);
  return r;
}

describe("admin ops (in-process core)", () => {
  const home = newHome();
  let core: Core; let c: CoreClient;
  before(async () => {
    core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  it("obsidian detect, prepare and confirm round trip", async () => {
    const vault = tempDir("p1b-vault-");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    writeFileSync(join(vault, ".obsidian", "app.json"), "{}");
    const base = { caller, agentId: "bernd" };

    const d1 = await valid("admin.obsidian.detect", c.call<any>("admin.obsidian.detect", { ...base, candidates: [vault] }));
    assert.equal(d1.agentId, "bernd");
    const cand = d1.vaults.find((v: any) => v.source === "candidate");
    assert.ok(cand, JSON.stringify(d1));
    assert.equal(cand.isVault, true); assert.equal(cand.confirmed, false);
    assert.ok(d1.vaults.some((v: any) => v.source === "workspace"), JSON.stringify(d1));

    const prep = await valid("admin.obsidian.prepare", c.call<any>("admin.obsidian.prepare", { ...base, vaultPath: cand.path }));
    assert.equal(typeof prep.nonce, "string"); assert.equal(prep.vaultPath, cand.path);
    assert.ok(prep.expiresAt > Date.now());

    const conf = await valid("admin.obsidian.confirm", c.call<any>("admin.obsidian.confirm", { ...base, nonce: prep.nonce }));
    assert.equal(conf.confirmed, true); assert.equal(conf.alreadyConfirmed, false);
    assert.equal(conf.vaultPath, cand.path); assert.equal(conf.vaultDigest, prep.vaultDigest);

    const d2 = await valid("admin.obsidian.detect", c.call<any>("admin.obsidian.detect", { ...base, candidates: [vault] }));
    assert.equal(d2.vaults.find((v: any) => v.source === "candidate")?.confirmed, true, JSON.stringify(d2));
    // The nonce is consumed by the first confirm.
    await assert.rejects(c.call("admin.obsidian.confirm", { ...base, nonce: prep.nonce }), rejectsWith("E_NOT_FOUND", "not-found"));
  });

  it("an unknown agent is E_AGENT_UNKNOWN", async () => {
    for (const [m, extra] of [["admin.obsidian.detect", {}], ["admin.obsidian.prepare", { vaultPath: "/nonexistent" }], ["admin.obsidian.confirm", { nonce: randomUUID() }]] as const) {
      await assert.rejects(c.call(m, { caller, agentId: "ghost", ...extra }), rejectsWith("E_AGENT_UNKNOWN", "not-registered"), m);
    }
  });

  it("a wrong nonce maps the engine's code", async () => {
    const base = { caller, agentId: "bernd" };
    await assert.rejects(c.call("admin.obsidian.confirm", { ...base, nonce: randomUUID() }), rejectsWith("E_NOT_FOUND", "not-found"));
    await assert.rejects(c.call("admin.obsidian.confirm", { ...base, nonce: "not-a-uuid" }), rejectsWith("E_INVALID_PARAMS", "invalid-input"));
  });

  it("prepare and confirm refuse an invalid caller identity; detect without candidates proceeds", async () => {
    await assert.rejects(c.call("admin.obsidian.prepare", { caller: badCaller, agentId: "bernd", vaultPath: home }), rejectsWith("E_DENIED", "principal-invalid"));
    await assert.rejects(c.call("admin.obsidian.confirm", { caller: badCaller, agentId: "bernd", nonce: randomUUID() }), rejectsWith("E_DENIED", "principal-invalid"));
    const d = await valid("admin.obsidian.detect", c.call<any>("admin.obsidian.detect", { caller: badCaller, agentId: "bernd" }));
    assert.equal(d.agentId, "bernd");
    // Probing caller-named paths needs a proved principal (engine): denied, not silently ignored.
    await assert.rejects(c.call("admin.obsidian.detect", { caller: badCaller, agentId: "bernd", candidates: [home] }), rejectsWith("E_DENIED", "denied"));
  });

  it("migrate from a version that is not current is E_CONFLICT", async () => {
    await assert.rejects(c.call("admin.migrate", { from: "0", to: "1" }), rejectsWith("E_CONFLICT", "conflict"));
  });

  it("migrate current to current answers applied false", async () => {
    const r = await valid("admin.migrate", c.call<any>("admin.migrate", { from: "1", to: "1" }));
    assert.deepEqual(r, { from: "1", to: "1", applied: false });
    await assert.rejects(c.call("admin.migrate", { from: "1", to: "9" }), rejectsWith("E_INVALID_PARAMS", "invalid-input"));
  });

  it("embedding.probe answers ok with 384 dimensions", async () => {
    const r = await valid("admin.embedding.probe", c.call<any>("admin.embedding.probe", {}));
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.identity.dimensions, 384);
    const again = await valid("admin.embedding.probe", c.call<any>("admin.embedding.probe", {}));
    assert.equal(again.cached, true);
    const fresh = await valid("admin.embedding.probe", c.call<any>("admin.embedding.probe", { refresh: true }));
    assert.equal(fresh.cached, false); assert.equal(fresh.ok, true);
  });

  it("embedding.serve null answers address null", async () => {
    const r = await valid("admin.embedding.serve", c.call<any>("admin.embedding.serve", { address: null }));
    assert.deepEqual(r, { address: null, tokenPath: null, identity: null });
  });

  it("a malformed address is E_INVALID_PARAMS", async () => {
    // A relative socket path (and, on Windows, a unix socket at all) is the engine's invalid-input.
    await assert.rejects(c.call("admin.embedding.serve", { address: { kind: "unix-socket", address: "relative/owner.sock" } }), rejectsWith("E_INVALID_PARAMS", "invalid-input"));
    // One the schema refuses never reaches the engine.
    await assert.rejects(c.call("admin.embedding.serve", { address: { kind: "unix-socket" } }), rejectsWith("E_INVALID_PARAMS"));
  });
});

describe("admin.migrate over a legacy store", () => {
  it("a migration is applied and core.status engine.storeSchema follows it", async () => {
    const home = newHome({ legacyStore: true });
    const core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      assert.deepEqual(core.status().engine.storeSchema, { current: "0", expected: "1" });
      const r = await valid("admin.migrate", c.call<any>("admin.migrate", { from: "0", to: "1" }));
      assert.deepEqual(r, { from: "0", to: "1", applied: true });
      assert.deepEqual(core.status().engine.storeSchema, { current: "1", expected: "1" });
    } finally { await c.close(); await core.stop({ budgetMs: 5000 }); }
  });
});

describe("admin.embedding.serve on the platform default address", () => {
  it("serves on the default address, idempotently, and a core stop removes the socket", async () => {
    // The default is <home>/state/lancedb/control/embedding-ipc/embedding.sock; darwin allows 103 bytes for a socket
    // path and its per-user tmpdir is long, so the home is made under /tmp there (Windows uses a named pipe).
    const base = process.platform === "win32" ? tmpdir() : "/tmp";
    const home = mkdtempSync(join(base, "p1b-sv-"));
    try {
      const cfg = defaults(); cfg.agents.bernd = {};
      cfg.engine = { reranker: { enabled: false }, dreaming: { enabled: false } };
      writeFileSync(layout(home).configPath, JSON.stringify(cfg));
      // The IPC server serves only a provider with a model identity (lib/providers/scoped-embedding-ipc.js: `model`,
      // `dimensions`), as the real providers have; the plain flat seam has none.
      const core = createCore({ home, testInternals: { embeddings: { ...flatEmbedder(), model: "flat-test", dimensions: 384 }, reranker: null } });
      await core.start();
      const c = await connect({ address: core.address, token: core.token });
      let address: { kind: string; address: string };
      try {
        const r = await valid("admin.embedding.serve", c.call<any>("admin.embedding.serve", {}));
        assert.ok(r.address, JSON.stringify(r));
        address = r.address;
        assert.equal(address.kind, process.platform === "win32" ? "named-pipe" : "unix-socket");
        assert.equal(r.identity?.dimensions, 384);
        assert.equal(typeof r.tokenPath, "string");
        if (address.kind === "unix-socket") {
          // The engine reports the canonical path: on darwin /tmp is a symlink to /private/tmp, so the home made as
          // /tmp/p1b-sv-… comes back as /private/tmp/p1b-sv-…. Compare canonical paths on both sides.
          const ipcDir = realpathSync(join(layout(home).lancedb, "control", "embedding-ipc"));
          assert.ok(existsSync(address.address), `socket ${address.address} exists`);
          assert.ok(realpathSync(address.address).startsWith(ipcDir + sep), `${address.address} is not under ${ipcDir}`);
        }
        const again = await valid("admin.embedding.serve", c.call<any>("admin.embedding.serve", {}));
        assert.deepEqual(again.address, address);
      } finally { await c.close(); await core.stop({ budgetMs: 5000 }); }
      if (address.kind === "unix-socket") assert.equal(existsSync(address.address), false, "the core's stop removes the socket");
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
});

describe("buildAdminMethods (fake engine)", () => {
  const agents = { list: () => ["bernd"], has: (id: string) => id === "bernd", scaffold: () => {}, workspaceOf: (id: string) => (id === "bernd" ? tempDir("p1b-admin-ws-") : null) } as unknown as AgentRegistry;
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as HarnessLogger;
  const identity = { fingerprintId: "fp", provider: "test", model: "flat", dimensions: 384 };
  const ctx = { signal: new AbortController().signal, connectionId: "c1" } as any;

  it("a stopping core refuses every admin method with core-stopping", async () => {
    const m = buildAdminMethods({ engine: {} as any, agents, logger, isStopping: () => true, onMigrated: () => {}, signal: new AbortController().signal });
    assert.deepEqual(Object.keys(m).sort(), [...ADMIN_METHODS].sort());
    for (const name of ADMIN_METHODS) {
      await assert.rejects((m[name] as any)({ caller, agentId: "bernd", from: "1", to: "1", nonce: "n", vaultPath: "/v" }, ctx), rejectsWith("E_CORE_UNAVAILABLE", "core-stopping"), name);
    }
  });

  it("the probe observes the core's shutdown signal; an abort while stopping is core-stopping", async () => {
    const shutdown = new AbortController();
    let stopping = false;
    let seen: AbortSignal | undefined;
    const engine = { embedding: { probe: async (o: { signal?: AbortSignal; refresh?: boolean }) => {
      seen = o.signal;
      await new Promise((res) => o.signal!.addEventListener("abort", res, { once: true }));
      return { ok: false, error: "aborted", cached: false, identity, durationMs: 0, checkedAt: 1 };
    } } } as any;
    const m = buildAdminMethods({ engine, agents, logger, isStopping: () => stopping, onMigrated: () => {}, signal: shutdown.signal });
    const p = (m["admin.embedding.probe"] as any)({ refresh: true }, ctx);
    await new Promise((r) => setImmediate(r));
    assert.ok(seen && !seen.aborted);
    stopping = true; shutdown.abort(new Error("core stopping"));
    await assert.rejects(p, rejectsWith("E_CORE_UNAVAILABLE", "core-stopping"));
  });

  it("results are projected onto the closed shapes; onMigrated runs only for an applied migration", async () => {
    let migrated = 0;
    const engine = {
      admin: { migrate: async (from: string, to: string) => ({ from, to, applied: from !== to, extra: 1 }) },
      embedding: {
        probe: async () => ({ ok: true, cached: false, identity: { ...identity, internal: true }, durationMs: 2, checkedAt: 3, provider: "leak" }),
        serve: async () => ({ address: { kind: "abstract-socket", address: "p1b", extra: 1 }, tokenPath: "/t", identity: { model: "flat", dimensions: 384, fingerprintId: "fp", x: 1 }, dispose() {} }),
      },
    } as any;
    const m = buildAdminMethods({ engine, agents, logger, isStopping: () => false, onMigrated: () => { migrated++; }, signal: new AbortController().signal });
    await valid("admin.migrate", (m["admin.migrate"] as any)({ from: "1", to: "1" }, ctx));
    assert.equal(migrated, 0);
    await valid("admin.migrate", (m["admin.migrate"] as any)({ from: "0", to: "1" }, ctx));
    assert.equal(migrated, 1);
    await valid("admin.embedding.probe", (m["admin.embedding.probe"] as any)({}, ctx));
    await valid("admin.embedding.serve", (m["admin.embedding.serve"] as any)({}, ctx));
  });
});
