import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { layout } from "../../../src/paths.ts";
import { buildEngineConfig } from "../../../src/engine-config.ts";
import { createTempHost } from "../../../src/import/importers/hermes-stores.ts";
import { tempDir } from "../../helpers/temp-dir.ts";
import { flatTestInternals } from "../../helpers/flat-embedder.ts";
import { callerToPrincipal } from "../../../src/principal.ts";
import { deriveUserPrincipal } from "../../../src/identity/principals.ts";
import { executePromptImport, rollbackPromptImport } from "../../../src/import/prompt/execute.ts";
import { exportMemoriesAsText } from "../../../src/import/prompt/export.ts";
import { parseMemoryExport } from "../../../src/import/prompt/parse.ts";
import type { EntryTarget, ParsedEntry } from "../../../src/import/prompt/types.ts";

const timeout = 60_000;
const USER_V1 = `user:v1:${"a".repeat(64)}`;
const userAgent = { origin: "user", background: false } as const;

async function withEngine<T>(home: string, fn: (e: ReturnType<typeof createEngine>, l: ReturnType<typeof layout>) => Promise<T>): Promise<T> {
  const l = layout(home);
  mkdirSync(l.workspaceDir("default"), { recursive: true });
  const engine = createEngine(
    createTempHost(l.state, async (id: string) => l.workspaceDir(id)),
    buildEngineConfig(defaults(), l) as any,
    { internals: flatTestInternals() },
  );
  try {
    return await fn(engine, l);
  } finally {
    await engine.close({ budgetMs: 5_000 });
  }
}

describe("Prompt Import & Export against Real Engine (B1, B2)", { timeout }, () => {
  it("imports cards into real engine without invalid-input error and verifies recall (B1)", async () => {
    const home = tempDir("p-real-engine-");
    await withEngine(home, async (engine, l) => {
      const entries: ParsedEntry[] = [
        {
          category: "Preferences",
          sourceType: "memory",
          text: "Prefers terse terminal answers without fluff.",
          warnings: [],
          idempotencyKey: "pref-1",
        },
        {
          category: "Identity",
          sourceType: "memory",
          text: "Fullstack engineer specializing in distributed systems.",
          warnings: [],
          idempotencyKey: "id-1",
        },
        {
          category: "Projects",
          sourceType: "memory",
          text: "Project Nova: telemetry pipeline in Go and Rust.",
          warnings: [],
          idempotencyKey: "proj-1",
        },
        {
          category: "Instructions",
          sourceType: "memory",
          text: "Always format code in standard Markdown fences.",
          warnings: [],
          idempotencyKey: "inst-1",
        },
      ];

      const targets: EntryTarget[] = [
        { target: "user" },
        { target: "user" },
        { target: "agent", agentIds: ["default"] },
        { target: "skip" },
      ];

      const { principal } = callerToPrincipal(
        { channel: "cli", accountId: "default", userId: "u1" },
        "default",
        l.workspaceDir("default"),
      );
      principal.channel = "telegram";
      principal.user = USER_V1 as any;
      principal.trust = "proved";

      // Execute import
      const res = await executePromptImport({
        entries,
        targets,
        principal,
        home,
        engine,
        defaultAgentId: "default",
      });

      // B1 check: 3 imported cards, 0 skipped due to kind rejection, 1 instruction skipped
      assert.equal(res.imported, 3, "expected 3 cards to be accepted and stored by real engine");
      assert.equal(res.skipped, 1, "instruction card skipped");
      assert.equal(res.linked, 0);

      // Query real engine memory
      const listUser = await engine.memory.list({ since: 0, limit: 100 }, principal, userAgent);
      assert.ok(listUser.items.length >= 2, "user scope should have at least 2 cards");
      const userTexts = listUser.items.map((c: any) => c.text);
      assert.ok(userTexts.some((t: string) => t.includes("Prefers terse")));
      assert.ok(userTexts.some((t: string) => t.includes("Fullstack engineer")));

      const { user: _omittedUser, ...principalWithoutUser } = principal;
      const listAgent = await engine.memory.list({ since: 0, limit: 100 }, principalWithoutUser, userAgent);
      assert.ok(listAgent.items.some((c: any) => c.text.includes("Project Nova")));

      // Test duplicate import (M8 link duplicate handling)
      const resDup = await executePromptImport({
        entries,
        targets,
        principal,
        home,
        engine,
        defaultAgentId: "default",
      });
      assert.equal(resDup.imported, 0, "no new cards created on re-import");
      assert.equal(resDup.linked, 3, "3 cards linked to existing cards");

      // Test export against real engine (B2)
      const exportedText = await exportMemoriesAsText({
        principal,
        engine,
        agentId: "default",
      });

      assert.ok(exportedText.startsWith("PLUR1BUS-MEMORY-EXPORT v1\n"));
      assert.ok(exportedText.endsWith("STATUS: COMPLETE\n"));
      assert.ok(exportedText.includes("## Preferences"));
      assert.ok(exportedText.includes("Prefers terse terminal answers without fluff."));
      assert.ok(exportedText.includes("Project Nova"));

      // Roundtrip parsed verification
      const parsed = parseMemoryExport(exportedText);
      assert.equal(parsed.status, "complete");
      assert.ok(parsed.entries.length >= 3);

      // Test rollback against real engine (M7)
      const rb = await rollbackPromptImport({
        runId: res.runId,
        home,
        engine,
        principal,
      });
      assert.ok(rb.rolledBack >= 1, "expected cards unimported");
    });
  });
});
