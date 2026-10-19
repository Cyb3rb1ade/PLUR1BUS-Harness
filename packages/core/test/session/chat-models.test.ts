// Per-chat model and reasoning choice in the core: options with "Nur lokal" locks, the stored choice (durable across a
// restart, memory-only for incognito, migration v5), session.model.set's reasoning field, and the turn provider sending
// each candidate's own parameter (nearest level, fallbacks included, never for the summarize role).
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../../src/session/store.ts";
import { MIGRATIONS, migrate } from "../../src/session/migrations.ts";
import { buildSessionMethods } from "../../src/session/methods.ts";
import { chatModelOptions, directiveFor, effectiveReasoning, isLocalEndpoint, type ChatModelSources } from "../../src/session/chat-models.ts";
import { userPrincipalHash } from "../../src/principal.ts";
import type { ReasoningDescriptor } from "../../../providers/src/reasoning.ts";

const caller = { channel: "cli" as const, accountId: "a", userId: "u" };
const owner = userPrincipalHash(caller);
const effort: ReasoningDescriptor = { kind: "effort", levels: ["low", "medium", "high"], default: "medium", vendorParam: "reasoning_effort", source: "table" };
const budget: ReasoningDescriptor = { kind: "budget", levels: ["off", "low", "high"], vendorParam: "thinking.budget_tokens", budget: { min: 1024, max: 32000, default: 8192 }, source: "table" };
const none: ReasoningDescriptor = { kind: "none", levels: [], source: "unknown", note: "reasoning-unknown" };

function sources(over: Partial<ChatModelSources> = {}): ChatModelSources {
  return {
    profiles: () => ({ cloud: [{ provider: "cloudy", model: "big" }], mixed: [{ provider: "home", model: "small" }, { provider: "cloudy", model: "big" }], local: [{ provider: "home", model: "small" }], empty: [] }),
    defaultProfile: () => "cloud",
    reasoning: (_p, m) => (m === "big" ? budget : effort),
    endpoint: (p) => (p === "home" ? "http://127.0.0.1:11434" : "https://api.example.invalid/v1"),
    catalog: (_p, m) => (m === "big" ? { displayName: "Big Model", status: "available" } : undefined),
    config: () => ({}),
    ...over,
  };
}

test("options: sorted, empty profiles dropped, primary model describes the profile, budget levels carry their tokens", () => {
  const o = chatModelOptions(sources(), "bernd");
  assert.deepEqual(o.map((x) => x.name), ["cloud", "local", "mixed"]);
  const cloud = o.find((x) => x.name === "cloud")!;
  assert.deepEqual({ ...cloud, reasoning: undefined }, { name: "cloud", displayName: "Big Model", provider: "cloudy", model: "big", local: false, selectable: true, reasoning: undefined }); // no price field: no money dimension
  assert.deepEqual(cloud.reasoning.budgetTokens, { off: 0, low: 3840, high: 15872 });
  assert.equal(o.find((x) => x.name === "local")!.local, true);
  assert.equal(o.find((x) => x.name === "mixed")!.local, false, "a profile is local only when every candidate (fallbacks too) is");
});

test("Nur lokal: cloud profiles stay listed but locked with the reason; an agent's own switch overrides the installation's; listed endpoints count as local", () => {
  const locked = chatModelOptions(sources({ config: () => ({ privacy: { localOnly: true } }) }), "bernd");
  assert.deepEqual(locked.map((x) => [x.name, x.selectable, x.disabledReason]), [["cloud", false, "local-only"], ["local", true, undefined], ["mixed", false, "local-only"]]);
  const lifted = chatModelOptions(sources({ config: () => ({ privacy: { localOnly: true }, agents: { bernd: { privacy: { localOnly: false } } } }) }), "bernd");
  assert.ok(lifted.every((x) => x.selectable));
  const perAgent = chatModelOptions(sources({ config: () => ({ agents: { bernd: { privacy: { localOnly: true } } } }) }), "bernd");
  assert.equal(perAgent.find((x) => x.name === "cloud")!.disabledReason, "local-only");
  const listed = chatModelOptions(sources({ config: () => ({ privacy: { localOnly: true, localEndpoints: ["https://api.example.invalid"] } }) }), "bernd");
  assert.ok(listed.every((x) => x.selectable));
  assert.equal(isLocalEndpoint("http://localhost:1234/v1", {}), true);
  assert.equal(isLocalEndpoint("http://[::1]:8080", {}), true);
  assert.equal(isLocalEndpoint("http://192.168.1.5:11434", {}), false, "a LAN address is never local by itself");
  assert.equal(isLocalEndpoint("http://user:pw@127.0.0.1", {}), false);
  assert.equal(chatModelOptions(sources({ catalog: () => ({ status: "unavailable" }) }), "bernd")[0]!.disabledReason, "unavailable");
});

test("effective level and directive: nearest supported, default sends nothing, a model without control sends nothing (adjusted)", () => {
  assert.deepEqual(effectiveReasoning("xhigh", effort), { level: "high", adjusted: true });
  assert.deepEqual(effectiveReasoning("default", effort), { level: null, adjusted: false });
  assert.deepEqual(effectiveReasoning("medium", none), { level: null, adjusted: true });
  assert.deepEqual(directiveFor("minimal", effort), { vendorParam: "reasoning_effort", value: "low" });
  assert.deepEqual(directiveFor("medium", budget), { vendorParam: "thinking.budget_tokens", value: 3840 });
  assert.equal(directiveFor("default", effort), undefined);
  assert.equal(directiveFor(undefined, effort), undefined);
  assert.equal(directiveFor("high", none), undefined);
});

