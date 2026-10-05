import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireExclusiveLock } from "@plur1bus/module-api";
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
  type M7OpenclawFixture,
} from "./fixtures.ts";
import { treeDigest } from "./tree.ts";

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

  it("dry-run is default: returns complete plan and writes zero files to source or target", async () => {
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

    // Verify channel allowlists
    assert.equal(report.channels.length, 1);
    assert.equal(report.channels[0]!.platform, "telegram");
    assert.deepEqual(report.channels[0]!.allowFrom, ["12345678", "87654321"]);
    assert.deepEqual(report.channels[0]!.groups, ["-100123456789"]);

    // Verify deferred cron
    assert.equal(report.cron.status, "deferred");
    assert.equal(report.cron.count, 2);
    assert.deepEqual(report.cron.jobs.map((j) => j.id).sort(), ["j1", "j2"]);
    assert.equal(report.cron.excludedCount, 1);
  });

  it("apply copies files, registers agents in config.agents, and scaffolds workspace (copy-never-move)", async () => {
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

  it("idempotency: a second apply run produces matched-existing for all entities and zero new writes", async () => {
    const home = tempDir("p1b-test-home-");

    const r1 = await importOpenclaw({ home, source: fx.root, apply: true });
    assert.equal(r1.counts.agentsCreated, 2);
    assert.ok(r1.counts.filesCreated > 0);

    const targetDigestAfterFirst = treeDigest(home, { mtime: false });

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

    // Verify target content is unchanged (except report path runId)
    // All agent workspace files must remain unchanged
    const l = layout(home);
    const wsAlpha = l.workspaceDir("alpha");
    assert.equal(readFileSync(join(wsAlpha, "SOUL.md"), "utf8"), readFileSync(fx.curatedFiles.soul, "utf8"));
  });

  it("single-writer safety: refuses with target-running when core is running", async () => {
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

    // 2. core.lock held by active lock
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

  it("secrets safety: --migrate-secrets fails closed before M2 and reports secret keys only", async () => {
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

  it("leak test: neither report JSON nor human rendering contains FAKE_TOKEN or CONTENT_MARKER", async () => {
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

  it("runs openclaw import end-to-end through CLI envelope", async () => {
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
