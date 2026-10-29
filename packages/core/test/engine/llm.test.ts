import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngineCompletion } from "../../src/engine/llm.ts";
import { createTurnProvider, type TurnProviderOptions } from "../../src/composition/provider.ts";
import { createCallBudget, type CallRequest } from "../../src/budget/calls.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import { ProviderError, type StreamingAdapter } from "../../../providers/src/index.ts";
import { readTool, scriptedAdapter, useTempDirs } from "../composition/helpers.ts";

const tmp = useTempDirs("p1b-engine-llm-");
function fixture(extra: Partial<TurnProviderOptions> = {}, adapter?: StreamingAdapter) {
  const scripted = scriptedAdapter([{ text: "completed", usage: { inputTokens: 7, outputTokens: 3 } }]);
  const budget = createCallBudget({ path: join(tmp.make(), "budget.sqlite"), clock: { now: Date.now } });
  tmp.onCleanup(() => budget.close());
  const admissions: CallRequest[] = [];
  const before = budget.checkBeforeCall.bind(budget);
  budget.checkBeforeCall = request => { admissions.push({ ...request }); return before(request); };
  const records: unknown[] = [];
  const options: TurnProviderOptions = {
    registry: new ToolRegistry(), budget,
    profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: adapter ?? scripted.adapter }] },
    approval: { request: async () => ({ approved: false }) }, grants: { get: () => undefined, list: () => [] },
    log: record => records.push(record), resultStore: { put: async () => { throw Error("no engine tool result may be stored"); } },
    router: { retry: { maxRetries: 0 } }, ...extra,
  };
  return { options, budget, admissions, records, scripted, complete: createEngineCompletion(createTurnProvider, options) };
}
const params = () => ({ messages: [{ role: "user" as const, content: "private prompt" }] });
const error = (code: string, reason: string) => (e: unknown) => e instanceof RpcError && e.error === code && e.reason === reason;

test("engine completion uses the composed budget, internal identity, usage and sampling settings", async () => {
  let seen: import("../../src/session/provider.ts").ChatRequest | undefined;
  const f = fixture();
  const create: typeof createTurnProvider = options => {
    const provider = createTurnProvider(options);
    return { ...provider, stream(request) { seen = request; return provider.stream(request); } };
  };
  const complete = createEngineCompletion(create, { ...f.options, principal: () => { throw Error("person attribution must not be used"); } });
  assert.deepEqual(await complete("bernd", { ...params(), maxTokens: 29, temperature: 0.25 }), {
    text: "completed", model: "fixture/gpt-4.1", usage: { inputTokens: 7, outputTokens: 3 },
  });
  assert.equal(f.admissions[0]!.principal, "engine:v1:bernd");
  assert.equal(f.admissions[0]!.agent, "bernd");
  assert.equal(f.admissions[0]!.maxOutputTokens, 29);
  assert.equal(seen!.role, "engine");
  assert.equal(seen!.caller, undefined);
  assert.equal(seen!.authenticatedPerson, undefined);
  assert.deepEqual(seen!.approver, { person: null, surface: 0 });
  assert.deepEqual(seen!.toolView, []);
  assert.deepEqual(seen!.tools, []);
  assert.equal(f.scripted.requests[0]!.temperature, 0.25);
  assert.equal(f.scripted.requests[0]!.maxTokens, 29);
  assert.deepEqual(f.scripted.requests[0]!.tools, []);
  const previous = [seen!.sessionId, seen!.turnId];
  await complete("bernd", params());
  assert.notEqual(seen!.sessionId, previous[0]);
  assert.notEqual(seen!.turnId, previous[1]);
  assert.notEqual(seen!.sessionId, seen!.turnId);
});

test("engine completion hard budget exhaustion refuses before invoking an adapter", async () => {
  const f = fixture();
  f.budget.setLimit({ scope: "agent", id: "bernd", period: "day", metric: "tokens", hard: 0 });
  await assert.rejects(() => f.complete("bernd", params()), error("E_NOT_AVAILABLE", "budget-exceeded"));
  assert.equal(f.scripted.requests.length, 0);
});

test("engine completion preserves per-agent local-only refusal before adapter access", async () => {
  const checked: string[] = [];
  const f = fixture({ localOnly: agentId => { checked.push(agentId); return true; }, isLocalProvider: () => false });
  await assert.rejects(() => f.complete("bernd", params()), error("E_DENIED", "local-only"));
  assert.ok(checked.length > 0);
  assert.ok(checked.every(agent => agent === "bernd"));
  assert.equal(f.scripted.requests.length, 0);
  assert.equal(f.admissions.length, 0);
});

test("engine completion selects only a configured profile or exact provider/model", async () => {
  const cheap = scriptedAdapter([{ text: "cheap" }]);
  const costly = scriptedAdapter([{ text: "costly" }]);
  const f = fixture({ profiles: {
    cheap: [{ provider: "fixture", model: "gpt-4.1-mini", adapter: cheap.adapter }],
    costly: [{ provider: "fixture", model: "gpt-4.1", adapter: costly.adapter }],
  }, profileForAgent: agent => agent === "bernd" ? "cheap" : "costly" });
  assert.equal((await f.complete("bernd", params())).text, "cheap");
  assert.equal((await f.complete("bernd", { ...params(), model: "costly" })).text, "costly");
  assert.equal((await f.complete("bernd", { ...params(), model: "fixture/gpt-4.1-mini" })).text, "cheap");
  await assert.rejects(() => f.complete("bernd", { ...params(), model: "https://unconfigured.invalid/model" }), error("E_NOT_AVAILABLE", "model-not-configured"));
  assert.equal(cheap.requests.length, 2);
  assert.equal(costly.requests.length, 1);
});

