import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { layout } from "../../../src/paths.ts";
import { buildEngineConfig } from "../../../src/engine-config.ts";
import { createTempHost } from "../../../src/import/importers/hermes-stores.ts";
import { tempDir } from "../../helpers/temp-dir.ts";
import { flatTestInternals } from "../../helpers/flat-embedder.ts";
import { buildMethods } from "../../../src/rpc/methods.ts";
import { guardMethods } from "../../../src/rbac/guard.ts";
import { RpcError } from "../../../src/rpc/errors.ts";
import type { CallContext } from "../../../src/rpc/server.ts";
import type { Principal } from "../../../src/rbac/types.ts";
import { callerToPrincipal } from "../../../src/principal.ts";
import { deriveUserPrincipal } from "../../../src/identity/principals.ts";

const timeout = 120_000;

async function withEngine<T>(
  home: string,
  fn: (
    e: ReturnType<typeof createEngine>,
    l: ReturnType<typeof layout>,
    agents: { list(): string[]; has(id: string): boolean; workspaceOf(id: string): string | undefined; defaultAgentId(): string },
  ) => Promise<T>,
): Promise<T> {
  const l = layout(home);
  mkdirSync(l.workspaceDir("default"), { recursive: true });
  mkdirSync(l.workspaceDir("second"), { recursive: true });
  const engine = createEngine(
    createTempHost(l.state, async (id: string) => l.workspaceDir(id)),
    buildEngineConfig(defaults(), l) as any,
    { internals: flatTestInternals() },
  );
  engine.channels.register("cli");
  const agents = {
    list: () => ["default", "second"],
    has: (id: string) => id === "default" || id === "second",
    workspaceOf: (id: string) => l.workspaceDir(id),
    defaultAgentId: () => "default",
  };
  try {
    return await fn(engine, l, agents);
  } finally {
    await engine.close({ budgetMs: 5_000 });
  }
}

function setupTestMethods(
  home: string,
  engine: any,
  agents: any,
  getPrincipal: () => Principal,
) {
  const raw = buildMethods({
    config: () => defaults(),
    agents: agents as any,
    engine,
    isStopping: () => false,
    hostEvalHome: home,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as any,
  } as any);

  const guarded = guardMethods(raw, {
    resolve: async () => getPrincipal(),
    now: () => Date.now(),
  });

  return {
    apply: async (p: any, ctx: CallContext): Promise<any> => {
      const h = guarded["memory.importText.apply"];
      if (!h) throw new Error("memory.importText.apply handler missing");
      return await h(p, ctx);
    },
    rollback: async (p: any, ctx: CallContext): Promise<any> => {
      const h = guarded["memory.importText.rollback"];
      if (!h) throw new Error("memory.importText.rollback handler missing");
      return await h(p, ctx);
    },
    export: async (p: any, ctx: CallContext): Promise<any> => {
      const h = guarded["memory.exportText"];
      if (!h) throw new Error("memory.exportText handler missing");
      return await h(p, ctx);
    },
  };
}

