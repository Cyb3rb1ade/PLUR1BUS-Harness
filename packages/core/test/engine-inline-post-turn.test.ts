import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, type CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import type { HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { createCore, type Core } from "../src/core.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };
const UNSCHEDULED = "post-turn-refine-unscheduled";
const QUEUE_DIR = ".post-turn-queue";

function newHome(): string {
  const home = tempDir("p1b-inline-post-turn-");
  const cfg = defaults();
  cfg.agents.bernd = {};
  cfg.engine = {
    neo: { enabled: true },
    gc: { enabled: false },
    obsidianBridge: { enabled: false },
    merging: { enabled: true },
    dreaming: { enabled: false },
    skillMiner: { enabled: false },
    temporalContext: { enabled: false },
    conversationReactivationRecall: { enabled: false },
    reranker: { enabled: false },
    runtime: { recallTimeoutMs: 10_000, deferPostTurnLlm: true },
    duplicateThreshold: 1.01,
  };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

function queueFiles(lancedb: string, agentId: string): string[] {
  const dir = join(lancedb, QUEUE_DIR, agentId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

describe("harness runs light dreams and episodes inline (no post-turn queue)", () => {
  const home = newHome();
  const l = layout(home);
  const purposes: string[] = [];
  const warnings: string[] = [];
  let seenHost: HostServices | undefined;
  let core: Core; let c: CoreClient;

  before(async () => {
    core = createCore({
      home,
      testInternals: flatTestInternals(),
      inspectHost: (host) => {
        seenHost = host;
        const origWarn = host.logger.warn.bind(host.logger);
        host.logger.warn = (message: string, ...rest: unknown[]) => {
          warnings.push(String(message));
          origWarn(message, ...rest);
        };
        // The harness host does not schedule post-turn-refine. A stub LLM lets
        // the inline light-dream / episode path actually dispatch.
        host.runtime = {
          llm: {
            async complete(params) {
              const purpose = typeof (params as { purpose?: unknown }).purpose === "string"
                ? (params as { purpose: string }).purpose
                : "";
              if (purpose) purposes.push(purpose);
              return { text: "[]", provider: "test", model: "test", usage: {} };
            },
          },
        };
        assert.notEqual(host.capabilities?.postTurnRefineScheduled, true);
      },
    });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  it("a capture with at least 3 turns runs a light dream or episode inline", async () => {
    const cap = await c.call<{ stored: number }>("memory.capture", {
      caller, agentId: "bernd", runId: randomUUID(), wait: true, waitMs: 10_000,
      sessionKey: "agent:bernd:cli:direct:10000001",
      messages: [
        { role: "user", content: "We decided to move the weekly planning meeting to Thursday mornings from now on." },
        { role: "assistant", content: "Noted: weekly planning moves to Thursday mornings." },
        { role: "user", content: "Also remember that the release freeze starts two days before every planning meeting." },
        { role: "assistant", content: "Understood, the release freeze begins two days earlier." },
      ],
    });
    assert.ok(cap.stored >= 1, JSON.stringify(cap));

    for (let i = 0; i < 100 && !purposes.includes("conversation-insights") && !purposes.includes("episode-analysis"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(queueFiles(l.lancedb, "bernd").length, 0, "harness must not enqueue post-turn work");
    assert.match(warnings.join("\n"), new RegExp(UNSCHEDULED));
    assert.ok(
      purposes.includes("conversation-insights") || purposes.includes("episode-analysis"),
      `inline light dream or episode must call the LLM, got: ${purposes.join(",") || "(none)"}`,
    );
    assert.notEqual(seenHost?.capabilities?.postTurnRefineScheduled, true);
  });
});
