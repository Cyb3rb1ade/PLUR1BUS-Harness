import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { FakeClock, InMemoryProfileSource } from "../../src/discovery/testing.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import type { Scanner } from "../../src/discovery/scanners/index.ts";
import { startFakeSupervisor } from "../../../module-api/test/helpers/fake-supervisor.ts";

describe("core discovery wiring", () => {
  function newHome(): string {
    const home = tempDir("p1b-core-disc-");
    const cfg = defaults();
    cfg.agents.bernd = {};
    cfg.engine = {
      neo: { enabled: false },
      gc: { enabled: false },
      obsidianBridge: { enabled: false },
      merging: { enabled: false },
      dreaming: { enabled: false },
      skillMiner: { enabled: false },
      temporalContext: { enabled: false },
      conversationReactivationRecall: { enabled: false },
      reranker: { enabled: false },
      runtime: { recallTimeoutMs: 10_000 },
    };
    cfg.engine.duplicateThreshold = 1.01;
    cfg.models = {
      scan: { enabled: true, intervalHours: 24 },
    };
    writeFileSync(layout(home).configPath, JSON.stringify(cfg));
    return home;
  }

  it("no request reaches the fake endpoint during core.start(); after clock.advance(60_000) exactly one", async () => {
    const home = newHome();
    const clock = new FakeClock(1_700_000_000_000);
    let scanCount = 0;

    const mockScanner: Scanner = async () => {
      scanCount++;
      return { entries: [{ id: "m1", name: "Model 1", kind: "chat" }], duplicates: 0, pages: 1 };
    };

    const core = createCore({
      home,
      testInternals: flatTestInternals(),
      discovery: {
        clock,
        rng: () => 0.5,
        profiles: new InMemoryProfileSource([
          { id: "p1", discovery: "openai-models", baseUrl: "https://p1.example/v1" },
        ]),
        credentials: { resolve: async (_id, origin) => ({ origin, headerName: "Authorization", headerValue: "Bearer token" }) },
        scanners: {
          "openai-models": mockScanner,
          "anthropic-models": mockScanner,
          "google-models": mockScanner,
          "ollama-tags": mockScanner,
          "manual": mockScanner,
        } as any,
      },
    });

    try {
      await core.start();
      assert.equal(scanCount, 0, "no scan during start()");

      await clock.advance(60_000);
      assert.equal(scanCount, 1, "exactly one scan after catch-up window");
    } finally {
      await core.stop({ budgetMs: 1000 });
    }
  });

  it("scheduler: false arms nothing", async () => {
    const home = newHome();
    const clock = new FakeClock(1_700_000_000_000);
    let scanCount = 0;

    const mockScanner: Scanner = async () => {
      scanCount++;
      return { entries: [{ id: "m1", name: "Model 1", kind: "chat" }], duplicates: 0, pages: 1 };
    };

    const core = createCore({
      home,
      testInternals: flatTestInternals(),
      discovery: {
        clock,
        rng: () => 0.5,
        scheduler: false,
        profiles: new InMemoryProfileSource([
          { id: "p1", discovery: "openai-models", baseUrl: "https://p1.example/v1" },
        ]),
        credentials: { resolve: async (_id, origin) => ({ origin, headerName: "Authorization", headerValue: "Bearer token" }) },
        scanners: {
          "openai-models": mockScanner,
          "anthropic-models": mockScanner,
          "google-models": mockScanner,
          "ollama-tags": mockScanner,
          "manual": mockScanner,
        } as any,
      },
    });

    try {
      await core.start();
      assert.equal(clock.pending(), 0);
      await clock.advance(100_000);
      assert.equal(scanCount, 0);
    } finally {
      await core.stop({ budgetMs: 1000 });
    }
  });

  it("cs.onChange on models.scan replans", async () => {
    const home = newHome();
    const clock = new FakeClock(1_700_000_000_000);
    let scanCount = 0;

    const mockScanner: Scanner = async () => {
      scanCount++;
      return { entries: [{ id: "m1", name: "Model 1", kind: "chat" }], duplicates: 0, pages: 1 };
    };

    const cfg = defaults();
    cfg.agents.bernd = {};
    cfg.engine = {
      neo: { enabled: false },
      gc: { enabled: false },
      obsidianBridge: { enabled: false },
      merging: { enabled: false },
      dreaming: { enabled: false },
      skillMiner: { enabled: false },
      temporalContext: { enabled: false },
      conversationReactivationRecall: { enabled: false },
      reranker: { enabled: false },
      runtime: { recallTimeoutMs: 10_000 },
    };
    cfg.engine.duplicateThreshold = 1.01;
    cfg.models = {
      scan: { enabled: true, intervalHours: 24 },
    };

    const sup = await startFakeSupervisor({ home, config: cfg as unknown as Record<string, unknown> });

    const core = createCore({
      home,
      testInternals: flatTestInternals(),
      supervisorConfig: { attempts: 1, connectTimeoutMs: 1000 },
      discovery: {
        clock,
        rng: () => 0.5,
        profiles: new InMemoryProfileSource([
          { id: "p1", discovery: "openai-models", baseUrl: "https://p1.example/v1" },
        ]),
        credentials: { resolve: async (_id, origin) => ({ origin, headerName: "Authorization", headerValue: "Bearer token" }) },
        scanners: {
          "openai-models": mockScanner,
          "anthropic-models": mockScanner,
          "google-models": mockScanner,
          "ollama-tags": mockScanner,
          "manual": mockScanner,
        } as any,
      },
    });

    try {
      await core.start();
      assert.equal(scanCount, 0);

      // First catch-up scan
      await clock.advance(60_000);
      assert.equal(scanCount, 1);

      // Push config disabling models.scan
      const next = structuredClone(sup.config) as any;
      next.models.scan.enabled = false;
      sup.push(next);

      // Wait until core sees revision
      const until = async (pred: () => boolean, timeout = 2000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (pred()) return;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error("timeout");
      };
      await until(() => core.status().config?.revision === sup.revision);

      assert.equal(clock.pending(), 0, "disabling models.scan cancelled pending timers");
    } finally {
      await core.stop({ budgetMs: 1000 });
      await sup.close();
    }
  });
});
