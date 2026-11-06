import { createRoleBackend } from "../../src/decision/role.ts";
import { assertContextFit } from "../../src/session/context-fit.ts";
import { turnContext } from "../../src/composition/context.ts";
/** AF2 consumer proofs: an oversize role never sends a partial input; existing rule/digest fallbacks apply. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "@plur1bus/config-schema";
import { createAppleFmRuntime } from "../../src/composition/apple-fm.ts";
import { createTurnProvider, type TurnProviderOptions } from "../../src/composition/provider.ts";
import { sessionRoleFactory } from "../../src/session/maintenance.ts";
import { createSessionRoleProvider } from "../../src/session/role-routing.ts";
import { createLlmSummarizer } from "../../src/session/summarizer.ts";
import { SessionStore } from "../../src/session/store.ts";
import { Compactor, defaultCompaction, estimateTokens } from "../../src/session/compaction.ts";
import { ProviderError } from "../../../providers/src/index.ts";
import { DecisionClient } from "../../src/decision/client.ts";
import { scriptedAdapter, turnFixture, turnRequest, collect, useTempDirs } from "../composition/helpers.ts";
const tmp = useTempDirs("af2-fallback-");

function setup() {
  const config = defaults(); config.appleFm.enabled = true;
  const runtime = createAppleFmRuntime({ home: "/synthetic", config: () => config,
    platform: "darwin", slot: () => ({ state: "ready" }) });
  const wire = scriptedAdapter([{ text: "done" }]);
  const fixture = turnFixture(wire.adapter, {}, tmp.make());
  const failures: unknown[] = [];
  const adapter = { async *stream(...args: Parameters<typeof runtime.adapter.stream>) {
    try { yield* runtime.adapter.stream(...args); } catch (error) { failures.push(error); throw error; }
  } };
  const options: TurnProviderOptions = {
    profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: wire.adapter }],
      short: [{ provider: "apple-fm", model: "system", adapter }] },
    contextWindow: provider => provider === "apple-fm" ? 4096 : 32768,
    isLocalProvider: provider => provider === "apple-fm", budget: fixture.budget, registry: fixture.registry,
    grants: { get: () => undefined, list: () => [] }, approval: { async request() { return { approved: false }; } },
    log: () => {}, resultStore: { async put() { throw Error("no tools"); } },
  };
  return { config, runtime, wire, fixture, options, failures };
}

test("oversize decision role reaches rule triage with no managed transport attempt", async () => {
  const f = setup(); f.config.modelRoles.decision = "short";
  let decisions!: DecisionClient;
  const provider = sessionRoleFactory(createTurnProvider, () => f.config, { onClient: value => { decisions = value; } })(f.options);
  try {
    await collect(provider, { ...turnRequest(), messages: [{ role: "user", text: "Read the facts. ".repeat(2000) }] });
    assert.equal(decisions.status().failures, 1);
    assert.equal(f.wire.requests.length, 1, "foreground turn continues after the rule fallback");
    assert.equal(f.runtime.metrics().transport.unix.ok, 0);
    assert.equal(Object.values(f.runtime.metrics().transport.unix.refused).reduce((a, b) => a + b), 0);
  } finally { f.fixture.close(); }
});

test("whole-history summary overflow reaches the Compactor digest without chunk requests", async () => {
  const f = setup(); const store = new SessionStore({ path: ":memory:" });
  const session = store.createSession({ kind: "direct", agentId: "a1", owner: "owner" });
  const provider = createSessionRoleProvider(createTurnProvider, f.options, { summarize: "short" }, 512);
  const summary = createLlmSummarizer(provider, { sessionId: session.id, agentId: "a1", principal: "owner",
    signal: new AbortController().signal }, 32);
  const errors: unknown[] = [];
  const compactor = new Compactor(store, { ...defaultCompaction(8192), summarizer: "llm" }, {
    summarizer: summary, onError: (_stage, error) => { errors.push(error); },
  });
  try {
    for (let index = 0; index < 5; index++) {
      const text = `fact ${index} ` + "übergebene Fakten and context ".repeat(150);
      const { turn } = store.beginTurn(session.id, text, estimateTokens(text));
      store.completeTurn(turn.id, { text, tokens: estimateTokens(text) });
    }
    assert.equal((await compactor.afterTurn(session.id)).prepared, true);
    const view = await compactor.prepare(session.id);
    assert.ok(view.compaction.swapped && view.summaries.length > 0, "digest supplies the summary");
    assert.ok(f.failures.some(error => error instanceof ProviderError && error.code === "context_overflow"),
      JSON.stringify({ native: f.failures.map(error => error instanceof ProviderError ? { kind: error.kind, code: error.code } : String(error)), consumer: errors.map(error => String(error)) }));
    assert.equal(errors.length, 1);
    assert.equal(f.runtime.metrics().transport.unix.ok, 0);
    assert.equal(Object.values(f.runtime.metrics().transport.unix.refused).reduce((a, b) => a + b), 0);
  } finally { store.close(); f.fixture.close(); }
});

test("a summary role constructed while disabled can be enabled live and disabled again", async () => {
  const f = setup(); const short = scriptedAdapter([{ text: "short summary" }]); let enabled = false;
  Object.defineProperty(f.options.profiles, "short", { enumerable: true,
    get: () => enabled ? [{ provider: "apple-fm", model: "system", adapter: short.adapter }] : [],
  });
  const provider = createSessionRoleProvider(createTurnProvider, f.options, { summarize: "short" }, 512);
  const request = { ...turnRequest(), role: "summarize" as const, maxOutputTokens: 128 };
  const drain = async () => { for await (const chunk of provider.stream(request)) void chunk; };
  try {
    await assert.rejects(drain, /summary-model-unavailable/);
    enabled = true; await drain(); assert.equal(short.requests.length, 1);
    enabled = false; await assert.rejects(drain, /summary-model-unavailable/);
    assert.equal(short.requests.length, 1);
  } finally { f.fixture.close(); }
});


test("a small decision reserves 512 output tokens through the real role router", async () => {
  const f = setup(); f.config.modelRoles.decision = "short";
  const answer = scriptedAdapter([{ text: JSON.stringify({ id: "keep", probabilities: { keep: 1, drop: 0 }, confidence: 1 }) }]);
  const options: TurnProviderOptions = { ...f.options, profiles: { ...f.options.profiles, short: [{ provider: "apple-fm", model: "system", adapter: { async *stream(request, options) {
    assert.equal(turnContext.getStore()?.role, "decision");
    assertContextFit(request);
    yield* answer.adapter.stream(request, options);
  } } }] } };
  const backend = createRoleBackend(createTurnProvider, options, () => f.config);
  const client = new DecisionClient({ config: () => f.config, backends: { role: backend } });
  try {
    const result = await client.choice({ useCase: "pruning", state: "a short fact", question: "Keep?",
      options: [{ id: "keep", description: "keep" }, { id: "drop", description: "drop" }] },
    { agentId: "a1", principal: "owner", signal: new AbortController().signal });
    assert.equal(result.ok, true);
    assert.equal(answer.requests.length, 1);
    assert.equal(answer.requests[0]?.maxTokens, 512);
  } finally { f.fixture.close(); }
});
