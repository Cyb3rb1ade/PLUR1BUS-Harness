import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults, type HarnessConfig, type VoiceV3FeatureName, type VoiceV3FeatureSetting } from "@plur1bus/config-schema";
import { approvalPolicyContext, routerEventSink } from "../../src/composition/index.ts";
import { voiceRuntimeConfig } from "../../src/composition/voice.ts";
import type { TurnRouterEvent } from "../../src/composition/provider.ts";

describe("composition approvalPolicyContext (D109: fail closed)", () => {
  const dispatchCtx = { agentId: "a1", principal: "user-1", sessionId: "s1", turnId: "t1", surface: 2, signal: new AbortController().signal } as never;

  it("throws when the permission stores have not been opened, so the dispatcher refuses the call", () => {
    const ctx = approvalPolicyContext({ current: () => null });
    assert.throws(() => ctx(dispatchCtx, {} as never), /approval service unavailable/);
  });

  it("asks the opened approval service for the context of exactly this dispatch", () => {
    const seen: unknown[] = [];
    const ctx = approvalPolicyContext({ current: () => ({ service: { policyContext: () => (c: unknown) => { seen.push(c); return { toolsDeny: ["fs.read"] }; } } }) as never });
    assert.deepEqual(ctx(dispatchCtx, {} as never), { toolsDeny: ["fs.read"] });
    assert.deepEqual(seen, [dispatchCtx]);
  });

  it("looks the runtime up at call time: stores opened later are picked up, stores closed later are refused", () => {
    let current: unknown = null;
    const ctx = approvalPolicyContext({ current: () => current as never });
    assert.throws(() => ctx(dispatchCtx, {} as never), /unavailable/);
    current = { service: { policyContext: () => () => ({}) } };
    assert.deepEqual(ctx(dispatchCtx, {} as never), {});
    current = null;
    assert.throws(() => ctx(dispatchCtx, {} as never), /unavailable/);
  });
});

describe("composition routerEventSink", () => {
  const turn = { sessionId: "s1", turnId: "t1", agentId: "a1" };
  const served = (provider: string, model: string) => ({ provider, model });
  function sink(over: { audit?: (e: unknown) => void } = {}) {
    const logs: [string, string, Record<string, unknown>][] = []; const audits: Record<string, unknown>[] = [];
    const logger = { info: (m: string, f: Record<string, unknown>) => logs.push(["info", m, f]), warn: (m: string, f: Record<string, unknown>) => logs.push(["warn", m, f]) } as never;
    const audit = { append: (e: Record<string, unknown>) => { if (over.audit) over.audit(e); audits.push(e); } } as never;
    return { logs, audits, handler: routerEventSink({ logger, audit, clock: () => 4242 }) };
  }

  it("breaker and retry events are info; fallback, skipped and cross-billing refusals are warnings", () => {
    const { logs, handler } = sink();
    const events: TurnRouterEvent[] = [
      { type: "provider.breaker", target: served("p", "m") as never, from: "closed", to: "open" } as never,
      { type: "provider.retry", profile: "default", target: served("p", "m") as never, attempt: 2, delayMs: 10, reason: "rate_limit" },
      { type: "provider.fallback", profile: "default", from: served("p", "m") as never, to: served("q", "n") as never, reason: "rate_limit" },
      { type: "provider.skipped", profile: "default", target: served("p", "m") as never, reason: "breaker_open" },
      { type: "provider.cross_billing_refused", profile: "default", from: { ...served("p", "m"), billing: "plan" } as never, to: { ...served("q", "n"), billing: "paid" } as never },
    ];
    for (const e of events) handler(e, turn);
    assert.deepEqual(logs.map((l) => [l[0], l[1]]), [["info", "provider.breaker"], ["info", "provider.retry"], ["warn", "provider.fallback"], ["warn", "provider.skipped"], ["warn", "provider.cross_billing_refused"]]);
  });

  it("log fields are the event detail plus the turn, without the type", () => {
    const { logs, handler } = sink();
    handler({ type: "provider.retry", profile: "default", target: served("p", "m") as never, attempt: 2, delayMs: 10, reason: "rate_limit" }, turn);
    assert.deepEqual(logs[0]![2], { profile: "default", target: { provider: "p", model: "m" }, attempt: 2, delayMs: 10, reason: "rate_limit", sessionId: "s1", turnId: "t1", agentId: "a1" });
    assert.equal("type" in logs[0]![2], false);
  });

  it("audits every event as core with the injected clock; the target is the provider and model that is acted on", () => {
    const { audits, handler } = sink();
    handler({ type: "provider.retry", profile: "default", target: served("p", "m") as never, attempt: 2, delayMs: 10, reason: "rate_limit" }, turn);
    handler({ type: "provider.fallback", profile: "default", from: served("p", "m") as never, to: served("q", "n") as never, reason: "rate_limit" }, turn);
    handler({ type: "provider.cross_billing_refused", profile: "default", from: { ...served("p", "m"), billing: "plan" } as never, to: { ...served("q", "n"), billing: "paid" } as never }, turn);
    assert.deepEqual(audits.map((a) => [a.action, a.target]), [["provider.retry", "p/m"], ["provider.fallback", "q/n"], ["provider.cross_billing_refused", "q/n"]]);
    for (const a of audits) { assert.equal(a.at, 4242); assert.deepEqual(a.actor, { user: "core", host: "core" }); }
    assert.equal((audits[0]!.detail as Record<string, unknown>).turnId, "t1");
  });

  it("an audit failure is logged as a warning and never reaches the router", () => {
    const { logs, handler } = sink({ audit: () => { throw new Error("audit chain closed"); } });
    assert.doesNotThrow(() => handler({ type: "provider.skipped", profile: "default", target: served("p", "m") as never, reason: "breaker_open" }, turn));
    const failure = logs.find((l) => l[1] === "router event audit failed");
    assert.ok(failure);
    assert.equal(failure[0], "warn"); assert.equal(failure[2].type, "provider.skipped");
  });
});

