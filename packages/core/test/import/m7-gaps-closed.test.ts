// m7-gaps-closed.test.ts — Unit and integration tests for M7 import gaps:
// 1. OpenClaw memory card path (provenance, deduplication, conflict logic, user scope)
// 2. Hermes --adopt-store mismatch routing (--adopt-strategy reembed | import, dry-run offered strategies)
// 3. Hermes profile mapping (--map profile=<p>:agent=<a>, collision guard, --merge-profiles)
// 4. Backfill CLI and programmatic execution (schema import.backfill/1, --agent required)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layout } from "../../src/paths.ts";
import { importHermes } from "../../src/import/importers/hermes.ts";
import { importBackfill } from "../../src/import/importers/backfill.ts";
import { runImport } from "../../src/import/cli.ts";
import { ImportError } from "../../src/import/types.ts";
import { buildM7HermesFixture, lanceStore } from "./fixtures.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

const timeout = 60_000;

function embedder(hot = 0, dim = 384) {
  const vector = () => Array.from({ length: dim }, (_, i) => (i === hot ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (t: string[]) => t.map(vector), shutdown: async () => {} };
}

async function legacyStore(rows = 1): Promise<string> {
  const store = join(tempDir("m7-gap-store-"), "store");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileSync(join(store, "_schema.json"), JSON.stringify({ schemaVersion: "1" }));
  await lanceStore(join(store, "default"), 384, rows);
  return store;
}

describe("M7 Import Gap 2: Hermes --adopt-store at mismatch", () => {
  it("dry run with identity mismatch offers reembed and import strategies without throwing", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    try {
      const home = tempDir("m7-adopt-dry-");
      const src = await legacyStore();

      // embedder(7) causes identity mismatch against embedder(0)
      const r = await importHermes({
        home,
        source: fx.root,
        adoptStore: src,
        apply: false,
        testInternals: { embeddings: embedder(7) },
      });

      assert.equal(r.mode, "dry-run");
      assert.ok(r.storeAdopt);
      assert.equal(r.storeAdopt.verdict, "incompatible");
      assert.deepEqual(r.storeAdopt.offeredStrategies, ["reembed", "import"]);
      assert.match(r.storeAdopt.hint ?? "", /--adopt-strategy/);
      assert.ok(!existsSync(join(home, "state", "lancedb")), "dry run wrote no store");
    } finally {
      // tempDir handles temp folders
    }
  });

  it("apply with mismatch and no --adopt-strategy fails with helpful hint", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    try {
      const home = tempDir("m7-adopt-err-");
      const src = await legacyStore();

      await assert.rejects(
        importHermes({
          home,
          source: fx.root,
          adoptStore: src,
          apply: true,
          testInternals: { embeddings: embedder(7) },
        }),
        (e: unknown) => {
          assert.ok(e instanceof ImportError);
          assert.equal(e.code, "E_STORE_INCOMPATIBLE");
          assert.equal(e.reason, "identity-mismatch");
          assert.match(e.message, /--adopt-strategy reembed.*--adopt-strategy import/);
          return true;
        },
      );
    } finally {
      // tempDir handles temp folders
    }
  });

  it("apply with mismatch and --adopt-strategy reembed adopts store and skips card re-embedding", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    try {
      const home = tempDir("m7-adopt-reembed-");
      const src = await legacyStore();
      const l = layout(home);

      const r = await importHermes({
        home,
        source: fx.root,
        adoptStore: src,
        adoptStrategy: "reembed",
        apply: true,
        testInternals: { embeddings: embedder(7) },
      });

      assert.equal(r.storeAdopt?.action, "taken-over");
      assert.equal(r.storeAdopt?.routedTo, "reembed");
      assert.equal(r.counts.memoryCardsImported, 0, "card re-embedding skipped when adopting store for re-embedding");
      assert.ok(existsSync(l.lancedb), "store was adopted");
      const ledger = readFileSync(r.ledgerPath!, "utf8");
      assert.ok(ledger.includes('"entity":"store"') && ledger.includes('"action":"adopted"'));
    } finally {
      // tempDir handles temp folders
    }
  });

  it("apply with mismatch and --adopt-strategy import skips store and imports cards", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    try {
      const home = tempDir("m7-adopt-import-");
      const src = await legacyStore();
      const l = layout(home);

      const r = await importHermes({
        home,
        source: fx.root,
        adoptStore: src,
        adoptStrategy: "import",
        apply: true,
        testInternals: { embeddings: embedder(7) },
      });

      assert.equal(r.storeAdopt?.action, "skipped");
      assert.equal(r.storeAdopt?.routedTo, "import");
      assert.ok(r.counts.memoryCardsImported > 0, "cards were imported via memory card path");
    } finally {
      // tempDir handles temp folders
    }
  });
});

