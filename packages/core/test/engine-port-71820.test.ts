import { randomUUID } from "node:crypto";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createGroupReasoningFilter, isForeignReasoningMessage } from "@cyb3rb1ade/plur1bus-memory/lib/group-reasoning-filter.js";
import { type CoreClient } from "@plur1bus/module-api";
import { connect } from "./helpers/connect.ts";
import { defaults } from "@plur1bus/config-schema";
import { createCore, type Core } from "../src/core.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };

const STRUCTURED = [
  "- Erik has had a new sensor since Monday",
  "- Morning readings swing a lot",
  "- The clinic visit is on the 14th",
  "- Fiasp was reduced to 8 units",
].join("\n");

function newHome(): string {
  const home = tempDir("p1b-port71820-");
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
    runtime: { recallTimeoutMs: 10_000, deferPostTurnLlm: true },
    duplicateThreshold: 1.01,
    captureChunking: true,
    captureChunkingMode: "beides",
  };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

describe("engine port 7.18.17–7.18.20 (in-process core)", () => {
  const home = newHome();
  let core: Core; let c: CoreClient;
  before(async () => {
    core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  const list = async () => c.call<{ items: { id: string; text: string }[] }>("memory.list", { caller, agentId: "bernd", since: 0 });

  it("recall prefers the original row over its chunks (7.18.17)", async () => {
    const before = new Set((await list()).items.map((x) => x.id));
    const cap = await c.call<{ stored: number }>("memory.capture", {
      caller, agentId: "bernd", runId: randomUUID(), wait: true, waitMs: 10_000,
      messages: [{ role: "user", content: STRUCTURED }, { role: "assistant", content: "Noted." }],
    });
    assert.ok(cap.stored >= 2, JSON.stringify(cap));
    const added = (await list()).items.filter((x) => !before.has(x.id));
    const whole = added.find((x) => x.text === STRUCTURED);
    const parts = added.filter((x) => x.text !== STRUCTURED && STRUCTURED.includes(x.text));
    assert.ok(whole, `expected the original row among ${added.map((x) => JSON.stringify(x.text)).join(" | ")}`);
    assert.ok(parts.length >= 2, `expected chunk parts, got ${parts.length}`);

    const r = await c.call<{ joined: { text: string }; degraded: unknown }>("memory.recall", {
      caller, agentId: "bernd", query: "clinic visit on the 14th sensor Fiasp", joined: true,
      budget: { softMs: 5000, hardMs: 10_000 },
    });
    assert.equal(r.degraded, null, JSON.stringify(r.degraded));
    assert.match(r.joined.text, /new sensor since Monday/);
    assert.match(r.joined.text, /clinic visit is on the 14th/);
    assert.match(r.joined.text, /Fiasp was reduced to 8 units/);
  });

  it("host notices are not captured (7.18.19)", async () => {
    const notice = "[System] Your previous turn was interrupted by a gateway restart while waiting on tool/model work. Continue from the existing transcript.";
    const before = new Set((await list()).items.map((x) => x.id));
    const cap = await c.call<{ stored: number; skipped: number; reason?: string }>("memory.capture", {
      caller, agentId: "bernd", runId: randomUUID(), wait: true, waitMs: 10_000,
      messages: [{ role: "user", content: notice }],
    });
    assert.equal(cap.stored, 0, JSON.stringify(cap));
    const after = (await list()).items.filter((x) => !before.has(x.id));
    assert.equal(after.filter((x) => x.text.includes("previous turn was interrupted")).length, 0);

    const queued = "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.] Reply with OK";
    const cap2 = await c.call<{ stored: number }>("memory.capture", {
      caller, agentId: "bernd", runId: randomUUID(), wait: true, waitMs: 10_000,
      messages: [{ role: "user", content: queued }],
    });
    assert.equal(cap2.stored, 0, JSON.stringify(cap2));

    const ok = await c.call<{ stored: number }>("memory.capture", {
      caller, agentId: "bernd", runId: randomUUID(), wait: true, waitMs: 10_000,
      messages: [{ role: "user", content: "Please remember that the greenhouse window stays open at night." }, { role: "assistant", content: "Noted." }],
    });
    assert.ok(ok.stored >= 1, JSON.stringify(ok));
  });

  it("group reasoning blocks from other bots are classified so a host can ignore them (7.18.20)", () => {
    assert.equal(isForeignReasoningMessage("🧠 The exec result is returning null"), true);
    assert.equal(isForeignReasoningMessage("  💭 hmm"), true);
    assert.equal(isForeignReasoningMessage("<think>plan</think> answer"), true);
    assert.equal(isForeignReasoningMessage("Reasoning: first check the cron"), true);
    assert.equal(isForeignReasoningMessage("PeerBot: 🧠 checking first"), true);
    assert.equal(isForeignReasoningMessage("[PeerBot]: 🧠 checking first"), true);
    assert.equal(isForeignReasoningMessage("Alex, what do you think? 🧠"), false);
    assert.equal(isForeignReasoningMessage("Good idea"), false);

    const filter = createGroupReasoningFilter({ enabled: true });
    const groupKey = "agent:main:telegram:group:-1000000000001:topic:1001";
    const dmKey = "agent:main:telegram:direct:10000001";
    assert.deepEqual(filter({ body: "🧠 checking first", sessionKey: groupKey }, { sessionKey: groupKey, agentId: "bernd" }), { handled: true });
    assert.equal(filter({ body: "🧠 checking first", sessionKey: dmKey }, { sessionKey: dmKey, agentId: "bernd" }), undefined);
    assert.equal(filter({ body: "Good idea", sessionKey: groupKey }, { sessionKey: groupKey, agentId: "bernd" }), undefined);
  });
});