describe("Prompt Import & Export against Real Engine (Production Path)", { timeout }, () => {
  it("imports across multiple agents without principal mismatch (N2) and verifies recall", async () => {
    const home = tempDir("p-real-engine-n2-");
    await withEngine(home, async (engine, _l, agents) => {
      let activePrincipal: Principal = { userId: "user-1", role: "admin", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-n2", connectionId: "c-n2", signal: new AbortController().signal };

      // Apply batch containing cards for both default and second agent, plus user scope
      const applyResult = await methods.apply(
        {
          entries: [
            {
              category: "Preferences",
              sourceType: "memory",
              text: "Prefers concise terminal responses.",
              warnings: [],
              idempotencyKey: "pref-1",
            },
            {
              category: "Projects",
              sourceType: "memory",
              text: "Default agent project card.",
              warnings: [],
              idempotencyKey: "proj-default",
            },
            {
              category: "Projects",
              sourceType: "memory",
              text: "Second agent project card.",
              warnings: [],
              idempotencyKey: "proj-second",
            },
          ],
          targets: [
            { target: "user" },
            { target: "agent", agentIds: ["default"] },
            { target: "agent", agentIds: ["second"] },
          ],
        },
        ctx,
      ) as { imported: number; linked: number; skipped: number; runId: string };

      // N2 check: must succeed without throwing "agentId does not match the operator"
      assert.equal(applyResult.imported, 3, "all 3 cards must be imported across default and second agent");
      assert.equal(applyResult.skipped, 0);

      // Verify report recorded both affected agents and importedBy (N4)
      const reportPath = join(home, "imports", applyResult.runId, "report.json");
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.equal(report.status, "completed");
      assert.equal(report.importedBy, "user-1");
      assert.ok(report.affectedAgents.includes("default"));
      assert.ok(report.affectedAgents.includes("second"));

      // Test rollback across multiple agents (N3 & N4)
      // Foreign admin B has imports.manage but cannot roll back user-1's run (N4)
      activePrincipal = { userId: "admin-b", role: "admin", kind: "person" };
      await assert.rejects(
        async () => {
          await methods.rollback({ runId: applyResult.runId }, ctx);
        },
        (err: any) => err instanceof RpcError && err.error === "E_DENIED" && err.reason === "foreign-import-run",
        "foreign admin must not roll back another user's import run",
      );

      // Author user-1 can roll back
      activePrincipal = { userId: "user-1", role: "admin", kind: "person" };
      const rbResult = await methods.rollback(
        { runId: applyResult.runId },
        ctx,
      ) as { rolledBack: number; failed: number; remaining: number; keptModified: number };

      assert.equal(rbResult.rolledBack, 3, "all 3 cards unimported across agents");
      assert.equal(rbResult.failed, 0);
      assert.equal(rbResult.remaining, 0);
      assert.equal(rbResult.keptModified, 0);

      const reportAfterRb = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.equal(reportAfterRb.status, "rolled-back");

      // Second rollback refused (B6)
      await assert.rejects(
        async () => {
          await methods.rollback({ runId: applyResult.runId }, ctx);
        },
        (err: any) => err instanceof RpcError && err.error === "E_CONFLICT" && err.reason === "already-rolled-back",
      );
    });
  });

  it("exports > 100 cards across scopes using backward paging without truncation (N1)", async () => {
    const home = tempDir("p-real-engine-n1-paging-");
    await withEngine(home, async (engine, _l, agents) => {
      const activePrincipal: Principal = { userId: "user-export", role: "owner", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-n1", connectionId: "c-n1", signal: new AbortController().signal };

      // Generate 125 cards with distinct timestamps
      const baseTime = 1_700_000_000_000;
      const entries: any[] = [];
      const targets: any[] = [];
      for (let i = 0; i < 125; i++) {
        entries.push({
          category: i % 2 === 0 ? "Preferences" : "Projects",
          sourceType: "memory",
          text: `Portable memory entry number ${i} with distinct text and timestamp.`,
          recordedAt: new Date(baseTime + i * 1000).toISOString(),
          warnings: [],
          idempotencyKey: `entry-${i}`,
        });
        targets.push(i % 2 === 0 ? { target: "user" } : { target: "agent", agentIds: ["default"] });
      }

      const applyRes = await methods.apply({ entries, targets }, ctx);
      assert.equal(applyRes.imported, 125);

      // Export memories for default agent (includes user-scope and default agent-private)
      const exportRes = await methods.export({ agentId: "default" }, ctx) as {
        text: string;
        entryCount: number;
      };

      // N1 check: all 125 cards must be exported and output ends with STATUS: COMPLETE
      assert.ok(exportRes.text.endsWith("STATUS: COMPLETE\n"), "export must conclude with STATUS: COMPLETE");
      assert.equal(exportRes.entryCount, 125, "all 125 cards must be exported without truncation");
      for (let i = 0; i < 125; i++) {
        assert.ok(
          exportRes.text.includes(`Portable memory entry number ${i}`),
          `export must include card ${i}`,
        );
      }
    });
  });

  it("imports 130 undated cards with distinct timestamps and exports completely without truncation (R1)", async () => {
    const home = tempDir("p-real-engine-r1-undated-");
    await withEngine(home, async (engine, _l, agents) => {
      const activePrincipal: Principal = { userId: "user-undated", role: "owner", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-r1", connectionId: "c-r1", signal: new AbortController().signal };

      // 130 undated entries (e.g. typical ChatGPT memory export)
      const entries: any[] = [];
      const targets: any[] = [];
      for (let i = 0; i < 130; i++) {
        entries.push({
          category: "Preferences",
          sourceType: "memory",
          text: `Undated memory card number ${i}.`,
          warnings: [],
          idempotencyKey: `undated-${i}`,
        });
        targets.push({ target: "user" });
      }

      const applyRes = await methods.apply({ entries, targets }, ctx);
      assert.equal(applyRes.imported, 130);

      // Export must page backwards across the 130 cards and return STATUS: COMPLETE without truncation error
      const exportRes = await methods.export({}, ctx) as {
        text: string;
        entryCount: number;
      };

      assert.ok(exportRes.text.endsWith("STATUS: COMPLETE\n"), "export must finish with STATUS: COMPLETE");
      assert.equal(exportRes.entryCount, 130, "all 130 undated cards must be present");
      assert.ok(exportRes.text.includes("[unknown] [memory] - Undated memory card number 0"));
      assert.ok(exportRes.text.includes("[unknown] [memory] - Undated memory card number 129"));
    });
  });

  it("clamps future-dated cards to now on import and exports without dropping any cards (R2)", async () => {
    const home = tempDir("p-real-engine-r2-future-");
    await withEngine(home, async (engine, _l, agents) => {
      const activePrincipal: Principal = { userId: "user-future", role: "owner", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-r2", connectionId: "c-r2", signal: new AbortController().signal };

      const entries = [
        {
          category: "Preferences",
          sourceType: "memory",
          text: "Memory from 2024 past.",
          recordedAt: "2024-06-01T00:00:00.000Z",
          warnings: [],
          idempotencyKey: "date-past",
        },
        {
          category: "Preferences",
          sourceType: "memory",
          text: "Memory from 2099 future.",
          recordedAt: "2099-01-01T00:00:00.000Z",
          warnings: [],
          idempotencyKey: "date-future",
        },
      ];
      const targets = [{ target: "user" }, { target: "user" }];

      const applyRes = await methods.apply({ entries, targets }, ctx);
      assert.equal(applyRes.imported, 2);

      const exportRes = await methods.export({}, ctx) as {
        text: string;
        entryCount: number;
      };

      assert.ok(exportRes.text.endsWith("STATUS: COMPLETE\n"), "export must finish with STATUS: COMPLETE");
      assert.equal(exportRes.entryCount, 2, "neither card should be dropped");
      assert.ok(exportRes.text.includes("Memory from 2024 past"));
      assert.ok(exportRes.text.includes("Memory from 2099 future"));
    });
  });

  it("owner rollback override on foreign run unimports agent cards but preserves foreign user cards (R3)", async () => {
    const home = tempDir("p-real-engine-r3-owner-");
    await withEngine(home, async (engine, _l, agents) => {
      let activePrincipal: Principal = { userId: "admin-a", role: "admin", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-r3", connectionId: "c-r3", signal: new AbortController().signal };

      // Admin A imports 1 user-scope card and 1 agent-private card
      const applyRes = await methods.apply({
        entries: [
          {
            category: "Preferences",
            sourceType: "memory",
            text: "Admin A personal preference to keep.",
            warnings: [],
            idempotencyKey: "user-admin-a",
          },
          {
            category: "Projects",
            sourceType: "memory",
            text: "Shared project task on default agent.",
            warnings: [],
            idempotencyKey: "proj-agent",
          },
        ],
        targets: [
          { target: "user" },
          { target: "agent", agentIds: ["default"] },
        ],
      }, ctx);
      assert.equal(applyRes.imported, 2);

      // Owner B rolls back Admin A's foreign run: agent card unimported, Admin A's user card preserved
      activePrincipal = { userId: "owner-b", role: "owner", kind: "person" };
      const rbRes = await methods.rollback({ runId: applyRes.runId }, ctx);
      assert.equal(rbRes.rolledBack, 1, "agent card should be rolled back");
      assert.equal(rbRes.preservedUserScope, 1, "foreign user-scope card must be preserved and counted separately");
      assert.equal(rbRes.keptModified, 0, "keptModified is only for cards modified after the import");
      assert.equal(rbRes.failed, 0);
      assert.equal(rbRes.remaining, 0);
      const report = JSON.parse(readFileSync(join(home, "imports", applyRes.runId, "report.json"), "utf8"));
      assert.equal(report.status, "partial", "the importer must still be able to roll the run back");

      // Admin A still possesses their user-scope card
      activePrincipal = { userId: "admin-a", role: "admin", kind: "person" };
      const exportRes = await methods.export({}, ctx) as { text: string; entryCount: number };
      assert.ok(exportRes.text.includes("Admin A personal preference to keep"), "Admin A user card must remain");

      // ... and can now roll back their own run, which removes it
      const own = await methods.rollback({ runId: applyRes.runId }, ctx);
      assert.equal(own.failed, 0);
      assert.equal(own.remaining, 0);
      assert.equal(own.preservedUserScope, 0);
      const after = JSON.parse(readFileSync(join(home, "imports", applyRes.runId, "report.json"), "utf8"));
      assert.equal(after.status, "rolled-back");
      const exportAfter = await methods.export({}, ctx) as { text: string };
      assert.ok(!exportAfter.text.includes("Admin A personal preference to keep"));
    });
  });

  it("handles real unimport failure to produce partial status and permits retry without editing report.json (N3)", async () => {
    const home = tempDir("p-real-engine-n3-retry-");
    await withEngine(home, async (engine, _l, agents) => {
      const activePrincipal: Principal = { userId: "user-rb", role: "owner", kind: "person" };
      let failOnce = true;
      const wrappedMemory = new Proxy({} as any, {
        get(_target, prop) {
          if (prop === "unimport") {
            return async (req: any, p: any, a: any) => {
              if (failOnce && req.agentId === "second") {
                failOnce = false;
                throw new Error("simulated unimport lock-busy failure on second agent");
              }
              return await engine.memory.unimport(req, p, a);
            };
          }
          const val = (engine.memory as any)[prop];
          return typeof val === "function" ? val.bind(engine.memory) : val;
        },
      });
      const wrappedEngine = new Proxy({} as any, {
        get(_target, prop) {
          if (prop === "memory") return wrappedMemory;
          const val = (engine as any)[prop];
          return typeof val === "function" ? val.bind(engine) : val;
        },
      });

      const methods = setupTestMethods(home, wrappedEngine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-rb", connectionId: "c-rb", signal: new AbortController().signal };

      // Apply batch touching both default and second agent
      const applyRes = await methods.apply(
        {
          entries: [
            {
              category: "Projects",
              sourceType: "memory",
              text: "Default agent project task.",
              warnings: [],
              idempotencyKey: "proj-retry-default",
            },
            {
              category: "Projects",
              sourceType: "memory",
              text: "Second agent project task.",
              warnings: [],
              idempotencyKey: "proj-retry-second",
            },
          ],
          targets: [
            { target: "agent", agentIds: ["default"] },
            { target: "agent", agentIds: ["second"] },
          ],
        },
        ctx,
      );
      assert.equal(applyRes.imported, 2);

      // First rollback attempt: second agent fails, produces genuine partial status
      const rb1 = await methods.rollback({ runId: applyRes.runId }, ctx);
      assert.equal(rb1.rolledBack, 1);
      assert.equal(rb1.failed, 1);
      assert.equal(rb1.remaining, 1);

      const reportPath = join(home, "imports", applyRes.runId, "report.json");
      const report1 = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.equal(report1.status, "partial");

      // Second rollback attempt: retry succeeds completely
      const rb2 = await methods.rollback({ runId: applyRes.runId }, ctx);
      assert.equal(rb2.rolledBack, 1);
      assert.equal(rb2.failed, 0);
      assert.equal(rb2.remaining, 0);

      const report2 = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.equal(report2.status, "rolled-back");
    });
  });

  it("refuses an owner rollback of a foreign run whose ledger is missing and leaves the status alone (M1)", async () => {
    const home = tempDir("p-real-engine-m1-ledger-");
    await withEngine(home, async (engine, _l, agents) => {
      let activePrincipal: Principal = { userId: "admin-a", role: "admin", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-m1", connectionId: "c-m1", signal: new AbortController().signal };
      const applyRes = await methods.apply({
        entries: [{ category: "Projects", sourceType: "memory", text: "Agent card whose ledger vanishes.", warnings: [], idempotencyKey: "k" }],
        targets: [{ target: "agent", agentIds: ["default"] }],
      }, ctx);
      rmSync(join(home, "imports", applyRes.runId, "ledger.jsonl"));
      const before = readFileSync(join(home, "imports", applyRes.runId, "report.json"), "utf8");
      activePrincipal = { userId: "owner-b", role: "owner", kind: "person" };
      await assert.rejects(
        () => methods.rollback({ runId: applyRes.runId }, ctx),
        (err: any) => err instanceof RpcError && err.error === "E_STORAGE" && err.reason === "ledger-unreadable",
      );
      assert.equal(readFileSync(join(home, "imports", applyRes.runId, "report.json"), "utf8"), before);
      // the importer can still roll back
      activePrincipal = { userId: "admin-a", role: "admin", kind: "person" };
      const own = await methods.rollback({ runId: applyRes.runId }, ctx);
      assert.equal(own.rolledBack, 1);
    });
  });

  it("treats a ledger line without a scope as user scope and a report without importedBy as foreign (L2)", async () => {
    const home = tempDir("p-real-engine-l2-legacy-");
    await withEngine(home, async (engine, _l, agents) => {
      let activePrincipal: Principal = { userId: "admin-a", role: "admin", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-l2", connectionId: "c-l2", signal: new AbortController().signal };
      const applyRes = await methods.apply({
        entries: [{ category: "Preferences", sourceType: "memory", text: "Legacy user card must survive an owner rollback.", warnings: [], idempotencyKey: "k" }],
        targets: [{ target: "user" }],
      }, ctx);
      const dir = join(home, "imports", applyRes.runId);
      const ledger = readFileSync(join(dir, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      for (const l of ledger) delete l.details.scope;
      writeFileSync(join(dir, "ledger.jsonl"), ledger.map((l) => JSON.stringify(l)).join("\n") + "\n");
      const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      delete report.importedBy;
      writeFileSync(join(dir, "report.json"), JSON.stringify(report));
      // a foreign admin is refused for a report without importedBy
      activePrincipal = { userId: "admin-c", role: "admin", kind: "person" };
      await assert.rejects(() => methods.rollback({ runId: applyRes.runId }, ctx), (e: any) => e instanceof RpcError && e.reason === "foreign-import-run");
      activePrincipal = { userId: "owner-b", role: "owner", kind: "person" };
      const rb = await methods.rollback({ runId: applyRes.runId }, ctx);
      assert.equal(rb.rolledBack, 0);
      assert.equal(rb.preservedUserScope, 1);
      activePrincipal = { userId: "admin-a", role: "admin", kind: "person" };
      const exp = await methods.export({}, ctx) as { text: string };
      assert.ok(exp.text.includes("Legacy user card must survive"));
    });
  });

  it("gives 150 future-dated entries distinct timestamps so the export stays complete (L1)", async () => {
    const home = tempDir("p-real-engine-l1-future-");
    await withEngine(home, async (engine, _l, agents) => {
      const activePrincipal: Principal = { userId: "user-future-many", role: "owner", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-l1", connectionId: "c-l1", signal: new AbortController().signal };
      const entries: any[] = [];
      const targets: any[] = [];
      for (let i = 0; i < 150; i++) {
        entries.push({ category: "Preferences", sourceType: "memory", text: `Future dated card ${i}.`, recordedAt: "2099-01-01T00:00:00.000Z", warnings: [], idempotencyKey: `f-${i}` });
        targets.push({ target: "user" });
      }
      const applyRes = await methods.apply({ entries, targets }, ctx);
      assert.equal(applyRes.imported, 150);
      const exp = await methods.export({}, ctx) as { text: string; entryCount: number };
      assert.ok(exp.text.endsWith("STATUS: COMPLETE\n"));
      assert.equal(exp.entryCount, 150);
    });
  });

  it("writes user-scope cards through the chosen agent and exports them whichever agent is asked for (M2)", async () => {
    const home = tempDir("p-real-engine-m2-useragent-");
    await withEngine(home, async (engine, _l, agents) => {
      const activePrincipal: Principal = { userId: "user-m2", role: "owner", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-m2", connectionId: "c-m2", signal: new AbortController().signal };
      const applyRes = await methods.apply({
        entries: [
          { category: "Preferences", sourceType: "memory", text: "Through second agent.", warnings: [], idempotencyKey: "a" },
          { category: "Preferences", sourceType: "memory", text: "Through default agent.", warnings: [], idempotencyKey: "b" },
        ],
        targets: [{ target: "user", agentIds: ["second"] }, { target: "user" }],
      }, ctx);
      assert.equal(applyRes.imported, 2);
      const report = JSON.parse(readFileSync(join(home, "imports", applyRes.runId, "report.json"), "utf8"));
      assert.deepEqual([...report.affectedAgents].sort(), ["default", "second"]);
      for (const agentId of [undefined, "default", "second"]) {
        const exp = await methods.export(agentId ? { agentId } : {}, ctx) as { text: string; entryCount: number };
        assert.equal(exp.entryCount, 2, `export via ${agentId ?? "no agent"}`);
        assert.ok(exp.text.includes("Through second agent"));
        assert.ok(exp.text.includes("Through default agent"));
        assert.ok(exp.text.endsWith("STATUS: COMPLETE\n"));
      }
    });
  });

  it("exports completely although another agent holds an unpageable batch, and reports PARTIAL for one in the person's own scope (N1)", async () => {
    const home = tempDir("p-real-engine-n1-tie-");
    await withEngine(home, async (engine, _l, agents) => {
      const activePrincipal: Principal = { userId: "user-n1", role: "owner", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-n1", connectionId: "c-n1", signal: new AbortController().signal };

      // A migration writes 130 agent-private cards without createdAt into `second`: one engine call, one timestamp.
      const { principal: wallPrincipal } = callerToPrincipal({ channel: "cli", accountId: "api", userId: "migrator" }, "second", agents.workspaceOf("second")!);
      wallPrincipal.user = deriveUserPrincipal("migrator");
      wallPrincipal.trust = "proved";
      await engine.memory.import({
        agentId: "second",
        principal: wallPrincipal,
        cards: Array.from({ length: 130 }, (_, i) => ({
          idempotencyKey: `wall-${i}`, text: `Migrated MEMORY.md line ${i}.`, provenance: "imported" as const, scope: "agent-private" as const,
        })),
        dryRun: false,
      }, wallPrincipal, { origin: "system", background: false });

      // Person A imports through the default agent only: second is not in A's scope, so A's export is COMPLETE.
      await methods.apply({
        entries: [{ category: "Preferences", sourceType: "memory", text: "A likes tea.", warnings: [], idempotencyKey: "a1" }],
        targets: [{ target: "user" }],
      }, ctx);
      const full = await methods.export({}, ctx) as { text: string; entryCount: number };
      assert.ok(full.text.endsWith("STATUS: COMPLETE\n"), full.text.slice(-120));
      assert.equal(full.entryCount, 1);
      assert.ok(full.text.includes("A likes tea."));

      // Now A also imports through `second`: the agent is in A's own scope and cannot be paged -> PARTIAL with reason.
      await methods.apply({
        entries: [{ category: "Preferences", sourceType: "memory", text: "A also likes coffee.", warnings: [], idempotencyKey: "a2" }],
        targets: [{ target: "user", agentIds: ["second"] }],
      }, ctx);
      const partial = await methods.export({}, ctx) as { text: string; entryCount: number };
      assert.match(partial.text, /STATUS: PARTIAL \(not read: second: memory-export-truncated\)\n$/);
      assert.ok(partial.text.includes("A likes tea."), "the readable part is exported in full");
      assert.ok(!partial.text.includes("COMPLETE"));
      // the same through an explicit agent
      const viaSecond = await methods.export({ agentId: "second" }, ctx) as { text: string };
      assert.match(viaSecond.text, /STATUS: PARTIAL \(not read: second: memory-export-truncated\)/);
      assert.ok(viaSecond.text.includes("A likes tea."));
    });
  });

  it("rollback and export survive an agent without a workspace directory (L2)", async () => {
    const home = tempDir("p-real-engine-l2-ghost-");
    await withEngine(home, async (engine, l, base) => {
      const agents = {
        ...base,
        list: () => ["default", "second", "ghost"],
        has: (id: string) => ["default", "second", "ghost"].includes(id),
        workspaceOf: (id: string) => (id === "ghost" ? join(l.state, "no-such-workspace") : l.workspaceDir(id)),
      };
      const activePrincipal: Principal = { userId: "user-ghost", role: "owner", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-l2g", connectionId: "c-l2g", signal: new AbortController().signal };
      const applyRes = await methods.apply({
        entries: [{ category: "Projects", sourceType: "memory", text: "Project for default.", warnings: [], idempotencyKey: "p" }],
        targets: [{ target: "agent", agentIds: ["default"] }],
      }, ctx);
      const dir = join(home, "imports", applyRes.runId);
      const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      report.affectedAgents = ["ghost", "default"];
      writeFileSync(join(dir, "report.json"), JSON.stringify(report));

      const exp = await methods.export({}, ctx) as { text: string };
      assert.match(exp.text, /STATUS: PARTIAL \(not read: ghost: read-failed\)/);

      const rb = await methods.rollback({ runId: applyRes.runId }, ctx);
      assert.equal(rb.rolledBack, 1, "default is still rolled back");
      assert.equal(rb.failed, 1, "the ghost agent fails alone");
      assert.equal(rb.remaining, 1);
      const after = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      assert.equal(after.status, "partial");
    });
  });
});
