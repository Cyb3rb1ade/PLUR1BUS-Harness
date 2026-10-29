/** Returned Engine storage failures must remain visible and roll back supervised Hermes mutations. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { importHermes } from "../../src/import/importers/hermes.ts";
import { assertImportReportComplete } from "../../src/import/report-complete.ts";
import { runImportMaintenance } from "../../src/import/maintenance-worker.ts";
import { layout } from "../../src/paths.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const MARKER = "private-failed-embedder-value-must-not-leak";
const RUN = "1a61c2f5-285e-4595-b315-d19c0d5a3a98";

function fixture() {
  const source = temp(), home = temp();
  mkdirSync(join(source, "memories"));
  writeFileSync(join(source, "config.yaml"), "_config_version: 45\n");
  writeFileSync(join(source, "SOUL.md"), "imported persona");
  writeFileSync(join(source, "memories", "MEMORY.md"), "selected card that must reach the store\n");
  const config = JSON.stringify(defaults()) + "\n";
  writeFileSync(join(home, "config.json"), config);
  mkdirSync(join(home, "state"));
  writeFileSync(join(home, "state", "prior-data"), "original data");
  let calls = 0;
  const fail = async () => { calls++; throw new Error(MARKER); };
  const testInternals = flatTestInternals({ extra: { embeddings: {
    embed: fail, embedPassage: fail, embedQuery: fail, embedBatch: fail, shutdown: async () => {},
  } } });
  return { source, home, config, testInternals, calls: () => calls };
}

describe("Hermes Engine storage rejection", () => {
  it("reports a real Engine's returned storage rejection without leaking its embedding error", async () => {
    const options = fixture();
    const report = await importHermes({ ...options, apply: true });
    assert.ok(options.calls() > 0, "the real Engine must attempt embedding");
    assert.equal(report.counts.memoryCardsImported, 0);
    assert.equal(report.counts.memoryCardsRejected, 1);
    assert.equal(report.profilesOrAgents[0]!.memory!.cardResults[0]!.reason, "storage");
    assert.ok(report.errors.some(error => error.reason === "memory-import-failed:storage"));
    assert.equal(existsSync(join(layout(options.home).workspaceDir("default"), "memory", "KNOWLEDGE.md")), false);
    assert.equal(JSON.stringify(report).includes(MARKER), false);
  });

  it("restores real Hermes writes instead of completing after the selected card was rejected", async () => {
    const options = fixture();
    const roots = ["state", "agents"].map(id => ({ id, path: join(options.home, id), kind: "directory" as const,
      ...(id === "state" ? { preserve: ["core.lock"] } : {}) }));
    const result = await runImportMaintenance({ home: options.home, runId: RUN, mode: "apply", roots,
      restoreConfig: async () => { writeFileSync(join(options.home, "config.json"), options.config); },
      apply: async () => {
        const report = await importHermes({ ...options, apply: true, runId: RUN,
          targetLock: run => run(), maintenanceRunId: RUN });
        assert.ok(options.calls() > 0);
        assertImportReportComplete(report);
      } });
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.restored, true);
    assert.equal(result.resumable, true);
    assert.equal(readFileSync(join(options.home, "config.json"), "utf8"), options.config);
    assert.equal(readFileSync(join(options.home, "state", "prior-data"), "utf8"), "original data");
    assert.equal(existsSync(join(options.home, "agents")), false);
    assert.equal(existsSync(join(options.home, "state", "lancedb")), false);
    assert.equal(JSON.stringify(result).includes(MARKER), false);
  });

  it("reports a returned storage failure for bound user cards without writing a user mirror", async () => {
    const options = fixture();
    writeFileSync(join(options.source, "memories", "MEMORY.md"), "");
    writeFileSync(join(options.source, "memories", "USER.md"), "selected user card\n");
    const report = await importHermes({ ...options, apply: true, userPrincipal: {
      agentId: "default", user: `user:v1:${"a".repeat(64)}`, channel: "telegram", accountId: "default",
      chat: { id: "c1", kind: "direct" }, trust: "proved",
    } });
    assert.ok(options.calls() > 0, JSON.stringify(report.profilesOrAgents.map(agent => agent.memory)));
    assert.equal(report.counts.memoryCardsRejected, 1);
    assert.ok(report.errors.some(error => error.sourceRef.includes("memories/USER.md")
      && error.reason === "memory-import-failed:storage"));
    assert.equal(existsSync(join(layout(options.home).workspaceDir("default"), "USER.md")), false);
    assert.throws(() => assertImportReportComplete(report), { code: "E_IMPORT_FAILED", reason: "entity-failed" });
    assert.equal(JSON.stringify(report).includes(MARKER), false);
  });

  it("checks returned card failures even when a legacy report omitted errors, while preserving semantic rejections", () => {
    const report = (reason: string) => ({ errors: [], agents: [{ memory: {
      cardResults: [{ outcome: "rejected", reason }],
    } }] });
    for (const reason of ["storage", "aborted", "EMBEDDER_UNAVAILABLE", "EMBEDDING_IDENTITY_MISMATCH", "unknown-engine-error"]) {
      assert.throws(() => assertImportReportComplete(report(reason)), { code: "E_IMPORT_FAILED", reason: "entity-failed" });
    }
    for (const reason of ["unresolved-user-scope", "previously-imported-deleted", "tombstone-blocked", "empty-text",
      "invalid-input", "principal-unresolved", "provenance-not-imported", "duplicate-in-batch"]) {
      assert.doesNotThrow(() => assertImportReportComplete(report(reason)));
    }
  });
});
