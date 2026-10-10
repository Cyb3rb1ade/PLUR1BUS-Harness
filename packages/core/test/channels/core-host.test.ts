// createCore hosts the switchboard: channel.* answers from the registry, a misconfigured channel is reported, nothing else is affected.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import { createCore, type Core } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import type { CoreClient } from "@plur1bus/module-api";

describe("core hosts the switchboard", () => {
  const saved = { allow: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, keyring: process.env.PLUR1BUS_SECRETS_KEYRING };
  const home = tempDir("p1b-core-channels-");
  let core: Core; let c: CoreClient;
  before(async () => {
    process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1";
    process.env.PLUR1BUS_SECRETS_KEYRING = "memory"; // never the real keychain
    const cfg = defaults(); cfg.agents.bernd = {};
    cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 } } as never;
    (cfg as any).channels.discord.enabled = true; // its token secret is not stored
    writeFileSync(layout(home).configPath, JSON.stringify(cfg));
    core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => {
    await c?.close(); await core?.stop({ budgetMs: 5000 });
    for (const [k, v] of [["PLUR1BUS_ALLOW_TEST_INTERNALS", saved.allow], ["PLUR1BUS_SECRETS_KEYRING", saved.keyring]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it("channel.list reports a host, and an enabled channel without its secret as misconfigured", async () => {
    const r = await c.call<any>("channel.list");
    assert.equal(r.host, true);
    const by = Object.fromEntries(r.channels.map((x: any) => [x.id, x]));
    assert.equal(by.discord.state, "misconfigured");
    assert.equal(by.discord.enabled, true);
    assert.equal(by.slack.state, "stopped");
  });

  it("channel.status gives the reason, and no secret name is a value", async () => {
    const r = await c.call<any>("channel.status");
    const d = r.channels.find((x: any) => x.id === "discord");
    assert.equal(d.health, "failing");
    assert.match(d.lastError, /secret not found: channels\.discord\.token/);
  });

  it("the core keeps serving", async () => {
    const s = await c.call<any>("core.status");
    assert.equal(s.process.state, "ready");
  });
});
