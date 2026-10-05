import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { acquireExclusiveLock } from "@plur1bus/module-api";
import { layout } from "../../src/paths.ts";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { rollbackImport, RUN_ID_RE } from "../../src/import/rollback.ts";
import { renderOpenclaw, renderRollback } from "../../src/import/render.ts";
import { runImport } from "../../src/import/cli.ts";
import { ImportError } from "../../src/import/types.ts";
import { _testFsAtomicHooks } from "../../src/import/fs-atomic.ts";
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

  it("conflict strategy 'rename' is strictly idempotent across multiple runs (B3)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-rename-");
    const l = layout(home);

    // Pre-populate target workspace with a custom SOUL.md
    const wsAlpha = l.workspaceDir("alpha");
    mkdirSync(wsAlpha, { recursive: true });
    const existingContent = "# Original User Custom Persona\n";
    writeFileSync(join(wsAlpha, "SOUL.md"), existingContent);

    // Run 1: renames imported SOUL.md to SOUL.openclaw.md
    const r1 = await importOpenclaw({
      home,
      source: fx.root,
      apply: true,
      onConflict: "rename",
    });
    assert.equal(r1.counts.filesRenamed, 1);
    assert.equal(readFileSync(join(wsAlpha, "SOUL.md"), "utf8"), existingContent);
    assert.ok(existsSync(join(wsAlpha, "SOUL.openclaw.md")));
    assert.equal(readFileSync(join(wsAlpha, "SOUL.openclaw.md"), "utf8"), readFileSync(fx.curatedFiles.soul, "utf8"));

    // Run 2: same source, same onConflict: "rename"
    const r2 = await importOpenclaw({
      home,
      source: fx.root,
      apply: true,
      onConflict: "rename",
    });
    assert.equal(r2.counts.filesRenamed, 0, "run 2 must NOT create another rename file");
    assert.ok(!existsSync(join(wsAlpha, "SOUL.openclaw-2.md")), "must not create SOUL.openclaw-2.md");

    // Run 3: third run remains strictly idempotent
    const r3 = await importOpenclaw({
      home,
      source: fx.root,
      apply: true,
      onConflict: "rename",
    });
    assert.equal(r3.counts.filesRenamed, 0, "run 3 must NOT create another rename file");
    assert.ok(!existsSync(join(wsAlpha, "SOUL.openclaw-2.md")), "must not create SOUL.openclaw-2.md");
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

  it("pre-apply snapshot and rollback: restores exact pre-import state (B5 assert against digestBefore)", { timeout: 30_000 }, async () => {
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

    // Target state outside imports/ and state/ (lock files) must be restored EXACTLY to digestBefore
    const targetDigestExcludingImports = (dir: string) =>
      treeDigest(dir, { mtime: false })
        .split("\n")
        .filter((e) => !e.startsWith("D imports") && !e.startsWith("F imports") && !e.startsWith("L imports") && !e.startsWith("D state") && !e.startsWith("F state"))
        .join("\n");

    const digestAfterRollback = targetDigestExcludingImports(home);
    assert.equal(digestAfterRollback, digestBefore, "restored target must match digestBefore byte-for-byte");

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

  it("rollback scope: user-created files survive rollback, modified files backed up (B4)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-user-scope-");
    const l = layout(home);

    const importReport = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.ok(importReport.reportPath);

    // After import, user creates a new agent and adds their own files
    const customAgentDir = l.agentDir("user-created-agent");
    mkdirSync(customAgentDir, { recursive: true });
    const userDoc = join(customAgentDir, "notes.txt");
    writeFileSync(userDoc, "User private notes\n");

    // User also adds an unrelated file inside an imported agent's workspace
    const importedWs = l.workspaceDir("alpha");
    const userFileInsideImported = join(importedWs, "custom-scratch.txt");
    writeFileSync(userFileInsideImported, "User created scratchpad\n");

    // User edits an imported file (SOUL.md)
    const soulPath = join(importedWs, "SOUL.md");
    writeFileSync(soulPath, "# User Edited SOUL\n");

    // Execute rollback
    const rollbackRes = await rollbackImport({
      home,
      reportPath: importReport.reportPath,
      apply: true,
      sourceType: "openclaw",
    });
    assert.equal(rollbackRes.status, "completed");

    // B4: User-created files MUST SURVIVE!
    assert.ok(existsSync(userDoc), "user-created agent file must survive rollback");
    assert.equal(readFileSync(userDoc, "utf8"), "User private notes\n");

    assert.ok(existsSync(userFileInsideImported), "user file inside imported workspace must survive rollback");
    assert.equal(readFileSync(userFileInsideImported, "utf8"), "User created scratchpad\n");

    // User-edited file was backed up and kept intact as kept-modified (B4)
    assert.ok(rollbackRes.movedAside);
    const backupSoul = join(rollbackRes.movedAside, "agents/alpha/workspace/SOUL.md");
    assert.ok(existsSync(backupSoul), "modified file must be backed up in rolled-back/replaced/");
    assert.equal(readFileSync(backupSoul, "utf8"), "# User Edited SOUL\n");
    assert.ok(existsSync(soulPath), "modified run-created file must survive on disk as kept-modified");
    assert.equal(readFileSync(soulPath, "utf8"), "# User Edited SOUL\n");
    assert.ok(rollbackRes.changes.some((c) => c.path.includes("SOUL.md") && c.change === "kept-modified"));
  });

  it("rollback with --force removes user-modified run-created files (B4)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-force-");
    const l = layout(home);

    const importReport = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.ok(importReport.reportPath);

    const soulPath = join(l.workspaceDir("alpha"), "SOUL.md");
    writeFileSync(soulPath, "# User Modified SOUL\n");

    const rollbackRes = await rollbackImport({
      home,
      reportPath: importReport.reportPath,
      apply: true,
      sourceType: "openclaw",
      force: true,
    });
    assert.equal(rollbackRes.status, "completed");
    assert.ok(rollbackRes.changes.some((c) => c.path.includes("SOUL.md") && c.change === "remove"));
    assert.ok(!existsSync(soulPath), "with force: true, user-modified file is removed");
    assert.ok(rollbackRes.movedAside);
    const backupSoul = join(rollbackRes.movedAside, "agents/alpha/workspace/SOUL.md");
    assert.ok(existsSync(backupSoul), "file was still backed up before removal");
  });

  it("rollback path traversal security: rejects traversal runId and manifest keys (B1)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-traversal-");
    const l = layout(home);

    // Initial import
    const report = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.ok(report.reportPath);

    // 1. Traversal in runId
    const repObj = JSON.parse(readFileSync(report.reportPath, "utf8"));
    const tamperedReportPath = join(home, "traversal-report.json");

    repObj.runId = "../../malicious";
    writeFileSync(tamperedReportPath, JSON.stringify(repObj));
    await assert.rejects(
      async () => {
        await rollbackImport({
          home,
          reportPath: tamperedReportPath,
          apply: true,
          sourceType: "openclaw",
        });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.reason, "run-id-invalid");
        return true;
      },
    );

    // 2. Traversal key in manifest.json (e.g. ../../escape.txt)
    const validRunDir = join(l.home, "imports", report.runId);
    const snapDir = join(validRunDir, "snapshot");
    const manifestPath = join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    manifest.files["../../outside.txt"] = { sha256: "0000000000000000000000000000000000000000000000000000000000000000", size: 10 };
    const tamperedManifestJson = JSON.stringify(manifest, null, 2) + "\n";
    writeFileSync(manifestPath, tamperedManifestJson);

    // Also update report.json snapshot.manifestSha256 to isolate manifest key validation
    const reportRaw = JSON.parse(readFileSync(report.reportPath, "utf8"));
    const { createHash } = await import("node:crypto");
    reportRaw.snapshot.manifestSha256 = createHash("sha256").update(tamperedManifestJson).digest("hex");
    writeFileSync(report.reportPath, JSON.stringify(reportRaw, null, 2) + "\n");

    await assert.rejects(
      async () => {
        await rollbackImport({
          home,
          reportPath: report.reportPath!,
          apply: true,
          sourceType: "openclaw",
        });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.reason, "snapshot-invalid");
        return true;
      },
    );
  });

  it("rollback path traversal security: rejects absolute manifest key (B1)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-abs-manifest-");
    const l = layout(home);

    const report = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.ok(report.reportPath);

    const validRunDir = join(l.home, "imports", report.runId);
    const snapDir = join(validRunDir, "snapshot");
    const manifestPath = join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    const absKey = process.platform === "win32" ? "C:\\outside.txt" : "/etc/outside.txt";
    manifest.files[absKey] = { sha256: "0000000000000000000000000000000000000000000000000000000000000000", size: 10 };
    const tamperedManifestJson = JSON.stringify(manifest, null, 2) + "\n";
    writeFileSync(manifestPath, tamperedManifestJson);

    const reportRaw = JSON.parse(readFileSync(report.reportPath, "utf8"));
    const { createHash } = await import("node:crypto");
    reportRaw.snapshot.manifestSha256 = createHash("sha256").update(tamperedManifestJson).digest("hex");
    writeFileSync(report.reportPath, JSON.stringify(reportRaw, null, 2) + "\n");

    await assert.rejects(
      async () => {
        await rollbackImport({
          home,
          reportPath: report.reportPath!,
          apply: true,
          sourceType: "openclaw",
        });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.reason, "snapshot-invalid");
        return true;
      },
    );
  });

  it("rollback symlink security: refuses to touch symlink at target path (B1)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-symlink-");
    const l = layout(home);

    // Pre-populate target with valid config.json
    mkdirSync(home, { recursive: true });
    writeFileSync(l.configPath, JSON.stringify({ schemaVersion: 1, core: { logLevel: "info" } }) + "\n");

    const report = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.ok(report.reportPath);

    // Plant a symlink pointing outside home at an imported file target
    const targetFile = join(l.workspaceDir("alpha"), "SOUL.md");
    assert.ok(existsSync(targetFile), "target file must exist before replacing with symlink");
    const outsideSecret = join(tempDir("p1b-outside-"), "secret.txt");
    writeFileSync(outsideSecret, "TOP_SECRET");

    unlinkSync(targetFile);
    symlinkSync(outsideSecret, targetFile);

    await assert.rejects(
      async () => {
        await rollbackImport({
          home,
          reportPath: report.reportPath!,
          apply: true,
          sourceType: "openclaw",
        });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.reason, "unsafe-symlink");
        return true;
      },
    );
  });

  it("rollback ancestor symlink security: refuses when ancestor directory is a symlink to outside (B1)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-ancestor-symlink-");
    const l = layout(home);

    mkdirSync(home, { recursive: true });
    writeFileSync(l.configPath, JSON.stringify({ schemaVersion: 1, core: { logLevel: "info" } }) + "\n");

    const report = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.ok(report.reportPath);

    // Replace agents/alpha with a symlink pointing to an outside directory
    const outsideDir = tempDir("p1b-outside-dir-");
    const alphaDir = l.agentDir("alpha");
    rmSync(alphaDir, { recursive: true, force: true });
    symlinkSync(outsideDir, alphaDir);

    await assert.rejects(
      async () => {
        await rollbackImport({
          home,
          reportPath: report.reportPath!,
          apply: true,
          sourceType: "openclaw",
        });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.reason, "unsafe-symlink");
        return true;
      },
    );

    // Verify nothing was written to outside directory
    const outsideEntries = readdirSync(outsideDir);
    assert.equal(outsideEntries.length, 0, "nothing must be written outside through ancestor symlink");
  });

  it("rollback safety: refuses when core.lock is held and fails closed on unconditionally tampered snapshot (B5)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-rb-safety-");
    const l = layout(home);

    // Create target with pre-existing config so snapshot has files
    mkdirSync(home, { recursive: true });
    writeFileSync(l.configPath, JSON.stringify({ schemaVersion: 1, core: { logLevel: "info" } }) + "\n");

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

    // 2. Unconditional tamper test on snapshot file
    const snapConfig = join(importReport.snapshot!.path, "config.json");
    assert.ok(existsSync(snapConfig), "snapConfig must exist unconditionally");
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
  });

  it("report schema conforming to docs/import.md §5.7 with leak assertions including ledger (B5)", { timeout: 30_000 }, async () => {
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
    assert.ok(Array.isArray(report.archived));
    assert.ok(Array.isArray(report.errors));
    assert.ok(report.snapshot);
    assert.ok(report.ledgerPath);

    // Leak test assertions on report JSON, human text, AND ledger.jsonl
    const jsonStr = JSON.stringify(report);
    const humanStr = renderOpenclaw(report);
    const ledgerStr = readFileSync(report.ledgerPath, "utf8");

    assert.ok(!jsonStr.includes(FAKE_TOKEN), "FAKE_TOKEN must not leak into JSON report");
    assert.ok(!jsonStr.includes(CONTENT_MARKER), "CONTENT_MARKER must not leak into JSON report");
    assert.ok(!humanStr.includes(FAKE_TOKEN), "FAKE_TOKEN must not leak into human report");
    assert.ok(!humanStr.includes(CONTENT_MARKER), "CONTENT_MARKER must not leak into human report");
    assert.ok(!ledgerStr.includes(FAKE_TOKEN), "FAKE_TOKEN must not leak into ledger");
    assert.ok(!ledgerStr.includes(CONTENT_MARKER), "CONTENT_MARKER must not leak into ledger");
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

  it("rollback crash resilience: config.json remains intact and valid JSON on error during restore (B2)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-crash-restore-");
    const l = layout(home);

    mkdirSync(home, { recursive: true });
    const initialConfig = { schemaVersion: 1, core: { logLevel: "info" } };
    writeFileSync(l.configPath, JSON.stringify(initialConfig, null, 2) + "\n");

    const report = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.ok(report.reportPath);

    try {
      _testFsAtomicHooks.beforeRename = (_tmp, targetPath) => {
        if (targetPath.endsWith("config.json")) {
          throw new Error("Simulated crash during atomic rename of config.json");
        }
      };

      await assert.rejects(
        async () => {
          await rollbackImport({
            home,
            reportPath: report.reportPath!,
            apply: true,
            sourceType: "openclaw",
          });
        },
        /Simulated crash/,
      );
    } finally {
      _testFsAtomicHooks.beforeRename = undefined;
    }

    // config.json must remain intact and valid JSON
    assert.ok(existsSync(l.configPath));
    const configAfter = JSON.parse(readFileSync(l.configPath, "utf8"));
    assert.ok(configAfter.schemaVersion);

    // No orphan temp files left behind in home
    const rootFiles = readdirSync(home);
    const tmpFiles = rootFiles.filter((f) => f.includes(".tmp."));
    assert.equal(tmpFiles.length, 0, "temporary files must be cleaned up on crash/error");
  });

  it("crash then --resume converges to complete import state and rolls back cleanly (B3)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-crash-resume-");
    const l = layout(home);

    // Simulate crash after partial write: throw when writing beta agent's files
    try {
      _testFsAtomicHooks.beforeRename = (_tmp, targetPath) => {
        if (targetPath.includes("beta")) {
          throw new Error("Simulated mid-import crash on beta agent");
        }
      };

      await assert.rejects(
        async () => {
          await importOpenclaw({
            home,
            source: fx.root,
            apply: true,
          });
        },
        /Simulated mid-import crash/,
      );
    } finally {
      _testFsAtomicHooks.beforeRename = undefined;
    }

    // Find the crashed runId from imports/
    const importDirs = readdirSync(join(l.home, "imports"));
    const runId = importDirs.find((d) => d.startsWith("run-") || RUN_ID_RE.test(d));
    assert.ok(runId, "crashed run directory must exist");

    // Resume the interrupted run
    const resumedReport = await importOpenclaw({
      home,
      source: fx.root,
      apply: true,
      resume: runId,
    });
    assert.equal(resumedReport.runId, runId);
    assert.ok(existsSync(l.workspaceDir("alpha")));
    assert.ok(existsSync(l.workspaceDir("beta")));

    // Re-running resume converges with 0 new writes
    const secondResume = await importOpenclaw({
      home,
      source: fx.root,
      apply: true,
      resume: runId,
    });
    assert.equal(secondResume.counts.filesCreated, 0);

    // Rollback after resumed run restores pre-import state cleanly
    const rollbackRes = await rollbackImport({
      home,
      reportPath: resumedReport.reportPath!,
      apply: true,
      sourceType: "openclaw",
    });
    assert.equal(rollbackRes.status, "completed");
    assert.ok(!existsSync(l.workspaceDir("alpha")));
    assert.ok(!existsSync(l.workspaceDir("beta")));
  });

  it("--resume validation: rejects non-existent, rolled-back, or incomplete runs (N1)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-resume-val-");
    const l = layout(home);

    // 1. Non-existent run
    await assert.rejects(
      async () => {
        await importOpenclaw({
          home,
          source: fx.root,
          apply: true,
          resume: "non-existent-run-id",
        });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_RESUME_INVALID");
        assert.equal(err.reason, "run-not-resumable");
        return true;
      },
    );

    // 2. Already rolled back run
    const rep = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.ok(rep.reportPath);
    await rollbackImport({ home, reportPath: rep.reportPath, apply: true, sourceType: "openclaw" });

    await assert.rejects(
      async () => {
        await importOpenclaw({
          home,
          source: fx.root,
          apply: true,
          resume: rep.runId,
        });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_RESUME_INVALID");
        assert.equal(err.reason, "run-not-resumable");
        return true;
      },
    );

    // 3. Incomplete run (run directory exists but has no snapshot manifest)
    const emptyRunDir = join(l.home, "imports", "empty-run");
    mkdirSync(emptyRunDir, { recursive: true });
    await assert.rejects(
      async () => {
        await importOpenclaw({
          home,
          source: fx.root,
          apply: true,
          resume: "empty-run",
        });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_RESUME_INVALID");
        assert.equal(err.reason, "run-not-resumable");
        return true;
      },
    );

    // 4. Run has ledger but snapshot manifest is missing (blocker case)
    const runWithLedgerOnly = join(l.home, "imports", "ledger-only-run");
    mkdirSync(runWithLedgerOnly, { recursive: true });
    writeFileSync(join(runWithLedgerOnly, "ledger.jsonl"), '{"ts":"2026-10-05T12:00:00Z","runId":"ledger-only-run","entity":"file","idempotencyKey":"k1","action":"created"}\n');
    await assert.rejects(
      async () => {
        await importOpenclaw({
          home,
          source: fx.root,
          apply: true,
          resume: "ledger-only-run",
        });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_RESUME_INVALID");
        assert.equal(err.reason, "run-not-resumable");
        return true;
      },
    );
  });

  it("ledger robustness: repairs torn last line, counts corrupt lines, aborts rollback on corrupt ledger (N2)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-b4-ledger-robust-");
    const l = layout(home);

    const report = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.ok(report.ledgerPath);
    assert.ok(report.reportPath);

    // Append a torn line (no trailing newline) to ledger
    appendFileSync(report.ledgerPath, "TORN_LINE_WITHOUT_NEWLINE");

    // Resuming import repairs newline before next append, writes repair marker, and counts corrupt line
    const rep2 = await importOpenclaw({
      home,
      source: fx.root,
      apply: true,
      resume: report.runId,
    });
    assert.ok((rep2.counts.corruptLedgerLines ?? 0) >= 1);
    assert.ok(rep2.errors.some((e) => e.reason.includes("corrupt-ledger-lines")));

    // Verify ledger ends with newline and entries did not merge
    const ledgerContent = readFileSync(report.ledgerPath, "utf8");
    assert.ok(ledgerContent.endsWith("\n"));
    assert.ok(ledgerContent.includes('"entity":"system"'));
    assert.ok(ledgerContent.includes('"action":"repaired"'));

    // After resume with repaired torn line, rollback succeeds and is not blocked forever
    const rollbackRepaired = await rollbackImport({
      home,
      reportPath: rep2.reportPath!,
      apply: true,
      sourceType: "openclaw",
    });
    assert.equal(rollbackRepaired.status, "completed");

    // Unrepaired corrupt ledger must abort with ledger-corrupt
    const homeCorrupt = tempDir("p1b-b4-ledger-corrupt-");
    const repCorrupt = await importOpenclaw({ home: homeCorrupt, source: fx.root, apply: true });
    appendFileSync(repCorrupt.ledgerPath!, "CORRUPT_NON_REPAIRED_ENTRY\n");
    await assert.rejects(
      async () => {
        await rollbackImport({
          home: homeCorrupt,
          reportPath: repCorrupt.reportPath!,
          apply: true,
          sourceType: "openclaw",
        });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_ROLLBACK_INVALID");
        assert.equal(err.reason, "ledger-corrupt");
        return true;
      },
    );
  });
});
