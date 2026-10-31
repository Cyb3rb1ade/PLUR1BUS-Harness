import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
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
import { writeAtomicSync } from "../../../src/import/fs-atomic.ts";

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

  it("refuses export with memory-export-truncated when 101+ cards share identical timestamp (N1 refusal)", async () => {
    const home = tempDir("p-real-engine-n1-trunc-");
    await withEngine(home, async (engine, _l, agents) => {
      const activePrincipal: Principal = { userId: "user-trunc", role: "owner", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-trunc", connectionId: "c-trunc", signal: new AbortController().signal };

      // 105 entries with identical timestamp
      const fixedTime = new Date(1_700_000_000_000).toISOString();
      const entries: any[] = [];
      const targets: any[] = [];
      for (let i = 0; i < 105; i++) {
        entries.push({
          category: "Preferences",
          sourceType: "memory",
          text: `Identical timestamp entry ${i}`,
          recordedAt: fixedTime,
          warnings: [],
          idempotencyKey: `same-time-${i}`,
        });
        targets.push({ target: "user" });
      }

      await methods.apply({ entries, targets }, ctx);

      // N1 check: export must refuse honestly with memory-export-truncated
      await assert.rejects(
        async () => {
          await methods.export({}, ctx);
        },
        (err: any) => err instanceof RpcError && err.error === "E_NOT_AVAILABLE" && err.reason === "memory-export-truncated",
        "export must honestly fail with memory-export-truncated rather than emit truncated STATUS: COMPLETE",
      );
    });
  });

  it("handles partial rollback recovery (N3) and permits retry", async () => {
    const home = tempDir("p-real-engine-n3-retry-");
    await withEngine(home, async (engine, _l, agents) => {
      const activePrincipal: Principal = { userId: "user-rb", role: "owner", kind: "person" };
      const methods = setupTestMethods(home, engine, agents, () => activePrincipal);
      const ctx: CallContext = { requestId: "r-rb", connectionId: "c-rb", signal: new AbortController().signal };

      const applyRes = await methods.apply(
        {
          entries: [
            {
              category: "Preferences",
              sourceType: "memory",
              text: "Retry rollback preference card.",
              warnings: [],
              idempotencyKey: "pref-retry",
            },
          ],
          targets: [{ target: "user" }],
        },
        ctx,
      );

      const reportPath = join(home, "imports", applyRes.runId, "report.json");
      // Simulate that a previous rollback run failed and was marked 'partial'
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      report.status = "partial";
      writeAtomicSync(reportPath, JSON.stringify(report, null, 2) + "\n", 0o600);

      // Retrying rollback when status is 'partial' must NOT throw already-rolled-back
      const rbRes = await methods.rollback({ runId: applyRes.runId }, ctx);
      assert.equal(rbRes.rolledBack, 1);
      assert.equal(rbRes.failed, 0);
      assert.equal(rbRes.remaining, 0);

      const finalReport = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.equal(finalReport.status, "rolled-back");
    });
  });
});
