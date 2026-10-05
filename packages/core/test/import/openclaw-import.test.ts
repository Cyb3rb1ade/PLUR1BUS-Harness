import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { acquireExclusiveLock } from "@plur1bus/module-api";
import { validate } from "@plur1bus/config-schema";
import { layout } from "../../src/paths.ts";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { renderOpenclaw } from "../../src/import/render.ts";
import { runImport } from "../../src/import/cli.ts";
import { ImportError } from "../../src/import/types.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  buildM7OpenclawFixture,
  CONTENT_MARKER,
  FAKE_TOKEN,
  SYMLINKS,
  type M7OpenclawFixture,
} from "./fixtures.ts";
import { treeDigest, treeEntries } from "./tree.ts";

function targetDigestExcludingImports(dir: string): string {
  return treeEntries(dir, { mtime: false })
    .filter((e) => !e.startsWith("D imports") && !e.startsWith("F imports") && !e.startsWith("L imports"))
    .join("\n");
}

describe("OpenClaw importer (Batch 2)", () => {
  let fx: M7OpenclawFixture;
  let srcDigest: string;

  before(async () => {
    fx = await buildM7OpenclawFixture();
    srcDigest = treeDigest(fx.base);
  });

  after(() => {
    fx.close();
  });

  it("dry-run is default: returns complete plan and writes zero files to source or target", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-test-home-");
    const beforeTarget = treeDigest(home);

    const report = await importOpenclaw({ home, source: fx.root });

    assert.equal(report.mode, "dry-run");
    assert.equal(report.reportPath, null);
    assert.equal(treeDigest(fx.base), srcDigest, "source fixture was modified during dry-run");
    assert.equal(treeDigest(home), beforeTarget, "target home was modified during dry-run");

    assert.equal(report.agents.length, 2);
    assert.equal(report.counts.agentsCreated, 2);
    assert.equal(report.counts.agentsMatched, 0);
    assert.ok(report.counts.filesCreated > 0, "should have planned files to create");
    assert.equal(report.counts.filesMatched, 0);

    const alpha = report.agents.find((a) => a.harnessAgentId === "alpha");
    assert.ok(alpha);
    assert.equal(alpha.action, "created");
    assert.ok(alpha.files.some((f) => f.targetFile === "SOUL.md" && f.action === "created"));
    assert.ok(alpha.files.some((f) => f.targetFile === "memories.md" && f.action === "created"));
    assert.ok(alpha.files.some((f) => f.targetFile === "USER.md" && f.action === "created"));
    assert.ok(alpha.files.some((f) => f.targetFile === "knowledgepool.md" && f.action === "created"));
    assert.ok(alpha.files.some((f) => f.targetFile === "dreaming.md" && f.action === "created"));
    assert.ok(alpha.files.some((f) => f.targetFile.startsWith("DailyNote_2026-01-01") && f.action === "created"));

    // Verify channel allowlists (I1: deferred)
    assert.equal(report.channels.length, 1);
    assert.equal(report.channels[0]!.platform, "telegram");
    assert.equal(report.channels[0]!.action, "deferred");
    assert.deepEqual(report.channels[0]!.allowFrom, ["12345678", "87654321"]);
    assert.deepEqual(report.channels[0]!.groups, ["-100123456789"]);

    // Verify deferred cron
    assert.equal(report.cron.status, "deferred");
    assert.equal(report.cron.count, 2);
    assert.deepEqual(report.cron.jobs.map((j) => j.id).sort(), ["j1", "j2"]);
    assert.equal(report.cron.excludedCount, 1);
  });

  it("apply copies files, registers agents in config.agents, and scaffolds workspace (copy-never-move)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-test-home-");
    const l = layout(home);

    const report = await importOpenclaw({ home, source: fx.root, apply: true });

    assert.equal(report.mode, "apply");
    assert.ok(report.reportPath && existsSync(report.reportPath), "report.json was not written");
    assert.equal(treeDigest(fx.base), srcDigest, "source fixture was modified during apply (not copy-never-move)");

    // Verify config.agents
    assert.ok(existsSync(l.configPath));
    const cfg = JSON.parse(readFileSync(l.configPath, "utf8"));
    assert.ok(cfg.agents.alpha, "agent alpha missing from config.agents");
    assert.ok(cfg.agents.beta, "agent beta missing from config.agents");

    // Verify scaffolded template files in agentDir
    assert.ok(existsSync(join(l.agentDir("alpha"), "SOUL.md")));
    assert.ok(existsSync(join(l.agentDir("alpha"), "USER.md")));
    assert.ok(existsSync(join(l.agentDir("alpha"), "persona-voice.md")));

    // Verify curated files placed in l.workspaceDir("alpha")
    const wsAlpha = l.workspaceDir("alpha");
    assert.ok(existsSync(join(wsAlpha, "SOUL.md")));
    assert.equal(readFileSync(join(wsAlpha, "SOUL.md"), "utf8"), readFileSync(fx.curatedFiles.soul, "utf8"));

    assert.ok(existsSync(join(wsAlpha, "memories.md")));
    assert.equal(readFileSync(join(wsAlpha, "memories.md"), "utf8"), readFileSync(fx.curatedFiles.memory, "utf8"));

    assert.ok(existsSync(join(wsAlpha, "USER.md")));
    assert.equal(readFileSync(join(wsAlpha, "USER.md"), "utf8"), readFileSync(fx.curatedFiles.user, "utf8"));

    assert.ok(existsSync(join(wsAlpha, "knowledgepool.md")));
    assert.equal(readFileSync(join(wsAlpha, "knowledgepool.md"), "utf8"), readFileSync(fx.curatedFiles.knowledge, "utf8"));

    assert.ok(existsSync(join(wsAlpha, "dreaming.md")));
    assert.equal(readFileSync(join(wsAlpha, "dreaming.md"), "utf8"), readFileSync(fx.curatedFiles.dreams, "utf8"));

    assert.ok(existsSync(join(wsAlpha, "DailyNote_2026-01-01_000000.md")));
    assert.equal(readFileSync(join(wsAlpha, "DailyNote_2026-01-01_000000.md"), "utf8"), readFileSync(fx.curatedFiles.dailyNote, "utf8"));

    // Verify zero cron files written to disk
    assert.ok(!existsSync(join(home, "cron")));
    assert.ok(!existsSync(join(home, "state", "system-jobs", "cron")));
  });

  it("idempotency: a second apply run produces matched-existing for all entities and zero new writes outside imports/ (I4)", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-test-home-");

    const r1 = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.equal(r1.counts.agentsCreated, 2);
    assert.ok(r1.counts.filesCreated > 0);

    const targetDigestAfterFirst = targetDigestExcludingImports(home);

    // Second apply run
    const r2 = await importOpenclaw({ home, source: fx.root, apply: true });

    assert.equal(r2.counts.agentsCreated, 0, "second run should not create agents");
    assert.equal(r2.counts.agentsMatched, 2, "second run should match all existing agents");
    assert.equal(r2.counts.filesCreated, 0, "second run should not create files");
    assert.equal(r2.counts.filesMatched, r1.counts.filesCreated, "second run should match all existing files");

    for (const a of r2.agents) {
      assert.equal(a.action, "matched-existing");
      for (const f of a.files) {
        assert.equal(f.action, "matched-existing");
      }
    }

    // Verify target content is byte-identical outside imports/ (I4)
    const targetDigestAfterSecond = targetDigestExcludingImports(home);
    assert.equal(targetDigestAfterSecond, targetDigestAfterFirst, "target state outside imports/ modified on second apply run");
  });

  it("single-writer safety (C1): refuses with target-running when core is running or lock is held", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-test-home-");
    const l = layout(home);

    // 1. Alive PID in core.pid
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(l.corePid, `${process.pid}\n`);

    await assert.rejects(
      async () => {
        await importOpenclaw({ home, source: fx.root, apply: true });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_CORE_RUNNING");
        assert.equal(err.reason, "target-running");
        return true;
      },
    );

    // Stale PID in core.pid (non-existent process) should not block
    writeFileSync(l.corePid, "99999999\n");
    const dryRun = await importOpenclaw({ home, source: fx.root });
    assert.equal(dryRun.mode, "dry-run");

    // 2. core.lock held by active lock -> apply refused
    const lock = acquireExclusiveLock(l.coreLock, { instanceId: "test-lock" });
    assert.ok(lock, "could not acquire test lock");
    try {
      await assert.rejects(
        async () => {
          await importOpenclaw({ home, source: fx.root, apply: true });
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
  });

  it("conflict safety (C2): differing target files are not overwritten and reported as conflict", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-test-home-");
    const l = layout(home);

    // Pre-populate target workspace with a custom SOUL.md with DIFFERENT content
    const wsAlpha = l.workspaceDir("alpha");
    mkdirSync(wsAlpha, { recursive: true });
    const customContent = "# Custom User SOUL\nDo not overwrite this custom persona!\n";
    writeFileSync(join(wsAlpha, "SOUL.md"), customContent);

    // Run apply with default onConflict (skip)
    const report = await importOpenclaw({ home, source: fx.root, apply: true });

    const alpha = report.agents.find((a) => a.harnessAgentId === "alpha");
    assert.ok(alpha);
    const soulReport = alpha.files.find((f) => f.targetFile === "SOUL.md");
    assert.ok(soulReport);
    assert.equal(soulReport.action, "conflict");
    assert.equal(soulReport.reason, "content-differs");

    // Assert that the pre-existing file content was preserved untouched
    assert.equal(readFileSync(join(wsAlpha, "SOUL.md"), "utf8"), customContent);
    assert.ok(report.counts.filesConflicted >= 1);
  });

  it("untrusted agentId safety (C3): invalid, path-traversal, reserved and proto agent IDs are rejected", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-test-home-");
    const srcDir = tempDir("p1b-untrusted-src-");

    // Create an openclaw fixture with malicious agent IDs
    const invalidIds = ["../evil", "a/b", "__proto__", "constructor", "CON", "a".repeat(65)];
    const openclawJson = {
      meta: { lastTouchedVersion: "2026.9.5" },
      agents: {
        list: invalidIds.map((id) => ({
          id,
          workspace: join(srcDir, `ws-${id.replace(/[^a-zA-Z0-9]/g, "_")}`),
        })),
      },
    };
    writeFileSync(join(srcDir, "openclaw.json"), JSON.stringify(openclawJson));

    const report = await importOpenclaw({ home, source: srcDir, apply: true });

    assert.equal(report.counts.agentsCreated, 0);
    assert.equal(report.counts.agentsRejected, invalidIds.length);
    assert.equal(report.counts.filesCreated, 0);

    for (const a of report.agents) {
      assert.equal(a.action, "rejected");
      assert.equal(a.reason, "invalid-agent-id");
      assert.equal(a.files.length, 0);
    }

    // Verify zero paths created outside or in agents
    const l = layout(home);
    assert.ok(!existsSync(join(home, "evil")));
    assert.ok(!existsSync(join(l.agents, "evil")));
    assert.ok(!existsSync(join(l.agents, "__proto__")));
  });

  it("config preservation and schema validation (C4): preserves unrelated keys and writes atomically", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-test-home-");
    const l = layout(home);

    // Pre-create config.json with unrelated keys under engine, modules, and existing agents
    mkdirSync(home, { recursive: true });
    const initialConfig = {
      $schema: "https://plur1bus.dev/schema/config/1/config.schema.json",
      schemaVersion: 1,
      core: { logLevel: "error" },
      engine: {
        baseDbPathOverride: join(home, "custom-lancedb"),
        customEngineSetting: "preserved-val",
      },
      modules: {
        custom_mod: {
          enabled: true,
          apiKey: "custom-api-key",
        },
      },
      agents: {
        "existing-bernd": {
          createdAt: "2026-09-01T00:00:00.000Z",
          displayName: "Bernd Das Brot",
        },
      },
    };
    writeFileSync(l.configPath, JSON.stringify(initialConfig, null, 2) + "\n");

    const report = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.equal(report.counts.agentsCreated, 2);

    // Read back config.json
    const updated = JSON.parse(readFileSync(l.configPath, "utf8"));

    // Verify schema validity
    const val = validate(updated);
    assert.ok(val.ok, `config after import should validate against schema: ${val.ok ? "" : (val as any).errors.join("; ")}`);

    // Verify unrelated keys preserved exactly
    assert.equal(updated.core.logLevel, "error");
    assert.equal(updated.engine.baseDbPathOverride, join(home, "custom-lancedb"));
    assert.equal(updated.engine.customEngineSetting, "preserved-val");
    assert.deepEqual(updated.modules.custom_mod, { enabled: true, apiKey: "custom-api-key" });
    assert.equal(updated.agents["existing-bernd"].displayName, "Bernd Das Brot");

    // Verify imported agents added
    assert.ok(updated.agents.alpha);
    assert.ok(updated.agents.beta);
  });

  it("symlink escape safety (I2): symlinks escaping source root are skipped and not copied", { timeout: 30_000, skip: !SYMLINKS.file ? "symlinks not supported" : undefined }, async () => {
    const home = tempDir("p1b-test-home-");
    const srcBase = tempDir("p1b-symlink-src-");
    const outsideSecret = tempDir("p1b-outside-secret-");
    const secretFile = join(outsideSecret, "secret.txt");
    writeFileSync(secretFile, "HIGHLY-CONFIDENTIAL-SECRET");

    const root = join(srcBase, ".openclaw");
    const ws = join(root, "ws-alpha");
    mkdirSync(ws, { recursive: true });

    // Link escaping source root
    symlinkSync(secretFile, join(ws, "SOUL.md"), "file");
    writeFileSync(join(root, "openclaw.json"), JSON.stringify({
      meta: { lastTouchedVersion: "2026.9.5" },
      agents: { list: [{ id: "alpha", workspace: ws }] },
    }));

    const report = await importOpenclaw({ home, source: root, apply: true });
    const alpha = report.agents.find((a) => a.harnessAgentId === "alpha");
    assert.ok(alpha);
    const soulReport = alpha.files.find((f) => f.targetFile === "SOUL.md");
    assert.ok(soulReport);
    assert.equal(soulReport.action, "skipped");
    assert.equal(soulReport.reason, "symlink-escape");

    // Target workspace must NOT contain the secret
    const l = layout(home);
    const targetSoul = join(l.workspaceDir("alpha"), "SOUL.md");
    // scaffoldFiles might have scaffolded the template in agentDir, but workspaceDir/SOUL.md must not contain the secret
    if (existsSync(targetSoul)) {
      assert.ok(!readFileSync(targetSoul, "utf8").includes("HIGHLY-CONFIDENTIAL-SECRET"));
    }
  });

  it("daily notes collision handling (I3): detects name collision in source daily notes", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-test-home-");
    const srcBase = tempDir("p1b-collision-src-");
    const root = join(srcBase, ".openclaw");
    const ws = join(root, "ws-alpha");
    const memDir = join(ws, "memory");
    mkdirSync(memDir, { recursive: true });

    // Two files that both map to DailyNote_2026-01-01_000000.md
    writeFileSync(join(memDir, "2026-01-01.md"), "Daily Note 1");
    writeFileSync(join(memDir, "2026-01-01_000000.md"), "Daily Note 2");

    writeFileSync(join(root, "openclaw.json"), JSON.stringify({
      meta: { lastTouchedVersion: "2026.9.5" },
      agents: { list: [{ id: "alpha", workspace: ws }] },
    }));

    const report = await importOpenclaw({ home, source: root, apply: true });
    const alpha = report.agents.find((a) => a.harnessAgentId === "alpha");
    assert.ok(alpha);

    // One should be created, the other conflict
    const dailyFiles = alpha.files.filter((f) => f.targetFile === "DailyNote_2026-01-01_000000.md");
    assert.equal(dailyFiles.length, 2);
    assert.ok(dailyFiles.some((f) => f.action === "created"));
    assert.ok(dailyFiles.some((f) => f.action === "conflict" && f.reason === "target-name-collision"));
  });

  it("secrets safety: --migrate-secrets fails closed before M2 and reports secret keys only", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-test-home-");

    // --migrate-secrets refused
    await assert.rejects(
      async () => {
        await importOpenclaw({ home, source: fx.root, migrateSecrets: true });
      },
      (err: any) => {
        assert.ok(err instanceof ImportError);
        assert.equal(err.code, "E_SECRET_STORE_UNAVAILABLE");
        assert.equal(err.reason, "secret-store-unavailable");
        return true;
      },
    );

    // Regular import lists unmigrated keys without values
    const report = await importOpenclaw({ home, source: fx.root });
    assert.equal(report.secrets.opted_in, false);
    assert.ok(report.secrets.count > 0);
    assert.ok(report.secrets.unmigrated_secrets.includes("TELEGRAM_BOT_TOKEN"));
    assert.ok(report.secrets.unmigrated_secrets.includes("OPENAI_API_KEY"));
  });

  it("leak test: neither report JSON nor human rendering contains FAKE_TOKEN or CONTENT_MARKER", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-test-home-");

    const dryRunReport = await importOpenclaw({ home, source: fx.root });
    const dryRunJson = JSON.stringify(dryRunReport);
    const dryRunHuman = renderOpenclaw(dryRunReport);

    assert.ok(!dryRunJson.includes(FAKE_TOKEN), "FAKE_TOKEN found in dry-run JSON report");
    assert.ok(!dryRunJson.includes(CONTENT_MARKER), "CONTENT_MARKER found in dry-run JSON report");
    assert.ok(!dryRunHuman.includes(FAKE_TOKEN), "FAKE_TOKEN found in dry-run human report");
    assert.ok(!dryRunHuman.includes(CONTENT_MARKER), "CONTENT_MARKER found in dry-run human report");

    const applyReport = await importOpenclaw({ home, source: fx.root, apply: true });
    const applyJson = JSON.stringify(applyReport);
    const applyHuman = renderOpenclaw(applyReport);

    assert.ok(!applyJson.includes(FAKE_TOKEN), "FAKE_TOKEN found in apply JSON report");
    assert.ok(!applyJson.includes(CONTENT_MARKER), "CONTENT_MARKER found in apply JSON report");
    assert.ok(!applyHuman.includes(FAKE_TOKEN), "FAKE_TOKEN found in apply human report");
    assert.ok(!applyHuman.includes(CONTENT_MARKER), "CONTENT_MARKER found in apply human report");
  });

  it("runs openclaw import end-to-end through CLI envelope", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-test-home-");

    // Dry-run through CLI
    const dryRes = await runImport(["openclaw", "--source", fx.root, "--home", home], {}, "/nonexistent-home");
    assert.ok(dryRes.ok);
    assert.equal(dryRes.schema, "import.openclaw/1");
    assert.equal(dryRes.value.mode, "dry-run");
    assert.ok(!JSON.stringify(dryRes).includes(FAKE_TOKEN));
    assert.ok(!JSON.stringify(dryRes).includes(CONTENT_MARKER));
    assert.ok(!dryRes.human.includes(FAKE_TOKEN));
    assert.ok(!dryRes.human.includes(CONTENT_MARKER));

    // Refusal of --migrate-secrets through CLI
    const secRes = await runImport(["openclaw", "--source", fx.root, "--home", home, "--migrate-secrets"], {}, "/nonexistent-home");
    assert.equal(secRes.ok, false);
    assert.equal(secRes.error, "E_SECRET_STORE_UNAVAILABLE");
    assert.equal(secRes.reason, "secret-store-unavailable");

    // Apply through CLI
    const applyRes = await runImport(["openclaw", "--source", fx.root, "--home", home, "--apply"], {}, "/nonexistent-home");
    assert.ok(applyRes.ok);
    assert.equal(applyRes.schema, "import.openclaw/1");
    assert.equal(applyRes.value.mode, "apply");
    assert.ok(!JSON.stringify(applyRes).includes(FAKE_TOKEN));
    assert.ok(!JSON.stringify(applyRes).includes(CONTENT_MARKER));
    assert.ok(!applyRes.human.includes(FAKE_TOKEN));
    assert.ok(!applyRes.human.includes(CONTENT_MARKER));
  });
});