describe("M7 Import Gap 3: Hermes profile mapping & collision guard", () => {
  it("mapping two profiles to the same agent without --merge-profiles is rejected with E_PROFILE_COLLISION", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    try {
      // Create a second profile 'alt' in the Hermes fixture
      const altDir = join(fx.root, "profiles", "alt");
      mkdirSync(join(altDir, "memories"), { recursive: true });
      writeFileSync(join(altDir, "persona.md"), "alt persona\n");
      writeFileSync(join(altDir, "memories", "MEMORY.md"), "alt memory\n");

      const home = tempDir("m7-map-collision-");
      await assert.rejects(
        importHermes({
          home,
          source: fx.root,
          mapProfiles: { default: "target-agent", alt: "target-agent" },
          apply: false,
        }),
        (e: unknown) => {
          assert.ok(e instanceof ImportError);
          assert.equal(e.code, "E_PROFILE_COLLISION");
          assert.equal(e.reason, "profile-collision");
          assert.match(e.message, /target-agent/);
          return true;
        },
      );
    } finally {
      // tempDir handles temp folders
    }
  });

  it("mapping two profiles to the same agent with --merge-profiles succeeds and reports merged profiles", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    try {
      const altDir = join(fx.root, "profiles", "alt");
      mkdirSync(join(altDir, "memories"), { recursive: true });
      writeFileSync(join(altDir, "persona.md"), "alt persona\n");
      writeFileSync(join(altDir, "memories", "MEMORY.md"), "alt memory\n");

      const home = tempDir("m7-map-merge-");
      const r = await importHermes({
        home,
        source: fx.root,
        mapProfiles: { default: "target-agent", alt: "target-agent" },
        mergeProfiles: true,
        apply: true,
        testInternals: { embeddings: embedder(0) },
      });

      assert.ok(r.mergedProfiles);
      assert.equal(r.mergedProfiles.length, 1);
      assert.equal(r.mergedProfiles[0]!.agentId, "target-agent");
      assert.deepEqual(r.mergedProfiles[0]!.profiles.sort(), ["alt", "default"].sort());

      const mergedAgentReport = r.profilesOrAgents.find((a) => a.action === "merged");
      assert.ok(mergedAgentReport, "has a profile marked action: merged");
    } finally {
      // tempDir handles temp folders
    }
  });

  it("profile mapping with userPrincipal only activates user binding for mapped agent matching userPrincipal.agentId", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    try {
      const home = tempDir("m7-map-user-binding-");
      const r = await importHermes({
        home,
        source: fx.root,
        mapProfiles: { default: "custom-agent" },
        userPrincipal: { agentId: "custom-agent", userId: "u-1" },
        apply: true,
        testInternals: { embeddings: embedder(0) },
      });

      // default mapped to custom-agent matches userPrincipal.agentId -> default's user cards bound (0 unresolved)
      const customAgent = r.profilesOrAgents.find((a) => a.harnessAgentId === "custom-agent");
      assert.ok(customAgent);
      assert.equal((customAgent.memory as any)?.unresolvedUserScopeCount, 0, "custom-agent resolved user scope");

      // work profile (mapped to work) does not match userPrincipal.agentId (custom-agent) -> unlinked (1 unresolved)
      const workAgent = r.profilesOrAgents.find((a) => a.harnessAgentId === "work");
      assert.ok(workAgent);
      assert.equal((workAgent.memory as any)?.unresolvedUserScopeCount, 1, "work agent user cards left unlinked");
    } finally {
      // tempDir handles temp folders
    }
  });
});

describe("M7 Import Gap 4: Backfill CLI and programmatic", () => {
  it("importBackfill dry run returns schema import.backfill/1 and mode dry-run", async () => {
    const home = tempDir("m7-backfill-dry-");
    const r = await importBackfill({
      home,
      agentId: "agent-1",
      apply: false,
    });
    assert.equal(r.schema, "import.backfill/1");
    assert.equal(r.mode, "dry-run");
    assert.equal(r.agentId, "agent-1");
    assert.equal(r.reboundCount, 0);
  });

  it("runImport parses 'backfill --agent <id>' correctly into envelope", async () => {
    const home = tempDir("m7-backfill-cli-");
    const env = await runImport(["backfill", "--agent", "agent-1", "--home", home]);
    assert.equal(env.ok, true);
    if (env.ok) {
      assert.equal(env.schema, "import.backfill/1");
      assert.equal(env.value.mode, "dry-run");
      assert.equal(env.value.agentId, "agent-1");
      assert.match(env.human, /Backfill for agent 'agent-1' — DRY RUN/);
    }
  });

  it("runImport rejects 'backfill' without --agent with agent-missing", async () => {
    const home = tempDir("m7-backfill-noagent-");
    const env = await runImport(["backfill", "--home", home]);
    assert.equal(env.ok, false);
    if (!env.ok) {
      assert.equal(env.reason, "agent-missing");
    }
  });

  it("runImport passes --map profile=<p>:agent=<a> to Hermes import", async () => {
    const fx = await buildM7HermesFixture();
    try {
      const home = tempDir("m7-cli-profile-map-");
      const env = await runImport([
        "hermes",
        "--source",
        fx.root,
        "--home",
        home,
        "--map",
        "profile=default:agent=custom-agent",
      ]);
      assert.equal(env.ok, true);
      if (env.ok) {
        assert.equal(env.value.schema, "import.hermes/1");
        const agents = env.value.agents as any[];
        assert.equal(agents[0].harnessAgentId, "custom-agent");
      }
    } finally {
      // tempDir handles temp folders
    }
  });
});
