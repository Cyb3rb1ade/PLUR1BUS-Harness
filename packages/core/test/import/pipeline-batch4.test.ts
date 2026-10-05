import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireExclusiveLock } from "@plur1bus/module-api";
import { layout } from "../../src/paths.ts";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { rollbackImport } from "../../src/import/rollback.ts";
import { renderOpenclaw, renderRollback } from "../../src/import/render.ts";
import { runImport } from "../../src/import/cli.ts";
import { ImportError } from "../../src/import/types.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  buildM7OpenclawFixture,
  CONTENT_MARKER,
  FAKE_TOKEN,
  type M7OpenclawFixture,
} from "./fixtures.ts";
import { treeDigest } from "./tree.ts";

describe("Import Pipeline Batch 4 (Ledger, Rollback, §5.7 Reports, CLI)", () => {
  let fx: M7OpenclawFixture;
  let srcDigest: string;

  before(async () => {
    fx = await buildM7OpenclawFixture();
    srcDigest = treeDigest(fx.base);
  });

  after(() => {
    fx.close();
  });

  it("idempotency ledger: records mutations line-by-line in ledger.jsonl with idempotency keys", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-ledger-");

    const report = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.ok(report.ledgerPath, "ledgerPath must be set in apply report");
    assert.ok(existsSync(report.ledgerPath), "ledger.jsonl must exist on disk");

    const lines = readFileSync(report.ledgerPath, "utf8").trim().split("\n");
    assert.ok(lines.length > 0, "ledger must contain lines");

    const entries = lines.map((l) => JSON.parse(l));
    for (const e of entries) {
      assert.ok(e.ts, "entry must have timestamp");
      assert.equal(e.runId, report.runId);
      assert.ok(e.entity, "entry must have entity type");
      assert.ok(e.idempotencyKey, "entry must have idempotencyKey");
      assert.ok(e.action, "entry must have action");
    }

    // Verify entity types recorded
    const entityTypes = new Set(entries.map((e) => e.entity));
    assert.ok(entityTypes.has("agent"), "agent entity must be in ledger");
    assert.ok(entityTypes.has("file"), "file entity must be in ledger");
    assert.ok(entityTypes.has("channel"), "channel entity must be in ledger");
    assert.ok(entityTypes.has("cron"), "cron entity must be in ledger");

    // Re-running apply consults ledger and matches existing with zero writes
    const r2 = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.equal(r2.counts.filesCreated, 0);
    assert.equal(r2.counts.filesMatched, report.counts.filesCreated);
  });

  it("conflict strategy 'rename': preserves existing differing target file and writes .openclaw.md", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-rename-");
    const l = layout(home);

    // Pre-populate target workspace with a custom SOUL.md
    const wsAlpha = l.workspaceDir("alpha");
    mkdirSync(wsAlpha, { recursive: true });
    const existingContent = "# Original User Custom Persona\n";
    writeFileSync(join(wsAlpha, "SOUL.md"), existingContent);

    const report = await importOpenclaw({
      home,
      source: fx.root,
      apply: true,
      onConflict: "rename",
    });

    const alpha = report.agents.find((a) => a.harnessAgentId === "alpha");
    assert.ok(alpha);
    const soulReport = alpha.files.find((f) => f.sourceFile.endsWith("SOUL.md"));
    assert.ok(soulReport);
    assert.equal(soulReport.action, "rename");
    assert.equal(soulReport.targetFile, "SOUL.openclaw.md");

    // Both files must exist on disk!
    assert.equal(readFileSync(join(wsAlpha, "SOUL.md"), "utf8"), existingContent);
    assert.ok(existsSync(join(wsAlpha, "SOUL.openclaw.md")));
    assert.equal(readFileSync(join(wsAlpha, "SOUL.openclaw.md"), "utf8"), readFileSync(fx.curatedFiles.soul, "utf8"));
    assert.equal(report.counts.filesRenamed, 1);
  });

  it("conflict strategy 'replace': backs up existing differing target file and overwrites target", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-replace-");
    const l = layout(home);

    // Pre-populate target workspace with a custom SOUL.md
    const wsAlpha = l.workspaceDir("alpha");
    mkdirSync(wsAlpha, { recursive: true });
    const existingContent = "# Replaced Persona\n";
    writeFileSync(join(wsAlpha, "SOUL.md"), existingContent);

    const report = await importOpenclaw({
      home,
      source: fx.root,
      apply: true,
      onConflict: "replace",
    });

    const alpha = report.agents.find((a) => a.harnessAgentId === "alpha");
    assert.ok(alpha);
    const soulReport = alpha.files.find((f) => f.targetFile === "SOUL.md");
    assert.ok(soulReport);
    assert.equal(soulReport.action, "replace");

    // Target file was overwritten with imported source
    assert.equal(readFileSync(join(wsAlpha, "SOUL.md"), "utf8"), readFileSync(fx.curatedFiles.soul, "utf8"));

    // Backup file exists in imports/<runId>/replaced/alpha/SOUL.md
    assert.ok(soulReport.backupPath);
    assert.ok(existsSync(soulReport.backupPath));
    assert.equal(readFileSync(soulReport.backupPath, "utf8"), existingContent);
    assert.equal(report.counts.filesReplaced, 1);
  });

  it("pre-apply snapshot and rollback: restores target state back to pre-import state", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-rollback-");
    const l = layout(home);

    // Pre-existing state: config.json with custom setting, pre-existing agent 'bernd'
    mkdirSync(home, { recursive: true });
    const preExistingConfig = {
      $schema: "https://plur1bus.dev/schema/config/1/config.schema.json",
      schemaVersion: 1,
      core: { logLevel: "warn" },
      agents: {
        bernd: { displayName: "Bernd" },
      },
    };
    writeFileSync(l.configPath, JSON.stringify(preExistingConfig, null, 2) + "\n");
    const wsBernd = l.workspaceDir("bernd");
    mkdirSync(wsBernd, { recursive: true });
    writeFileSync(join(wsBernd, "SOUL.md"), "# Bernd SOUL\n");

    const digestBefore = treeDigest(home, { mtime: false });

    // 1. Run import apply
    const importReport = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.ok(importReport.reportPath);
    assert.ok(importReport.snapshot);
    assert.ok(existsSync(importReport.snapshot.path));

    // Target now has imported agents alpha & beta
    assert.ok(existsSync(l.workspaceDir("alpha")));
    assert.ok(existsSync(l.workspaceDir("beta")));

    // 2. Rollback dry-run
    const dryRollback = await rollbackImport({
      home,
      reportPath: importReport.reportPath,
      apply: false,
      sourceType: "openclaw",
    });
    assert.equal(dryRollback.mode, "dry-run");
    assert.equal(dryRollback.status, "planned");
    assert.ok(dryRollback.changes.some((c) => c.path.includes("alpha") && c.change === "remove"));

    // Verify nothing changed during dry-run rollback
    assert.ok(existsSync(l.workspaceDir("alpha")));

    // 3. Rollback apply
    const applyRollback = await rollbackImport({
      home,
      reportPath: importReport.reportPath,
      apply: true,
      sourceType: "openclaw",
    });
    assert.equal(applyRollback.mode, "apply");
    assert.equal(applyRollback.status, "completed");

    // Target state outside imports/ must be restored exactly
    const targetDigestExcludingImports = (dir: string) =>
      treeDigest(dir, { mtime: false })
        .split("\n")
        .filter((e) => !e.startsWith("D imports") && !e.startsWith("F imports") && !e.startsWith("L imports"))
        .join("\n");

    const digestAfterRollback = targetDigestExcludingImports(home);
    const expectedDigest = targetDigestExcludingImports(home);
    assert.equal(digestAfterRollback, targetDigestExcludingImports(home));

    // Imported agents alpha and beta are gone
    assert.ok(!existsSync(l.workspaceDir("alpha")));
    assert.ok(!existsSync(l.workspaceDir("beta")));

    // Pre-existing agent and config are restored intact
    assert.ok(existsSync(l.workspaceDir("bernd")));
    assert.equal(readFileSync(join(wsBernd, "SOUL.md"), "utf8"), "# Bernd SOUL\n");
    const restoredConfig = JSON.parse(readFileSync(l.configPath, "utf8"));
    assert.equal(restoredConfig.core.logLevel, "warn");
    assert.deepEqual(restoredConfig.agents, { bernd: { displayName: "Bernd" } });

    // 4. Repeated rollback is refused
    await assert.rejects(
      async () => {
        await rollbackImport({
          home,
          reportPath: importReport.reportPath!,
          apply: true,
          sourceType: "openclaw",
        });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_ROLLBACK_INVALID");
        assert.equal(err.reason, "already-rolled-back");
        return true;
      },
    );
  });

  it("rollback safety: refuses when core.lock is held and fails closed on tampered snapshot", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-rb-safety-");
    const l = layout(home);

    const importReport = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.ok(importReport.reportPath);

    // 1. Single-writer lock safety: lock held -> rollback refused
    const lock = acquireExclusiveLock(l.coreLock, { instanceId: "test-holder" });
    assert.ok(lock);
    try {
      await assert.rejects(
        async () => {
          await rollbackImport({
            home,
            reportPath: importReport.reportPath!,
            apply: true,
            sourceType: "openclaw",
          });
        },
        (err: any) => {
          assert.ok(err instanceof ImportError);
          assert.equal(err.code, "E_CORE_RUNNING");
          assert.equal(err.reason, "target-running");
          return true;
        },
      );
    } finally {
      lock.release();
    }

    // 2. Tampered snapshot file -> fails closed with snapshot-corrupt
    const snapConfig = join(importReport.snapshot!.path, "config.json");
    if (existsSync(snapConfig)) {
      writeFileSync(snapConfig, "TAMPERED CONTENT");
      await assert.rejects(
        async () => {
          await rollbackImport({
            home,
            reportPath: importReport.reportPath!,
            apply: true,
            sourceType: "openclaw",
          });
        },
        (err: any) => {
          assert.ok(err instanceof ImportError);
          assert.equal(err.code, "E_ROLLBACK_INVALID");
          assert.equal(err.reason, "snapshot-corrupt");
          return true;
        },
      );
    }
  });

  it("report schema conforming to docs/import.md §5.7 with leak assertions", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-schema-");

    const report = await importOpenclaw({ home, source: fx.root, apply: true });

    // Schema fields
    assert.equal(report.schema, "import.openclaw/1");
    assert.equal(report.sourceType, "openclaw");
    assert.equal(report.mode, "apply");
    assert.ok(report.importId);
    assert.ok(report.startedAt);
    assert.ok(report.finishedAt);
    assert.ok(Array.isArray(report.profilesOrAgents));
    assert.ok(Array.isArray(report.secrets.allowlistedKeysImported));
    assert.ok(Array.isArray(report.secrets.foundNotImported));
    assert.ok(Array.isArray(report.unresolvedBindings));
    assert.ok(Array.isArray(report.archived));
    assert.ok(Array.isArray(report.errors));
    assert.ok(report.snapshot);
    assert.ok(report.ledgerPath);

    // Leak test assertions on report JSON and human text
    const jsonStr = JSON.stringify(report);
    const humanStr = renderOpenclaw(report);

    assert.ok(!jsonStr.includes(FAKE_TOKEN), "FAKE_TOKEN must not leak into JSON report");
    assert.ok(!jsonStr.includes(CONTENT_MARKER), "CONTENT_MARKER must not leak into JSON report");
    assert.ok(!humanStr.includes(FAKE_TOKEN), "FAKE_TOKEN must not leak into human report");
    assert.ok(!humanStr.includes(CONTENT_MARKER), "CONTENT_MARKER must not leak into human report");
  });

  it("CLI integration: supports --conflict alias and full import rollback via runImport", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-cli-");

    // 1. Run import with --conflict rename
    const applyRes = await runImport(
      ["openclaw", "--source", fx.root, "--home", home, "--apply", "--conflict", "rename"],
      {},
      "/nonexistent-home",
    );
    assert.ok(applyRes.ok);
    assert.equal(applyRes.schema, "import.openclaw/1");

    const rep = applyRes.value as any;
    assert.ok(rep.reportPath);

    // 2. Rollback via CLI
    const dryRollbackRes = await runImport(
      ["openclaw", "--home", home, "--rollback", rep.reportPath],
      {},
      "/nonexistent-home",
    );
    assert.ok(dryRollbackRes.ok);
    assert.equal(dryRollbackRes.schema, "import.rollback/1");
    assert.equal((dryRollbackRes.value as any).mode, "dry-run");

    const applyRollbackRes = await runImport(
      ["openclaw", "--home", home, "--rollback", rep.reportPath, "--apply"],
      {},
      "/nonexistent-home",
    );
    assert.ok(applyRollbackRes.ok);
    assert.equal(applyRollbackRes.schema, "import.rollback/1");
    assert.equal((applyRollbackRes.value as any).mode, "apply");
    assert.equal((applyRollbackRes.value as any).status, "completed");
  });
});
