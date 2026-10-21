// A5: the real pinned engine writes its own diary; the public RPC must read that same file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DreamsDiaryResult } from "@plur1bus/rpc-schema";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const narrative = "Im Traum führte eine blaue Brücke vom Planungsraum zum Donnerstag. Die Erinnerungen blieben als Sterne am Himmel stehen.";

test("dreams.diary returns the real engine's DREAMS.md after a capture-generated light dream", { timeout: 60_000 }, async () => {
  const home = tempDir("a5-real-diary-");
  const l = layout(home);
  const cfg = defaults();
  cfg.agents.bernd = {};
  cfg.engine = {
    neo: { enabled: true }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: true }, dreaming: { enabled: false, narrative: { enabled: true, diary: true, diaryFromUserChats: true, storeAsMemory: false } },
    skillMiner: { enabled: false }, temporalContext: { enabled: false },
    conversationReactivationRecall: { enabled: false }, reranker: { enabled: false },
    runtime: { recallTimeoutMs: 10_000 }, duplicateThreshold: 1.01,
  };
  writeFileSync(l.configPath, JSON.stringify(cfg));
  const purposes: string[] = [];
  const core = createCore({ home, testInternals: flatTestInternals(), inspectHost: (host) => {
    host.runtime = { llm: { async complete(params) {
      const purpose = params !== null && typeof params === "object" && "purpose" in params && typeof params.purpose === "string" ? params.purpose : "";
      purposes.push(purpose);
      const text = purpose === "dream-narrative" ? narrative
        : purpose === "conversation-insights" ? '["Weekly planning moves to Thursday mornings."]' : "[]";
      return { text, provider: "fixture", model: "fixture", usage: {} };
    } } };
  } });
  await core.start();
  const client = await connect({ address: core.address, token: core.token });
  try {
    await client.call("memory.capture", {
      caller: { channel: "cli", accountId: "local", userId: "owner" }, agentId: "bernd",
      runId: randomUUID(), sessionKey: "agent:bernd:cli:direct:a5", wait: true, waitMs: 30_000,
      messages: [
        { role: "user", content: "Weekly planning moves to Thursday mornings from now on." },
        { role: "assistant", content: "I will remember the new planning schedule." },
        { role: "user", content: "The release freeze starts two days before planning." },
        { role: "assistant", content: "Understood: freeze before planning." },
      ],
    });
    const diaryPath = join(l.workspaceDir("bernd"), "DREAMS.md");
    const until = Date.now() + 15_000;
    while (!existsSync(diaryPath) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(existsSync(diaryPath), `engine diary missing; LLM purposes: ${purposes.join(",")}`);
    const output = readFileSync(diaryPath, "utf8");
    assert.ok(output.includes(narrative), "the genuine engine output contains the stub's narrative");
    const diary = await client.call<DreamsDiaryResult>("dreams.diary", { agentId: "bernd" });
    assert.equal(diary.exists, true);
    assert.equal(diary.path, diaryPath);
    assert.equal(diary.text, output);
    assert.equal(diary.truncated, false);
  } finally {
    await client.close();
    await core.stop({ budgetMs: 5000 });
  }
});