test("store: v5 adds the reasoning column to an existing v4 file; the choice survives a restart; profile-only updates keep it", () => {
  const root = mkdtempSync(join(tmpdir(), "p1b-reason-")), path = join(root, "sessions.sqlite");
  const raw = new DatabaseSync(path); migrate(raw, MIGRATIONS.slice(0, 4)); raw.close();
  let store = new SessionStore({ path });
  try {
    const s = store.createSession({ kind: "direct", agentId: "bernd", owner });
    assert.equal(store.modelReasoning(s.id), null);
    assert.equal(store.setModelProfile(s.id, "cloud", 0, "high"), 1);
    assert.equal(store.setModelProfile(s.id, "local", 1), 2, "undefined keeps the stored reasoning");
    assert.equal(store.modelReasoning(s.id), "high");
    store.close(); store = new SessionStore({ path });
    assert.deepEqual([store.modelProfile(s.id), store.modelReasoning(s.id)], [{ profile: "local", revision: 2 }, "high"]);
    store.setModelProfile(s.id, "local", 2, null);
    assert.equal(store.modelReasoning(s.id), null, "null clears it (provider default)");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session.model.set: reasoning applies only with the confirmed revision, default clears, the answer names the choice", async () => {
  const store = new SessionStore({ path: ":memory:" });
  try {
    const session = store.createSession({ kind: "direct", agentId: "bernd", owner, memoryMode: "incognito" });
    const methods = buildSessionMethods({ store, runner: {} as never, agents: { workspaceOf: () => "/ws" } as never, isStopping: () => false, modelProfiles: () => ["default", "second"] });
    const call = (extra: object = {}) => methods["session.model.set"]!({ caller, sessionId: session.id, profile: "second", ...extra }, { signal: new AbortController().signal } as never) as Promise<any>;
    const preview = await call({ reasoning: "high" });
    assert.deepEqual([preview.applied, preview.reasoning, store.modelReasoning(session.id)], [false, "high", null]);
    const applied = await call({ reasoning: "high", confirmed: true, expectedRevision: preview.revision });
    assert.deepEqual([applied.applied, applied.reasoning, store.modelReasoning(session.id)], [true, "high", "high"]);
    const kept = await call({ profile: "default", confirmed: true, expectedRevision: 1 });
    assert.equal(kept.reasoning, "high", "a profile switch without reasoning keeps the stored choice");
    await call({ reasoning: "default", confirmed: true, expectedRevision: 2 });
    assert.equal(store.modelReasoning(session.id), null);
  } finally { store.close(); }
});

test("turn provider: each candidate gets its own parameter (fallback mapped to its nearest level); summarize and default send none", async () => {
  const { createTurnProvider } = await import("../../src/composition/provider.ts");
  const { ToolRegistry } = await import("../../src/tools/registry.ts");
  const { ProviderError } = await import("../../../providers/src/index.ts");
  const seen: { model: string; reasoning: unknown }[] = [];
  const done = { type: "done" as const, result: { text: "ok", toolCalls: [], finishReason: "stop" as const, rawFinishReason: "stop", usage: { inputTokens: 3, outputTokens: 1 }, meta: {} } };
  const failing = { async *stream(r: any) { seen.push({ model: r.model, reasoning: r.reasoning }); throw new ProviderError("overloaded", "busy"); yield done; } };
  const ok = { async *stream(r: any) { seen.push({ model: r.model, reasoning: r.reasoning }); yield done; } };
  const budgetGuard = { checkBeforeCall: () => ({ kind: "allow", reservationId: "r", estimatedTokens: 0 }), settle: () => ({ recorded: true, overages: [] }), releaseUnused: () => {} };
  const provider = createTurnProvider({
    registry: new ToolRegistry(), budget: budgetGuard as never, approval: { request: async () => ({ approved: false }) } as never, grants: { list: () => [] } as never,
    profiles: { default: [{ provider: "a", model: "primary", adapter: failing }, { provider: "b", model: "fallback", adapter: ok }] },
    reasoningFor: (_p, m) => (m === "primary" ? { ...effort, levels: ["low", "medium", "high"] } : budget),
    router: { random: () => 0, retry: { maxRetries: 0, baseMs: 0, maxMs: 0 } } as never,
    log: () => {}, resultStore: { put: async () => "x" },
  });
  const run = async (extra: object) => { for await (const _ of provider.stream({ sessionId: "s", agentId: "bernd", principal: "p", summaries: [], memory: "", messages: [{ role: "user", text: "hi" }], signal: new AbortController().signal, ...extra } as never)) { /* drain */ } };
  await run({ reasoning: "medium" });
  assert.deepEqual(seen.slice(0, 2), [{ model: "primary", reasoning: { vendorParam: "reasoning_effort", value: "medium" } }, { model: "fallback", reasoning: { vendorParam: "thinking.budget_tokens", value: 3840 } }]);
  seen.length = 0; await run({ reasoning: "medium", role: "summarize" });
  assert.ok(seen.length > 0 && seen.every((x) => x.reasoning === undefined));
  seen.length = 0; await run({});
  assert.ok(seen.length > 0 && seen.every((x) => x.reasoning === undefined));
});