describe("composition voiceRuntimeConfig", () => {
  const config = (mutate: (c: HarnessConfig) => void = () => {}) => { const c = defaults(); c.agents.main = {}; mutate(c); return c; };
  const feature = (mode: VoiceV3FeatureSetting["mode"], maxMs?: number): VoiceV3FeatureSetting => ({ mode, ...(maxMs === undefined ? {} : { maxMs }) });
  const PIPELINE: VoiceV3FeatureName[] = ["autoRecall", "promptEnrichment", "reranker", "decisionService", "postTurnRefine", "memoryWrite", "compaction"];

  it("takes the realtime switches from v3, not from the older localRealtime block", () => {
    const c = config((x) => { x.voice.localRealtime.endpointingMs = 111; x.voice.v3.realtime.endpointingMs = 777; x.voice.v3.realtime.enabled = true; x.voice.v3.realtime.speculative = true; x.voice.v3.realtime.ackSound = true; });
    const r = voiceRuntimeConfig(c).localRealtime;
    assert.deepEqual([r.enabled, r.endpointingMs, r.speculativeTurnStart, r.ackSound], [true, 777, true, true]);
  });

  const modeTable: [string, VoiceV3FeatureSetting, string][] = [
    ["on with a budget stays on", feature("on", 300), "on"],
    ["deferred with a budget stays deferred", feature("deferred", 300), "deferred"],
    ["reduced runs as on", feature("reduced", 50), "on"],
    ["off stays off", feature("off", 50), "off"],
    ["a zero budget switches any mode off", feature("on", 0), "off"],
    ["a zero budget switches deferred off", feature("deferred", 0), "off"],
    ["a feature without a budget keeps its mode", feature("on"), "on"],
  ];
  for (const [name, setting, mode] of modeTable) it(`pipeline feature mapping: ${name}`, () => {
    const c = config((x) => { x.voice.v3.realtime.features.autoRecall = setting; });
    assert.equal(voiceRuntimeConfig(c).localRealtime.features.autoRecall.mode, mode);
  });

  it("maps every pipeline feature, keeps its budget, and leaves toolSchemas out of the pipeline features", () => {
    const c = config((x) => { for (const [i, name] of PIPELINE.entries()) x.voice.v3.realtime.features[name] = feature("on", 100 + i); });
    const features = voiceRuntimeConfig(c).localRealtime.features as Record<string, { mode: string; maxMs?: number }>;
    for (const [i, name] of PIPELINE.entries()) assert.deepEqual(features[name], { mode: "on", maxMs: 100 + i }, name);
    assert.equal("toolSchemas" in features, false);
    assert.deepEqual(features.recallMultiIdentity, { mode: "off" }, "settings the v3 block does not own are kept");
  });

  const toolSchemas: [VoiceV3FeatureSetting["mode"], string][] = [["on", "full"], ["deferred", "full"], ["reduced", "reduced"], ["off", "reduced"]];
  for (const [mode, expected] of toolSchemas) it(`toolSchemas mode ${mode} -> ${expected}`, () => {
    const c = config((x) => { x.voice.v3.realtime.features.toolSchemas = feature(mode, 10); });
    assert.equal(voiceRuntimeConfig(c).localRealtime.toolSchemas, expected);
  });

  it("local language and profile follow the v3 selection for that language", () => {
    const c = config((x) => { x.voice.v3.language = "en"; x.voice.v3.selectedProfiles = { de: "fast", en: "quality" }; });
    const r = voiceRuntimeConfig(c).local;
    assert.deepEqual([r.language, r.profile], ["en", "quality"]);
    const d = config((x) => { x.voice.v3.language = "de"; x.voice.v3.selectedProfiles = { de: "quality", en: "fast" }; });
    assert.deepEqual([voiceRuntimeConfig(d).local.language, voiceRuntimeConfig(d).local.profile], ["de", "quality"]);
  });

  it("an agent with a voice setting gets its own language and profile; others get nothing", () => {
    const c = config((x) => {
      x.agents.talker = { voice: { language: "en", profile: "fast" } } as never;
      x.agents.partial = { voice: { language: "en" } } as never;
      x.agents.inherit = { voice: {} } as never;
      x.voice.v3.language = "de"; x.voice.v3.selectedProfiles = { de: "quality", en: "fast" };
    });
    const per = voiceRuntimeConfig(c).local.perAgent as Record<string, unknown>;
    assert.deepEqual(per.talker, { language: "en", profile: "fast" });
    assert.deepEqual(per.partial, { language: "en", profile: "fast" }, "the profile falls back to the selection for the agent's language");
    assert.deepEqual(per.inherit, { language: "de", profile: "quality" }, "language and profile fall back to the installation selection");
    assert.equal("main" in per, false);
  });

  it("derived per-agent entries win over a stale entry in voice.local.perAgent, and unrelated entries survive", () => {
    const c = config((x) => {
      x.agents.talker = { voice: { language: "en", profile: "fast" } } as never;
      (x.voice.local.perAgent as Record<string, unknown>) = { talker: { language: "de", profile: "quality" }, legacy: { language: "de", profile: "fast" } };
    });
    const per = voiceRuntimeConfig(c).local.perAgent as Record<string, unknown>;
    assert.deepEqual(per.talker, { language: "en", profile: "fast" });
    assert.deepEqual(per.legacy, { language: "de", profile: "fast" });
  });

  it("per-agent realtime overrides merge feature by feature over the installation profile", () => {
    const c = config((x) => {
      x.voice.v3.realtime.endpointingMs = 500;
      x.voice.v3.realtime.features.autoRecall = feature("on", 200);
      x.voice.v3.realtime.features.reranker = feature("on", 200);
      x.agents.talker = { voice: { enabled: true, endpointingMs: 900, features: { autoRecall: feature("off", 0) } } } as never;
    });
    const out = voiceRuntimeConfig(c).localRealtime;
    const mine = (out.perAgent as Record<string, typeof out>).talker!;
    assert.equal(mine.enabled, true); assert.equal(mine.endpointingMs, 900);
    assert.deepEqual(mine.features.autoRecall, { mode: "off", maxMs: 0 });
    assert.deepEqual(mine.features.reranker, { mode: "on", maxMs: 200 }, "untouched features inherit");
    assert.equal(out.endpointingMs, 500, "the installation value is not changed by an agent override");
    assert.equal("main" in out.perAgent, false);
  });

  it("a zero budget in an agent override switches that pipeline feature off", () => {
    const c = config((x) => {
      x.voice.v3.realtime.features.promptEnrichment = feature("on", 100);
      x.agents.talker = { voice: { features: { promptEnrichment: feature("on", 0) } } } as never;
    });
    const mine = (voiceRuntimeConfig(c).localRealtime.perAgent as Record<string, { features: Record<string, { mode: string }> }>).talker!;
    assert.equal(mine.features.promptEnrichment!.mode, "off");
  });

  it("does not modify the configuration it is given", () => {
    const c = config((x) => { x.agents.talker = { voice: { language: "en", features: { autoRecall: feature("reduced", 5) } } } as never; x.voice.v3.realtime.features.toolSchemas = feature("on", 10); });
    const before = structuredClone(c);
    voiceRuntimeConfig(c);
    assert.deepEqual(c, before);
  });
});
