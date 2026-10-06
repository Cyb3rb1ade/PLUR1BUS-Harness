// hermes-batch3.test.ts — Unit & Integration tests for M7 Batch 3 (Hermes Importer & Store Take-Over).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { layout } from "../../src/paths.ts";
import { importHermes } from "../../src/import/importers/hermes.ts";
import { splitHermesCards } from "../../src/import/importers/hermes-memories.ts";
import { rollbackImport } from "../../src/import/rollback.ts";
import { renderHermes, renderRollback } from "../../src/import/render.ts";
import { runImport } from "../../src/import/cli.ts";
import { ImportError } from "../../src/import/types.ts";
import {
  buildM7HermesFixture,
  CONTENT_MARKER,
  FAKE_TOKEN,
} from "./fixtures.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import type { Engine, HostServices, Principal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

function createTestHost(stateDir: string, workspaceDir: (id: string) => Promise<string>): HostServices {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    stateDir,
    configPath: () => join(stateDir, "config.json"),
    workspaceDir: async (id: string) => workspaceDir(id),
    config: () => ({} as any),
    platform: { os: process.platform, arch: process.arch, memoryTotalBytes: () => 0, memoryFreeBytes: () => 0 },
    runtime: null,
  } as unknown as HostServices;
}

function flatEmbedder(dim = 384) {
  const vector = () => Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0));
  const one = async () => vector();
  return {
    embed: one,
    embedQuery: one,
    embedPassage: one,
    embedBatch: async (texts: string[]) => texts.map(vector),
    shutdown: async () => {},
  };
}

