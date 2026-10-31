import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { executePromptImport, rollbackPromptImport } from "../../../src/import/prompt/execute.ts";
import type { EntryTarget, ParsedEntry } from "../../../src/import/prompt/types.ts";
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

function createMockEngine() {
  const importedCards: Array<{ agentId: string; card: E.MemoryImportCardInput }> = [];
  const linkedCards: Array<{ id: string; req: E.MemoryLinkRequest }> = [];
  const unimportedRuns: Array<{ agentId: string; importRunId: string }> = [];

  const engine: any = {
    memory: {
      import: async (req: E.MemoryImportRequest) => {
        if (req.dryRun) {
          return {
            agentId: req.agentId,
            dryRun: true,
            created: req.cards.length,
            matchedExisting: 0,
            rejected: 0,
            cards: req.cards.map((c) => ({ idempotencyKey: c.idempotencyKey, outcome: "created" })),
          };
        }
        for (const card of req.cards) {
          importedCards.push({ agentId: req.agentId, card });
        }
        return {
          agentId: req.agentId,
          dryRun: false,
          created: req.cards.length,
          matchedExisting: 0,
          rejected: 0,
          cards: req.cards.map((c, i) => ({
            idempotencyKey: c.idempotencyKey,
            outcome: "created",
            id: `card-${i}`,
          })),
        };
      },
      link: async (id: string, req: E.MemoryLinkRequest) => {
        linkedCards.push({ id, req });
        return { id, linked: true };
      },
      unimport: async (req: E.MemoryUnimportRequest) => {
        unimportedRuns.push({ agentId: req.agentId, importRunId: req.importRunId });
        return { agentId: req.agentId, importRunId: req.importRunId, unimported: 2 };
      },
    },
  };

  return { engine, importedCards, linkedCards, unimportedRuns };
}

describe("executePromptImport & rollbackPromptImport", () => {
  it("rejects user-target entries if principal trust is not proved", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "p-import-test-"));
    const { engine } = createMockEngine();
    const entries: ParsedEntry[] = [{
      category: "Identity",
      sourceType: "memory",
      text: "Alex",
      warnings: [],
      idempotencyKey: "k1",
    }];
    const targets: EntryTarget[] = [{ target: "user" }];
    const principal: E.Principal = {
      agentId: "agent1",
      workspace: "workspace:v1:main",
      channel: "cli",
      accountId: "default",
      chat: { id: "c1", kind: "direct" },
      trust: "inferred", // Not proved!
    };

    try {
      await assert.rejects(
        async () =>
          executePromptImport({
            entries,
            targets,
            principal,
            home: tmp,
            engine,
            defaultAgentId: "bernd",
          }),
        (err: any) => err.error === "E_DENIED" && err.reason === "principal-unresolved",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("successfully imports mixed targets, creates report and ledger, and supports rollback", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "p-import-test-"));
    const { engine, importedCards, unimportedRuns } = createMockEngine();

    const entries: ParsedEntry[] = [
      {
        category: "Identity",
        sourceType: "memory",
        text: "Alex",
        warnings: [],
        idempotencyKey: "k1",
      },
      {
        category: "Projects",
        sourceType: "memory",
        text: "Plur1bus harness",
        warnings: [],
        idempotencyKey: "k2",
      },
      {
        category: "Instructions",
        sourceType: "memory",
        text: "Be concise",
        warnings: [],
        idempotencyKey: "k3",
      },
      {
        category: "Other",
        sourceType: "memory",
        text: "Random note",
        warnings: [],
        idempotencyKey: "k4",
      },
    ];

    const targets: EntryTarget[] = [
      { target: "user" },
      { target: "agent", agentIds: ["karl"] },
      { target: "propose-rule", agentIds: ["karl"] },
      { target: "skip" },
    ];

    const principal: E.Principal = {
      agentId: "agent1",
      workspace: "workspace:v1:main",
      user: "user:v1:alice" as any,
      channel: "cli",
      accountId: "default",
      chat: { id: "c1", kind: "direct" },
      trust: "proved",
    };

    try {
      const res = await executePromptImport({
        entries,
        targets,
        principal,
        home: tmp,
        engine,
        defaultAgentId: "bernd",
      });

      // Instructions are skipped (B7), so imported=2, proposedRules=0, skipped=2
      assert.equal(res.imported, 2);
      assert.equal(res.proposedRules, 0);
      assert.equal(res.skipped, 2);
      assert.equal(importedCards.length, 2);

      // Verify report was written
      const report = JSON.parse(readFileSync(res.reportPath, "utf8"));
      assert.equal(report.status, "completed");
      assert.equal(report.counts.imported, 2);
      assert.equal(report.counts.proposedRules, 0);
      assert.equal(report.counts.skipped, 2);

      // Verify rollback
      const rbRes = await rollbackPromptImport({
        runId: res.runId,
        home: tmp,
        engine,
        principal,
      });

      assert.equal(rbRes.rolledBack, 4);
      assert.ok(unimportedRuns.length >= 1);

      // Verify report status updated
      const updatedReport = JSON.parse(readFileSync(res.reportPath, "utf8"));
      assert.equal(updatedReport.status, "rolled-back");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("enforces path containment and rejects invalid runIds on rollback (B6)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "p-import-test-"));
    const { engine } = createMockEngine();
    const principal: E.Principal = {
      agentId: "agent1",
      workspace: "workspace:v1:main",
      user: "user:v1:alice" as any,
      channel: "cli",
      accountId: "default",
      chat: { id: "c1", kind: "direct" },
      trust: "proved",
    };

    try {
      // 1. Invalid runId format
      await assert.rejects(
        () => rollbackPromptImport({ runId: "../traversal", home: tmp, engine, principal }),
        (err: any) => err.error === "E_INVALID_PARAMS" && err.reason === "invalid-run-id",
      );

      // 2. Run not found
      await assert.rejects(
        () => rollbackPromptImport({ runId: "prompt-12345678-abcdef01", home: tmp, engine, principal }),
        (err: any) => err.error === "E_NOT_FOUND" && err.reason === "run-not-found",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