test("engine completion never offers or executes tools, even if the model returns a malicious call", async () => {
  const registry = new ToolRegistry();
  let executions = 0, toolRefreshes = 0, prompts = 0, classifications = 0;
  registry.register(readTool("fs.read", async () => { executions++; return "sensitive"; }));
  const scripted = scriptedAdapter([{ calls: [{ id: "bad", name: "fs.read", args: { path: "private" } }] }]);
  const f = fixture({ registry, toolsForTurn: async () => { toolRefreshes++; return registry; }, onPrompt: () => { prompts++; }, classifyMessage: async () => { classifications++; throw Error("must not classify"); } }, scripted.adapter);
  await assert.rejects(() => f.complete("bernd", params()), error("E_DENIED", "engine-tools-forbidden"));
  assert.equal(executions, 0);
  assert.equal(toolRefreshes, 0);
  assert.equal(prompts, 0);
  assert.equal(classifications, 0);
  assert.deepEqual(scripted.requests[0]!.tools, []);
});

test("engine completion preserves pre-abort and active cancellation without another request", async () => {
  const f = fixture();
  const aborted = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  aborted.abort(reason);
  await assert.rejects(() => f.complete("bernd", { ...params(), signal: aborted.signal }), e => e === reason);
  assert.equal(f.scripted.requests.length, 0);
  const active = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const adapter: StreamingAdapter = { async *stream(_request, options) {
    entered();
    await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
  } };
  const running = fixture({}, adapter).complete("bernd", { ...params(), signal: active.signal });
  await started;
  active.abort(reason);
  await assert.rejects(() => running, e => e === reason);
});

test("engine completion denies invalid attribution before provider construction", async () => {
  const f = fixture();
  for (const agent of ["", "../bernd", "owner:bernd", "a".repeat(65)])
    await assert.rejects(() => f.complete(agent, params()), error("E_DENIED", "engine-agent-invalid"));
  assert.equal(f.scripted.requests.length, 0);
  assert.equal(f.admissions.length, 0);
});

test("engine provider failures expose neither prompt nor credentials in errors or metadata", async () => {
  const privateText = "private prompt SECRET_CREDENTIAL_12345";
  const adapter: StreamingAdapter = { async *stream() {
    throw new ProviderError("invalid_request", privateText, { code: privateText, providerMessage: privateText });
  } };
  const metadata: unknown[] = [];
  const f = fixture({ secrets: () => ["SECRET_CREDENTIAL_12345"], onRouterEvent: (event, turn) => metadata.push({ event, turn }), onUsage: record => metadata.push(record), audit: { record: (action, fields) => { metadata.push({ action, fields }); } } }, adapter);
  await assert.rejects(() => f.complete("bernd", { messages: [{ role: "user", content: privateText }] }), e => {
    assert.ok(e instanceof RpcError);
    assert.equal(e.reason, "engine-completion-failed");
    assert.equal(JSON.stringify(e).includes(privateText), false);
    assert.equal(e.message.includes("SECRET_CREDENTIAL"), false);
    return true;
  });
  assert.equal(JSON.stringify([...f.records, ...metadata]).includes("private prompt"), false);
  assert.equal(JSON.stringify([...f.records, ...metadata]).includes("SECRET_CREDENTIAL"), false);
});

test("a provider cannot smuggle an unsafe RPC error through a known completion reason", async () => {
  const f = fixture();
  const create: typeof createTurnProvider = options => ({ ...createTurnProvider(options), async *stream() {
    throw new RpcError("E_NOT_AVAILABLE", "SECRET_CREDENTIAL_12345", { reason: "model-not-configured", detail: "private prompt" });
  } });
  const complete = createEngineCompletion(create, f.options);
  await assert.rejects(() => complete("bernd", params()), e => {
    assert.ok(e instanceof RpcError);
    assert.equal(e.reason, "engine-completion-failed");
    assert.equal(e.detail, undefined);
    assert.equal(e.message.includes("SECRET_CREDENTIAL"), false);
    return true;
  });
});

test("engine completions retain circuit-breaker state across calls independent of sampling", async () => {
  let calls = 0;
  const adapter: StreamingAdapter = { async *stream() { calls++; throw new ProviderError("network", "offline"); } };
  const f = fixture({ router: { retry: { maxRetries: 0 }, breaker: { failureThreshold: 1, openMs: 60_000 } } }, adapter);
  await assert.rejects(() => f.complete("bernd", { ...params(), temperature: 0.1 }), error("E_NOT_AVAILABLE", "engine-completion-failed"));
  await assert.rejects(() => f.complete("bernd", { ...params(), temperature: 0.9 }), error("E_NOT_AVAILABLE", "engine-completion-failed"));
  assert.equal(calls, 1, "the second call must encounter the first call's open breaker");
});
