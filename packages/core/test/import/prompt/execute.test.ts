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
        return { agentId: req.agentId, importRunId: req.importRunId, undone: 5 };
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
      raw: "Alex",
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
        raw: "Alex",
        warnings: [],
        idempotencyKey: "k1",
      },
      {
        category: "Projects",
        sourceType: "memory",
        text: "Plur1bus harness",
        raw: "Plur1bus harness",
        warnings: [],
        idempotencyKey: "k2",
      },
      {
        category: "Instructions",
        sourceType: "memory",
        text: "Be concise",
        raw: "Be concise",
        warnings: [],
        idempotencyKey: "k3",
      },
      {
        category: "Other",
        sourceType: "memory",
        text: "Random note",
        raw: "Random note",
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

      assert.equal(res.imported, 2);
      assert.equal(res.proposedRules, 1);
      assert.equal(res.skipped, 1);
      assert.ok(importedCards.length === 2);

      // Verify report was written
      const report = JSON.parse(readFileSync(res.reportPath, "utf8"));
      assert.equal(report.status, "completed");
      assert.equal(report.counts.imported, 2);
      assert.equal(report.counts.proposedRules, 1);
      assert.equal(report.counts.skipped, 1);
      assert.equal(report.proposals.length, 1);
      assert.equal(report.proposals[0].status, "open");

      // Verify rollback
      const rbRes = await rollbackPromptImport({
        runId: res.runId,
        home: tmp,
        engine,
        principal,
      });

      assert.equal(rbRes.discardedProposals, 1);
      assert.ok(unimportedRuns.length >= 1);

      // Verify report status updated
      const updatedReport = JSON.parse(readFileSync(res.reportPath, "utf8"));
      assert.equal(updatedReport.status, "rolled-back");
      assert.equal(updatedReport.proposals[0].status, "discarded");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