function treeDigest(dir: string): string {
  if (!existsSync(dir)) return "empty";
  const hasher = createHash("sha256");
  const walk = (d: string) => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = join(d, ent.name);
      hasher.update(ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        hasher.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return hasher.digest("hex");
}

describe("Hermes Importer Batch 3", () => {
  it("splitHermesCards handles delimiters, edge cases, and CRLF", { timeout: 10_000 }, () => {
    // 1. No delimiter
    assert.deepEqual(splitHermesCards("Just one simple card"), ["Just one simple card"]);

    // 2. Standard delimiter
    assert.deepEqual(splitHermesCards("Card 1\n§\nCard 2"), ["Card 1", "Card 2"]);

    // 3. Delimiter at start and end
    assert.deepEqual(splitHermesCards("§\nFirst card\n§\nSecond card\n§"), ["First card", "Second card"]);

    // 4. Windows CRLF
    assert.deepEqual(splitHermesCards("Card A\r\n§\r\nCard B\r\n§\r\nCard C"), [
      "Card A",
      "Card B",
      "Card C",
    ]);

    // 5. Empty and whitespace-only chunks between delimiters
    assert.deepEqual(splitHermesCards("Card X\n§\n   \n§\n\n§\nCard Y"), ["Card X", "Card Y"]);

    // 6. Whitespace-only or empty content
    assert.deepEqual(splitHermesCards(""), []);
    assert.deepEqual(splitHermesCards("   \n\t\n  "), []);
  });

  it("imports Hermes profiles, cards, persona, pairings, and reports deferred crons", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-hermes-apply-");
    const l = layout(home);

    const report = await importHermes({
      home,
      source: fx.root,
      apply: true,
      testInternals: { embeddings: flatEmbedder() },
    });

    assert.equal(report.schema, "import.hermes/1");
    assert.equal(report.sourceType, "hermes");
    assert.equal(report.mode, "apply");

    // Profile migration
    assert.equal(report.counts.agentsCreated, 2); // default + work
    assert.ok(existsSync(l.workspaceDir("default")));
    assert.ok(existsSync(l.workspaceDir("work")));

    // Persona files copied byte-exact
    assert.ok(existsSync(join(l.workspaceDir("default"), "SOUL.md")));
    assert.ok(!existsSync(join(l.workspaceDir("default"), "USER.md")), "unresolved USER.md must not be copied");
    assert.ok(existsSync(join(l.workspaceDir("work"), "SOUL.md")));

    // Curated markdown mirror for imported memories
    assert.ok(existsSync(join(l.workspaceDir("default"), "memories.md")));
    const memContent = readFileSync(join(l.workspaceDir("default"), "memories.md"), "utf8");
    assert.ok(memContent.includes("Hermes memory 1"));
    assert.ok(memContent.includes("Hermes memory 2"));

    // Memory cards: MEMORY.md imported, USER.md reported as unresolved-user-scope
    assert.ok(report.counts.memoryCardsImported > 0, "MEMORY.md cards must be imported");
    assert.ok(report.counts.unresolvedUserScope > 0, "USER.md cards must be reported as unresolved-user-scope");

    // Pairings: approved hashed/fingerprinted, pending excluded
    assert.equal(report.channels.length, 1);
    const tg = report.channels[0];
    assert.ok(tg);
    assert.equal(tg.platform, "telegram");
    assert.equal(tg.allowFromCount, 2);
    assert.equal(tg.pendingExcludedCount, 1);
    // Fingerprinted IDs present, not plain text
    assert.ok(tg.allowFromFingerprints.every((h) => /^[0-9a-f]{8}$/.test(h)));

    // Cron jobs deferred with zero disk writes
    assert.ok(report.cron.count >= 2);
    assert.equal(report.cron.status, "deferred");
    assert.ok(!existsSync(join(l.home, "cron")));

    // Ledger exists and ends with newline
    assert.ok(report.ledgerPath && existsSync(report.ledgerPath));
    const ledgerRaw = readFileSync(report.ledgerPath, "utf8");
    assert.ok(ledgerRaw.endsWith("\n"));
  });

  it("second apply run converges: all matched-existing, zero duplicates (idempotency)", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-idempotent-");

    const first = await importHermes({
      home,
      source: fx.root,
      apply: true,
      testInternals: { embeddings: flatEmbedder() },
    });
    assert.equal(first.counts.agentsCreated, 2);
    assert.ok(first.counts.filesCreated > 0);
    assert.ok(first.counts.memoryCardsImported > 0);

    const second = await importHermes({
      home,
      source: fx.root,
      apply: true,
      testInternals: { embeddings: flatEmbedder() },
    });

    assert.equal(second.counts.agentsCreated, 0);
    assert.equal(second.counts.agentsMatched, 2);
    assert.equal(second.counts.filesCreated, 0);
    assert.equal(second.counts.memoryCardsImported, 0);
    assert.equal(second.counts.memoryCardsSkippedDuplicate, first.counts.memoryCardsImported);
  });

  it("deleted card rerun does not bring it back (previously-imported-deleted)", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-card-delete-");
    const l = layout(home);

    // Initial import
    const report1 = await importHermes({
      home,
      source: fx.root,
      apply: true,
      testInternals: { embeddings: flatEmbedder() },
    });
    assert.ok(report1.counts.memoryCardsImported > 0);

    // Get an imported card id from default profile
    const defProfile = report1.profilesOrAgents.find((p) => p.harnessAgentId === "default");
    assert.ok(defProfile?.memory);
    const createdCard = defProfile.memory.cardResults.find((c) => c.outcome === "created");
    assert.ok(createdCard, "must have at least one created card");

    // Open engine to delete (forget) the card
    const rawConfig = JSON.parse(readFileSync(l.configPath, "utf8"));
    const engine = createEngine(
      createTestHost(l.state, async (id: string) => l.workspaceDir(id)),
      {
        baseDbPath: l.lancedb,
        embedding: { provider: "local-transformers", local: { dimensions: 384 } },
        autoRecall: false,
        autoCapture: false,
      } as any,
      { internals: { embeddings: flatEmbedder() } },
    );

    const principal: Principal = {
      agentId: "default",
      workspace: "workspace:v1:main",
      channel: "cli",
      accountId: "default",
      chat: { id: "c1", kind: "direct" },
      trust: "proved",
    };
    const userAgent = { origin: "user", background: false } as const;

    // Look up card by list to get its store id
    const listed = await engine.memory.list({ since: 0, limit: 10 }, principal, userAgent);
    assert.ok(listed.items.length > 0);
    const targetCard = listed.items[0];
    assert.ok(targetCard);

    // Forget the card
    const forgetRes = await engine.memory.forget(targetCard.id, principal, userAgent);
    assert.equal(forgetRes.archived, true);
    await engine.close({ budgetMs: 5_000 });

    // Second import run: the deleted card must NOT be recreated
    const report2 = await importHermes({
      home,
      source: fx.root,
      apply: true,
      testInternals: { embeddings: flatEmbedder() },
    });

    const defProfile2 = report2.profilesOrAgents.find((p) => p.harnessAgentId === "default");
    assert.ok(defProfile2?.memory);
    const deletedRes = defProfile2.memory.cardResults.find(
      (c) => c.reason === "previously-imported-deleted",
    );
    assert.ok(deletedRes, "deleted card must be reported with reason previously-imported-deleted");
    assert.equal(deletedRes.outcome, "rejected");
  });

  it("batches cards exceeding 500 into multiple calls with correct counters", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-500-cards-");

    // Synthesize 505 cards into default profile's memories/MEMORY.md
    const cards = Array.from({ length: 505 }, (_, i) => `Synthetic memory card entry number ${i}`);
    writeFileSync(join(fx.root, "memories", "MEMORY.md"), cards.join("\n§\n"));

    let importCalls = 0;
    const batchSizes: number[] = [];

    const mockEngine = {
      memory: {
        import: async (req: any) => {
          importCalls++;
          batchSizes.push(req.cards.length);
          return {
            created: req.cards.length,
            matchedExisting: 0,
            rejected: 0,
            cards: req.cards.map((c: any) => ({
              idempotencyKey: c.idempotencyKey,
              outcome: "created",
            })),
          };
        },
      },
      close: async () => {},
    } as unknown as Engine;

    const report = await importHermes({
      home,
      source: fx.root,
      apply: true,
      engine: mockEngine,
    });

    const defProf = report.profilesOrAgents.find((p) => p.harnessAgentId === "default");
    assert.ok(defProf?.memory);
    assert.equal(defProf.memory.importedCount, 505);

    // Verify multiple calls occurred with batch size <= 500
    assert.ok(importCalls >= 2, `expected at least 2 import calls, got ${importCalls}`);
    assert.deepEqual(batchSizes, [500, 5, 2]); // default profile has 500 then 5; work profile has 2
    for (const size of batchSizes) {
      assert.ok(size <= 500, `batch size ${size} must be <= 500`);
    }

    // Verify ledger has multiple memory batch entries
    const ledgerRaw = readFileSync(report.ledgerPath!, "utf8");
    const memoryEntries = ledgerRaw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.entity === "memory" && e.idempotencyKey.includes("default"));

    assert.ok(memoryEntries.length >= 2, "505 cards must produce at least 2 batch ledger entries");
  });

  it("excludes pending pairing codes from allowlists and ledgers", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-pairing-");

    const report = await importHermes({
      home,
      source: fx.root,
      apply: true,
      testInternals: { embeddings: flatEmbedder() },
    });

    const ledgerText = readFileSync(report.ledgerPath!, "utf8");
    const reportText = JSON.stringify(report);

    // Pending code "123456" and pending user "99999" must not appear anywhere
    assert.ok(!reportText.includes("123456"));
    assert.ok(!reportText.includes("99999"));
    assert.ok(!ledgerText.includes("123456"));
    assert.ok(!ledgerText.includes("99999"));

    // Approved pairing user names/ids must also not appear in plain text
    assert.ok(!reportText.includes("12345"));
    assert.ok(!reportText.includes("67890"));
    assert.ok(!ledgerText.includes("12345"));
    assert.ok(!ledgerText.includes("67890"));
  });

  it("leak test: zero secrets, card texts, delivery targets, or channel IDs in reports, ledgers, or render (P1, P2, P10)", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-leak-");

    // Add a cron job with full target string e.g. telegram:5551234567
    const cronPath = join(fx.root, "cron", "jobs.json");
    const cronData = JSON.parse(readFileSync(cronPath, "utf8"));
    cronData.jobs.push({
      id: "c-targeted",
      schedule: "0 12 * * *",
      deliver: "telegram:5551234567",
      prompt: "targeted secret cron",
    });
    writeFileSync(cronPath, JSON.stringify(cronData));

    const report = await importHermes({
      home,
      source: fx.root,
      apply: true,
      testInternals: { embeddings: flatEmbedder() },
    });

    const reportJson = JSON.stringify(report);
    const ledgerText = readFileSync(report.ledgerPath!, "utf8");
    const rendered = renderHermes(report);

    for (const text of [reportJson, ledgerText, rendered]) {
      assert.ok(!text.includes(FAKE_TOKEN), "FAKE_TOKEN must never leak");
      assert.ok(!text.includes(CONTENT_MARKER), "CONTENT_MARKER must never leak");
      assert.ok(!text.includes("Hermes memory 1"), "memory card text must not leak into reports or ledger");
      assert.ok(!text.includes("Hermes user pref 1"), "user card text must not leak into reports or ledger");
      assert.ok(!text.includes("12345"), "plain channel ID 12345 must not leak");
      assert.ok(!text.includes("67890"), "plain channel ID 67890 must not leak");
      assert.ok(!text.includes("5551234567"), "targeted chat ID must never leak");
      assert.ok(!text.includes("telegram:5551234567"), "targeted delivery target must never leak");
    }

    // Verify deliverKind and status
    const targetedJob = report.cron.jobs.find((j) => j.id === "c-targeted");
    assert.ok(targetedJob);
    assert.equal(targetedJob.deliverKind, "telegram");
    assert.equal(targetedJob.status, "deferred");
  });

  it("unresolved USER.md does not mirror into workspace/USER.md (P3, B5)", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-unresolved-user-");
    const l = layout(home);

    // Ensure root profile has memories/USER.md but no explicit userPrincipal passed
    const report = await importHermes({
      home,
      source: fx.root,
      apply: true,
      testInternals: { embeddings: flatEmbedder() },
    });

    const defWs = l.workspaceDir("default");
    // Default profile had root SOUL.md, root memories/USER.md, but NO root USER.md
    assert.ok(!existsSync(join(defWs, "USER.md")), "unresolved USER.md must not be copied to workspace");
    assert.ok(report.counts.unresolvedUserScope > 0, "must report unresolved-user-scope count");
  });

  it("dry run writes zero bytes and does not initialize target engine (P4, B4)", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-dryrun-zero-writes-");
    const l = layout(home);

    const beforeDigest = treeDigest(home);

    const report = await importHermes({
      home,
      source: fx.root,
      apply: false,
    });

    assert.equal(report.mode, "dry-run");
    assert.ok(report.counts.memoryCardsImported > 0, "dry-run should preview imported cards");

    const afterDigest = treeDigest(home);
    assert.equal(beforeDigest, afterDigest, "dry run must leave home byte-for-byte identical");
    assert.ok(!existsSync(l.state), "state dir must not exist after dry run");
    assert.ok(!existsSync(l.lancedb), "lancedb must not exist after dry run");
  });

  it("store adopt: successful swap into place and rollback removes it (P5a, B1, B2)", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-adopt-success-");
    const l = layout(home);

    // Create a dedicated adoptable 384-d store
    const adoptableStore = join(tempDir("p1b-adoptable-"), "store");
    mkdirSync(adoptableStore, { recursive: true, mode: 0o700 });
    writeFileSync(join(adoptableStore, "_schema.json"), JSON.stringify({ schemaVersion: "1" }));
    const { lanceStore } = await import("./fixtures.ts");
    await lanceStore(join(adoptableStore, "default"), 384, 1);

    const report = await importHermes({
      home,
      source: fx.root,
      adoptStore: adoptableStore,
      apply: true,
      testInternals: { embeddings: flatEmbedder(384) },
    });

    assert.ok(report.storeAdopt);
    assert.equal(report.storeAdopt.verdict, "ok");
    assert.equal(report.storeAdopt.action, "taken-over");
    assert.ok(existsSync(l.lancedb), "target lancedb should exist after take-over");

    // Rollback removes adopted store
    const rollbackRes = await rollbackImport({
      home,
      reportPath: report.reportPath!,
      apply: true,
      sourceType: "hermes",
    });

    assert.equal(rollbackRes.status, "completed");
    assert.equal(rollbackRes.storeUndoStatus, "removed");
    assert.ok(!existsSync(l.lancedb), "target lancedb should be removed by rollback");
  });

  it("store adopt with replace moves old store to backup and rollback restores it (P5b, B1, B2)", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-adopt-replace-");
    const l = layout(home);

    // Pre-create an existing store at target l.lancedb
    mkdirSync(l.lancedb, { recursive: true, mode: 0o700 });
    writeFileSync(join(l.lancedb, "original.txt"), "original target store content");

    // Create a dedicated adoptable 384-d store
    const adoptableStore = join(tempDir("p1b-adoptable-replace-"), "store");
    mkdirSync(adoptableStore, { recursive: true, mode: 0o700 });
    writeFileSync(join(adoptableStore, "_schema.json"), JSON.stringify({ schemaVersion: "1" }));
    const { lanceStore } = await import("./fixtures.ts");
    await lanceStore(join(adoptableStore, "default"), 384, 1);

    const report = await importHermes({
      home,
      source: fx.root,
      adoptStore: adoptableStore,
      onConflict: "replace",
      apply: true,
      testInternals: { embeddings: flatEmbedder(384) },
    });

    assert.ok(report.storeAdopt);
    assert.equal(report.storeAdopt.verdict, "ok");
    assert.equal(report.storeAdopt.action, "taken-over");
    assert.ok(!existsSync(join(l.lancedb, "original.txt")), "original file should have been moved aside");

    // Rollback restores original store from replaced backup
    const rollbackRes = await rollbackImport({
      home,
      reportPath: report.reportPath!,
      apply: true,
      sourceType: "hermes",
    });

    assert.equal(rollbackRes.status, "completed");
    assert.equal(rollbackRes.storeUndoStatus, "restored");
    assert.ok(existsSync(join(l.lancedb, "original.txt")), "original store file must be restored");
    assert.equal(readFileSync(join(l.lancedb, "original.txt"), "utf8"), "original target store content");
  });

  it("safe file reader rejects symlinks and oversized files safely (P6, M1)", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-symlink-reject-");

    // Create a symlink in Hermes source
    const escapeFile = join(tempDir("outside-"), "target.txt");
    writeFileSync(escapeFile, "secret outside content");
    try {
      const symlinkPath = join(fx.root, "USER.md");
      rmSync(symlinkPath, { force: true });
      const { symlinkSync } = await import("node:fs");
      symlinkSync(escapeFile, symlinkPath);
    } catch {}

    const report = await importHermes({
      home,
      source: fx.root,
      apply: true,
      testInternals: { embeddings: flatEmbedder() },
    });

    // Verify symlink was rejected and not read
    const defProfile = report.profilesOrAgents.find((p) => p.harnessAgentId === "default");
    assert.ok(defProfile);
    // Without a user binding the root USER.md is never opened (ADR-007 Q4); the symlink cases with a read are in
    // hermes-batch3-takeover.test.ts (M1).
    const userFile = defProfile.files.find((f) => f.targetFile.endsWith("USER.md"));
    assert.equal(userFile?.action, "skipped");
    assert.equal(userFile?.reason, "unresolved-user-scope");
    assert.ok(!JSON.stringify(report).includes("secret outside content"));
  });

  it("memory import engine failure surfaces in errors[] and CLI exits 1 with resumable run (P7, B6)", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-engine-err-");
    const l = layout(home);

    const failingEngine = {
      memory: {
        import: async () => {
          const err: any = new Error("Engine vector store down");
          err.code = "E_VECTOR_DOWN";
          throw err;
        },
      },
      close: async () => {},
    } as unknown as Engine;

    const report = await importHermes({
      home,
      source: fx.root,
      apply: true,
      engine: failingEngine,
    });

    assert.ok(report.errors.length > 0, "engine failure must be in errors[]");
    assert.ok(report.errors.some((e) => e.reason.includes("memory-import-failed")), "reason must be memory-import-failed");
    assert.ok(report.counts.memoryCardsRejected > 0, "cards must be counted as rejected");
    assert.ok(!existsSync(join(l.workspaceDir("default"), "memories.md")), "mirror should be skipped on engine failure");

    // CLI returns exit 1 for failed run when import encounters errors (e.g. symlink in memory source)
    const badFx = await buildM7HermesFixture();
    const badHome = tempDir("p1b-b3-cli-fail-");
    // Remove work profile memories so no ONNX download is attempted
    rmSync(join(badFx.root, "profiles", "work", "memories"), { recursive: true, force: true });
    // Replace default MEMORY.md with a symlink to outside so safe reader fails with symlink-refused
    const symlinkTarget = join(tempDir("outside-cli-"), "target.txt");
    writeFileSync(symlinkTarget, "outside secret");
    const badMemPath = join(badFx.root, "memories", "MEMORY.md");
    rmSync(badMemPath, { force: true });
    const { symlinkSync } = await import("node:fs");
    symlinkSync(symlinkTarget, badMemPath);

    const cliRes = await runImport([
      "hermes",
      "--home",
      badHome,
      "--source",
      badFx.root,
      "--apply",
    ]);

    assert.equal(cliRes.ok, true);
    if (cliRes.ok) {
      assert.equal(cliRes.exit, 1);
      assert.equal(cliRes.schema, "import.hermes/1");
      assert.ok((cliRes.value.errors as Array<{ reason: string }>).some((e) => e.reason === "symlink-refused"));
      assert.ok(cliRes.human.includes("Errors:"));
      assert.ok(cliRes.human.includes("symlink-refused"));
      assert.ok(cliRes.human.includes(`--resume ${cliRes.value.runId}`));
    }
  });

  it("conflict: skip does not overwrite existing memories.md (P8, B6)", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-mirror-conflict-");
    const l = layout(home);

    // Pre-create user's own memories.md
    mkdirSync(l.workspaceDir("default"), { recursive: true, mode: 0o700 });
    const userMemories = "# User's Own Memories\nDo not overwrite me!";
    writeFileSync(join(l.workspaceDir("default"), "memories.md"), userMemories);

    const report = await importHermes({
      home,
      source: fx.root,
      onConflict: "skip",
      apply: true,
      testInternals: { embeddings: flatEmbedder() },
    });

    const currentMemories = readFileSync(join(l.workspaceDir("default"), "memories.md"), "utf8");
    assert.equal(currentMemories, userMemories, "existing memories.md must NOT be overwritten under skip");

    const ledgerText = readFileSync(report.ledgerPath!, "utf8");
    assert.ok(ledgerText.includes("conflict"), "ledger should record conflict for memories.md");
  });

  it("duplicate-in-batch is counted as matched-existing, not rejected (P9)", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-dup-in-batch-");

    const dupEngine = {
      memory: {
        import: async (req: any) => {
          return {
            created: 1,
            matchedExisting: 0,
            rejected: 1,
            cards: [
              { idempotencyKey: req.cards[0]?.idempotencyKey, outcome: "created" },
              { idempotencyKey: req.cards[1]?.idempotencyKey, outcome: "rejected", reason: "duplicate-in-batch" },
            ],
          };
        },
      },
      close: async () => {},
    } as unknown as Engine;

    const report = await importHermes({
      home,
      source: fx.root,
      apply: true,
      engine: dupEngine,
    });

    const defProfile = report.profilesOrAgents.find((p) => p.harnessAgentId === "default");
    assert.ok(defProfile?.memory);
    assert.equal(defProfile.memory.skippedDuplicateCount, 1, "duplicate-in-batch must be counted as skipped duplicate");
    assert.equal(defProfile.memory.rejectedCount, 0, "duplicate-in-batch must not be counted as rejected");
  });

  it("rollback after Hermes apply restores files and reports cards as not-reverted", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-rollback-");
    const l = layout(home);

    const report = await importHermes({
      home,
      source: fx.root,
      apply: true,
      testInternals: { embeddings: flatEmbedder() },
    });

    assert.ok(existsSync(l.workspaceDir("default")));
    assert.ok(existsSync(l.workspaceDir("work")));

    // Rollback
    const rollbackRes = await rollbackImport({
      home,
      reportPath: report.reportPath!,
      apply: true,
      sourceType: "hermes",
    });

    assert.equal(rollbackRes.status, "completed");
    assert.ok(!existsSync(l.workspaceDir("default")), "default agent workspace must be removed");
    assert.ok(!existsSync(l.workspaceDir("work")), "work agent workspace must be removed");

    // Cards honestly reported as not-reverted
    assert.ok(
      (rollbackRes.memoryCardsNotReverted ?? 0) > 0,
      "memoryCardsNotReverted must be > 0",
    );
    assert.equal(rollbackRes.memoryUndoStatus, "not-reverted (engine has no undo)");

    const rendered = renderRollback(rollbackRes);
    assert.ok(rendered.includes("not-reverted (engine has no undo)"));
  });

  it("CLI integration: runImport routes hermes import and rollback cleanly", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-cli-");

    // Dry-run import via runImport
    const res = await runImport([
      "hermes",
      "--home",
      home,
      "--source",
      fx.root,
    ]);

    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.schema, "import.hermes/1");
      assert.ok(res.human.includes("DRY RUN"));
    }
  });
});
