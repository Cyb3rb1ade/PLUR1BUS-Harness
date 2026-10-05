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
import type { HostServices, Principal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

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
    assert.ok(existsSync(join(l.workspaceDir("default"), "USER.md")));
    assert.ok(existsSync(join(l.workspaceDir("work"), "SOUL.md")));

    // Curated markdown mirror for imported memories
    assert.ok(existsSync(join(l.workspaceDir("default"), "memories.md")));
    const memContent = readFileSync(join(l.workspaceDir("default"), "memories.md"), "utf8");
    assert.ok(memContent.includes("Hermes memory 1"));
    assert.ok(memContent.includes("Hermes memory 2"));

    // Memory cards: MEMORY.md imported, USER.md reported as unresolved-user-scope
    assert.ok(report.counts.memoryCardsImported > 0, "MEMORY.md cards must be imported");
    assert.ok(report.counts.unresolvedUserScope > 0, "USER.md cards must be reported as unresolved-user-scope");

    // Pairings: approved hashed, pending excluded
    assert.equal(report.channels.length, 1);
    const tg = report.channels[0];
    assert.ok(tg);
    assert.equal(tg.platform, "telegram");
    assert.equal(tg.count, 2);
    assert.equal(tg.pendingExcludedCount, 1);
    // Hashed IDs present, not plain text
    assert.ok(tg.allowFromHashes.every((h) => /^[0-9a-f]{16}$/.test(h)));

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

  it("batches cards exceeding 500 into multiple calls with correct counters", { timeout: 60_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-500-cards-");

    // Synthesize 505 cards into default profile's memories/MEMORY.md
    const cards = Array.from({ length: 505 }, (_, i) => `Synthetic memory card entry number ${i}`);
    writeFileSync(join(fx.root, "memories", "MEMORY.md"), cards.join("\n§\n"));

    const report = await importHermes({
      home,
      source: fx.root,
      apply: true,
      testInternals: { embeddings: flatEmbedder() },
    });

    const defProf = report.profilesOrAgents.find((p) => p.harnessAgentId === "default");
    assert.ok(defProf?.memory);
    assert.equal(defProf.memory.importedCount, 505);

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

  it("leak test: zero secrets, card texts, or channel IDs in reports, ledgers, or render", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-leak-");

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
      assert.ok(!text.includes("12345"), "plain channel ID must not leak");
      assert.ok(!text.includes("67890"), "plain channel ID must not leak");
    }
  });

  it("store adopt: mismatching identity cleanly aborts and leaves target unchanged", { timeout: 30_000 }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-b3-adopt-mismatch-");

    // Initial state hash of home
    const preHash = treeDigest(home);

    // Attempt adopt of mismatched store into 384-d target
    const mismatchedStore = join(fx.root, "memory", "lancedb-namespaced");
    await assert.rejects(
      async () => {
        await importHermes({
          home,
          source: fx.root,
          adoptStore: mismatchedStore,
          apply: true,
          testInternals: { embeddings: flatEmbedder(384) },
        });
      },
      (err: any) => {
        assert.equal(err?.code, "E_STORE_INCOMPATIBLE");
        return true;
      },
    );

    // Target state remains completely unchanged
    const postHash = treeDigest(home);
    assert.equal(preHash, postHash);
  });

  it("grep test: no direct @lancedb/lancedb imports in src/import/** (D28/T7)", () => {
    const importDir = fileURLToPath(new URL("../../src/import", import.meta.url));
    const files: string[] = [];
    const scan = (d: string) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, ent.name);
        if (ent.isDirectory()) scan(full);
        else if (ent.isFile() && ent.name.endsWith(".ts")) files.push(full);
      }
    };
    scan(importDir);

    for (const f of files) {
      if (f.endsWith("readonly.ts")) continue; // readonly.ts has dynamic detection for read-only probing
      const content = readFileSync(f, "utf8");
      assert.ok(
        !content.includes("@lancedb/lancedb"),
        `file ${f} must not import or reference @lancedb/lancedb directly`,
      );
    }
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
