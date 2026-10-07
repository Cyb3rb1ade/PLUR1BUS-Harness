// The shared streaming contract: scenarios are defined ONCE here and run for EVERY registered adapter. Each adapter
// brings a "wire encoder": which recorded (synthetic, hand-made) server bytes in ./fixtures render a neutral scenario
// on its wire, plus the few facts that legitimately differ per wire (usage quirks, tool-call delivery, id source).
// The server is a loopback stub on 127.0.0.1; nothing else is reachable. See ./fixtures/README.md.
//
// The real, documented event order (checked against src/accumulate.ts, src/gemini/response.ts, src/client.ts):
//   content events (text_delta | reasoning_delta | tool_call_start | tool_call_delta, in wire order)
//   -> exactly one `finish` -> at most one `usage` (after `finish`) -> exactly one `done`, which is the last event.
// A failure is a THROWN ProviderError, never an event; nothing follows it, and `done` is never emitted after one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as pkg from "../../src/index.ts";
import { createChatCompletionsAdapter, createGeminiAdapter, createLocalChatAdapter, ProviderError } from "../../src/index.ts";
import type { ChatRequest, ChatResult, ChatStreamEvent, ProviderErrorKind, StreamingAdapter, Timeouts, Usage } from "../../src/index.ts";
import { hold, split, sleep, sseHeaders, startStub, until, writeAll } from "../helpers/stub.ts";
import type { Handler, Stub } from "../helpers/stub.ts";

export const GUARD_MS = 15_000;

export type WireName = "openai" | "ollama" | "lmstudio" | "gemini";

export interface WireAdapter {
  /** Unique registry key. */
  readonly name: string;
  readonly wire: WireName;
  /** The public factories this entry exercises (the completeness test compares them with the package's exports). */
  readonly factories: readonly string[];
  /** The request path (+ query) this adapter must hit. */
  readonly urlPattern: RegExp;
  /** Tool-call ids: taken from the wire, or minted by the adapter (Gemini has none). */
  readonly toolIds: "wire" | "synthetic";
  /** How a tool call's arguments reach the consumer: several deltas, or one. */
  readonly toolArguments: "split" | "whole";
  /** The normalised usage this wire's fixtures must produce ("present" scenarios). Absent fields stay absent, never 0. */
  readonly usage: { readonly plain: Usage; readonly reasoning: Usage };
  make(baseUrl: string): StreamingAdapter;
}

const TIMEOUTS: Partial<Timeouts> = { headersMs: 10_000, idleMs: 10_000, totalMs: 20_000 };
const FULL: Usage = { inputTokens: 12, outputTokens: 7, totalTokens: 19 };
const FULL_REASONING: Usage = { ...FULL, reasoningTokens: 5 };

export const ADAPTERS: readonly WireAdapter[] = [
  {
    name: "chat_completions", wire: "openai", factories: ["createChatCompletionsAdapter"],
    urlPattern: /^\/v1\/chat\/completions$/, toolIds: "wire", toolArguments: "split",
    usage: { plain: FULL, reasoning: FULL_REASONING },
    make: (baseUrl) => createChatCompletionsAdapter({ baseUrl, credentials: { authorization: () => "Bearer sk-contract-synthetic-0000000000" }, timeouts: TIMEOUTS }),
  },
  {
    // Ollama-style loopback: native eval counts, `reasoning` key; no credentials ever.
    name: "local/ollama", wire: "ollama", factories: ["createLocalChatAdapter", "createChatCompletionsAdapter"],
    urlPattern: /^\/v1\/chat\/completions$/, toolIds: "wire", toolArguments: "split",
    usage: { plain: FULL, reasoning: FULL },
    make: (baseUrl) => createLocalChatAdapter({ state: "ok", baseUrl }, createChatCompletionsAdapter, { timeouts: TIMEOUTS }),
  },
  {
    // LM Studio-style loopback: partial usage (prompt count only).
    name: "local/lmstudio", wire: "lmstudio", factories: ["createLocalChatAdapter", "createChatCompletionsAdapter"],
    urlPattern: /^\/v1\/chat\/completions$/, toolIds: "wire", toolArguments: "split",
    usage: { plain: { inputTokens: 12 }, reasoning: { inputTokens: 12 } },
    make: (baseUrl) => createLocalChatAdapter({ state: "ok", baseUrl }, createChatCompletionsAdapter, { timeouts: TIMEOUTS }),
  },
  {
    name: "gemini", wire: "gemini", factories: ["createGeminiAdapter"],
    urlPattern: /^\/v1\/models\/contract-model:streamGenerateContent\?alt=sse$/, toolIds: "synthetic", toolArguments: "whole",
    usage: { plain: FULL, reasoning: FULL_REASONING },
    make: (baseUrl) => createGeminiAdapter({ baseUrl, credentials: { apiKey: () => "AIzaSy-contract-synthetic-000000000" }, timeouts: TIMEOUTS }),
  },
];

// ---------------------------------------------------------------------------------------------------- server side

type After = "end" | "hold" | "destroy";

export function fixture(wire: WireName, file: string): Buffer {
  return readFileSync(new URL(`./fixtures/${wire}.${file}`, import.meta.url));
}

/** Replays a recorded SSE body in awkward byte pieces (frames are split mid-line and mid-UTF-8-safe ASCII), then ends, holds or destroys. */
function replay(a: WireAdapter, scenario: string, after: After): Handler {
  return async (_req, res) => {
    sseHeaders(res);
    await writeAll(res, split(fixture(a.wire, `${scenario}.sse`), [53, 7, 211, 3, 97]));
    if (after === "end") res.end();
    else if (after === "destroy") { await sleep(40); res.destroy(); }
    else await hold(res);
  };
}

function httpError(a: WireAdapter, status: number, headers: Record<string, string> = {}): Handler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(fixture(a.wire, `http-${status}.json`));
  };
}

async function withStub<T>(handler: Handler, fn: (stub: Stub) => Promise<T>): Promise<T> {
  const stub = await startStub(handler);
  try { return await fn(stub); } finally { await stub.close(); }
}

function assertServed(a: WireAdapter, stub: Stub): void {
  assert.equal(stub.requests.length, 1, "exactly one request reached the stub");
  const r = stub.requests[0]!;
  assert.equal(r.method, "POST");
  assert.match(r.url ?? "", a.urlPattern);
}

// ---------------------------------------------------------------------------------------------------- client side

export const REQ: ChatRequest = { model: "contract-model", messages: [{ role: "user", content: "hi" }] };
const TOOL_REQ: ChatRequest = {
  ...REQ,
  tools: [
    { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" }, units: { type: "string" } } } },
    { name: "get_time", description: "time", parameters: { type: "object", properties: { tz: { type: "string" } } } },
  ],
};

export async function guarded<T>(label: string, p: Promise<T>, ms = GUARD_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<never>((_ok, no) => { timer = setTimeout(() => no(new Error(`${label}: still pending after ${ms} ms (hang)`)), ms); });
  try { return await Promise.race([p, hung]); } finally { clearTimeout(timer); }
}

export interface Outcome { events: ChatStreamEvent[]; error: unknown }

/** Drains a stream, collecting events and the one error (if any); afterwards the generator must be finished for good. */
export async function drive(gen: AsyncGenerator<ChatStreamEvent, void, void>, onEvent?: (e: ChatStreamEvent, all: ChatStreamEvent[]) => void): Promise<Outcome> {
  const events: ChatStreamEvent[] = [];
  let error: unknown;
  try { for await (const e of gen) { events.push(e); onEvent?.(e, events); } } catch (e) { error = e; }
  const after = await gen.next();
  assert.equal(after.done, true, "no event after the stream ended or failed");
  return { events, error };
}

const CONTENT = new Set<string>(["text_delta", "reasoning_delta", "tool_call_start", "tool_call_delta"]);
type Of<T extends ChatStreamEvent["type"]> = Extract<ChatStreamEvent, { type: T }>;

export interface Shape {
  texts: string[];
  reasoning: string[];
  finish: Of<"finish">;
  usage: Usage | undefined;
  result: ChatResult;
}

/** The order rules every successful stream obeys, on every adapter. */
export function assertCompleteStream(events: ChatStreamEvent[]): Shape {
  const at = (t: ChatStreamEvent["type"]) => events.flatMap((e, i) => (e.type === t ? [i] : []));
  const dones = at("done"), finishes = at("finish"), usages = at("usage");
  assert.equal(dones.length, 1, "exactly one done");
  assert.equal(dones[0], events.length - 1, "done is the last event");
  assert.equal(finishes.length, 1, "exactly one finish");
  assert.ok(usages.length <= 1, `at most one usage, got ${usages.length}`);
  const fi = finishes[0]!;
  events.forEach((e, i) => { if (CONTENT.has(e.type)) assert.ok(i < fi, `${e.type} at ${i} must come before finish at ${fi}`); });
  if (usages.length === 1) assert.ok(usages[0]! > fi && usages[0]! < dones[0]!, "usage comes after finish and before done");
  const started = new Set<number>();
  for (const e of events) {
    if (e.type === "tool_call_start") { assert.ok(!started.has(e.index), `tool call ${e.index} started twice`); started.add(e.index); }
    if (e.type === "tool_call_delta") assert.ok(started.has(e.index), `tool_call_delta for ${e.index} before its tool_call_start`);
  }
  const finish = events[fi] as Of<"finish">;
  const result = (events[dones[0]!] as Of<"done">).result;
  assert.equal(result.finishReason, finish.finishReason, "done.result agrees with the finish event");
  assert.equal(result.rawFinishReason, finish.rawFinishReason);
  const texts = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []));
  const reasoning = events.flatMap((e) => (e.type === "reasoning_delta" ? [e.text] : []));
  assert.equal(result.text, texts.join(""), "result.text is the concatenation of the text deltas");
  assert.equal(result.reasoning, reasoning.length === 0 ? undefined : reasoning.join(""));
  const usage = usages.length === 1 ? (events[usages[0]!] as Of<"usage">).usage : undefined;
  assert.deepEqual(result.usage, usage, "done.result.usage is the usage event (absent when none was sent)");
  return { texts, reasoning, finish, usage, result };
}

/** What every failed stream looks like: an error thrown, no `done`, no `finish` for these fixtures, content events only. */
function assertFailedStream(o: Outcome): ProviderError {
  assert.ok(o.error instanceof ProviderError, `expected a ProviderError, got ${String(o.error)}`);
  assert.equal(o.events.some((e) => e.type === "done"), false, "no done after a failure");
  assert.equal(o.events.some((e) => e.type === "finish" || e.type === "usage"), false, "fixtures fail before finish");
  return o.error;
}

const deltas = (events: ChatStreamEvent[]) => events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []));

// ---------------------------------------------------------------------------------------------------- scenarios

export interface Scenario {
  readonly id: string;
  readonly title: string;
  run(a: WireAdapter): Promise<void>;
}

async function ok(a: WireAdapter, scenario: string, req: ChatRequest = REQ): Promise<{ shape: Shape; events: ChatStreamEvent[] }> {
  return withStub(replay(a, scenario, "end"), async (stub) => {
    const o = await guarded(scenario, drive(a.make(stub.baseUrl).stream(req)));
    assert.equal(o.error, undefined, `no error expected: ${String(o.error)}`);
    assertServed(a, stub);
    return { shape: assertCompleteStream(o.events), events: o.events };
  });
}

function midstream(id: string, kind: ProviderErrorKind, retryable: boolean): Scenario {
  return {
    id, title: `an error object in the stream after two deltas: kind "${kind}", partial text kept (except auth)`,
    async run(a) {
      await withStub(replay(a, id, "end"), async (stub) => {
        const o = await guarded(id, drive(a.make(stub.baseUrl).stream(REQ)));
        const err = assertFailedStream(o);
        assert.deepEqual(deltas(o.events), ["Hel", "lo, "], "the deltas before the error were delivered, in order");
        assert.equal(err.kind, kind);
        assert.equal(err.retryable, retryable);
        // As implemented: every failure except `auth` (and a non-filter `invalid_request`) carries what had arrived.
        if (kind === "auth") assert.equal(err.partial, undefined);
        else assert.equal(err.partial?.text, "Hello, ");
        assertServed(a, stub);
      });
    },
  };
}

function http(status: number, kind: ProviderErrorKind, headers: Record<string, string>, retryAfterMs: number | undefined): Scenario {
  return {
    id: `http-${status}`, title: `non-2xx start (${status}) maps to "${kind}"${retryAfterMs === undefined ? "" : ` with retryAfterMs ${retryAfterMs}`}`,
    async run(a) {
      await withStub(httpError(a, status, headers), async (stub) => {
        const o = await guarded(`http-${status}`, drive(a.make(stub.baseUrl).stream(REQ)));
        assert.deepEqual(o.events, [], "nothing is emitted before a failed start");
        assert.ok(o.error instanceof ProviderError, String(o.error));
        assert.equal(o.error.kind, kind);
        assert.equal(o.error.status, status);
        assert.equal(o.error.retryAfterMs, retryAfterMs);
        assert.equal(o.error.retryable, kind !== "auth");
        assert.equal(o.error.partial, undefined, "a failed start has no partial");
        assertServed(a, stub);
      });
    },
  };
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "text", title: "text deltas arrive in order and concatenate; one finish, one usage, one done",
    async run(a) {
      const { shape, events } = await ok(a, "text");
      assert.deepEqual(shape.texts, ["Hel", "lo, ", "world"]);
      assert.equal(shape.result.text, "Hello, world");
      assert.equal(shape.finish.finishReason, "stop");
      assert.deepEqual(shape.result.toolCalls, []);
      assert.deepEqual(shape.usage, a.usage.plain);
      assert.equal(events.filter((e) => e.type === "usage").length, 1, "a cumulative or trailing usage is reported once");
    },
  },
  {
    id: "tools", title: "a tool call's arguments split over several deltas assemble to the exact JSON; two parallel calls keep index/id",
    async run(a) {
      const { shape, events } = await ok(a, "tools", TOOL_REQ);
      const want = [
        { index: 0, name: "get_weather", id: "call_weather_0", raw: "{\"city\":\"Berlin\",\"units\":\"metric\"}" },
        { index: 1, name: "get_time", id: "call_time_1", raw: "{\"tz\":\"Europe/Berlin\"}" },
      ];
      assert.equal(shape.finish.finishReason, "tool_calls");
      const starts = events.flatMap((e) => (e.type === "tool_call_start" ? [e] : []));
      assert.deepEqual(starts.map((s) => [s.index, s.name]), want.map((w) => [w.index, w.name]));
      assert.equal(shape.result.toolCalls.length, 2);
      const ids = new Set<string>();
      for (const w of want) {
        const parts = events.flatMap((e) => (e.type === "tool_call_delta" && e.index === w.index ? [e.argumentsDelta] : []));
        assert.equal(parts.join(""), w.raw, `deltas of call ${w.index} assemble to the exact JSON text`);
        if (a.toolArguments === "split") assert.ok(parts.length >= 2, `call ${w.index} arrived in ${parts.length} delta(s)`);
        else assert.equal(parts.length, 1, "Gemini delivers a functionCall whole: one delta");
        const call = shape.result.toolCalls[w.index]!;
        assert.equal(call.name, w.name);
        assert.equal(call.argumentsRaw, w.raw);
        assert.deepEqual(call.arguments, JSON.parse(w.raw));
        assert.equal(call.argumentsError, undefined);
        const start = starts.find((s) => s.index === w.index)!;
        assert.equal(start.id, call.id, "the id announced at the start is the id of the result");
        if (a.toolIds === "wire") assert.equal(call.id, w.id);
        else assert.ok(call.id !== "", "a minted id is non-empty");
        ids.add(call.id);
      }
      assert.equal(ids.size, 2, "the two parallel calls have distinct ids");
    },
  },
  {
    id: "empty", title: "an empty response completes with a finish and a result, no crash, no usage invented",
    async run(a) {
      const { shape, events } = await ok(a, "empty");
      assert.deepEqual(events.map((e) => e.type), ["finish", "done"]);
      assert.equal(shape.result.text, "");
      assert.deepEqual(shape.result.toolCalls, []);
      assert.equal(shape.finish.finishReason, "stop");
      assert.equal(shape.result.usage, undefined);
    },
  },
  {
    id: "no-usage", title: "absent usage: no usage event, no usage on the result, never zeros",
    async run(a) {
      const { shape, events } = await ok(a, "no-usage");
      assert.deepEqual(shape.texts, ["o", "k"]);
      assert.equal(events.some((e) => e.type === "usage"), false);
      assert.equal(shape.result.usage, undefined);
      assert.equal(Object.hasOwn(shape.result, "usage"), false, "the key is absent, not undefined");
    },
  },
  {
    id: "reasoning-usage", title: "reasoning deltas precede the answer; usage (with reasoning tokens where the wire has them) is normalised",
    async run(a) {
      const { shape, events } = await ok(a, "reasoning-usage");
      assert.deepEqual(shape.reasoning, ["Think ", "hard."]);
      assert.deepEqual(shape.texts, ["42"]);
      assert.equal(shape.result.reasoning, "Think hard.");
      assert.equal(shape.result.text, "42");
      const firstText = events.findIndex((e) => e.type === "text_delta");
      const lastReasoning = events.map((e) => e.type).lastIndexOf("reasoning_delta");
      assert.ok(lastReasoning < firstText, "reasoning arrives before the answer");
      assert.deepEqual(shape.usage, a.usage.reasoning);
      for (const v of Object.values(shape.usage ?? {})) assert.ok(v !== 0, "a count the wire did not report is absent, not 0");
    },
  },
  {
    id: "abort", title: "abort mid-stream via AbortSignal ends promptly with ProviderError aborted, never hangs",
    async run(a) {
      let serverSawClose = false;
      const inner = replay(a, "stall", "hold");
      const watched: Handler = (req, res, rec) => { req.socket.on("close", () => { serverSawClose = true; }); return inner(req, res, rec); };
      await withStub(watched, async (stub) => {
        const ac = new AbortController();
        let abortedAt = 0;
        const o = await guarded("abort", drive(a.make(stub.baseUrl).stream(REQ, { signal: ac.signal }), (e, all) => {
          if (e.type === "text_delta" && all.filter((x) => x.type === "text_delta").length === 2) { abortedAt = Date.now(); ac.abort(new Error("contract: user pressed stop")); }
        }));
        const took = Date.now() - abortedAt;
        assert.ok(abortedAt > 0, "the abort was triggered by the second delta");
        assert.ok(took < 5_000, `the stream ended ${took} ms after the abort`);
        const err = assertFailedStream(o);
        assert.equal(err.kind, "aborted");
        assert.equal(err.retryable, false);
        assert.deepEqual(deltas(o.events), ["Hel", "lo, "]);
        assert.equal(err.partial?.text, "Hello, ");
        assert.ok(await until(() => serverSawClose, 3_000), "the server saw the connection close");
      });
    },
  },
  midstream("error-overloaded", "overloaded", true),
  midstream("error-rate-limit", "rate_limit", true),
  midstream("error-auth", "auth", false),
  {
    id: "cut", title: "the server destroys the socket mid-stream: the real behaviour is kind \"network\" (retryable), partial kept",
    async run(a) {
      await withStub(replay(a, "cut", "destroy"), async (stub) => {
        const o = await guarded("cut", drive(a.make(stub.baseUrl).stream(REQ)));
        const err = assertFailedStream(o);
        assert.equal(err.kind, "network");
        assert.equal(err.retryable, true);
        assert.equal(err.code, undefined);
        assert.deepEqual(deltas(o.events), ["Hel", "lo, "]);
        assert.equal(err.partial?.text, "Hello, ");
      });
    },
  },
  {
    id: "truncated", title: "a clean close without a finish (no [DONE] / no finishReason) is an unknown/protocol error, not a result",
    async run(a) {
      await withStub(replay(a, "truncated", "end"), async (stub) => {
        const o = await guarded("truncated", drive(a.make(stub.baseUrl).stream(REQ)));
        const err = assertFailedStream(o);
        assert.equal(err.kind, "unknown");
        assert.equal(err.code, "protocol");
        assert.equal(err.retryable, false);
        assert.equal(err.partial?.text, "Hello, ");
      });
    },
  },
  http(401, "auth", {}, undefined),
  http(429, "rate_limit", { "retry-after": "7" }, 7_000),
  http(500, "overloaded", {}, undefined),
];

// ---------------------------------------------------------------------------------------------------- registration

const ran = new Map<string, Set<string>>();

/** Registers one test per (adapter, scenario) plus the completeness test that fails when any adapter skipped any scenario. */
export function registerContract(adapters: readonly WireAdapter[] = ADAPTERS, scenarios: readonly Scenario[] = SCENARIOS): void {
  for (const a of adapters) {
    for (const s of scenarios) {
      test(`[${a.name}] ${s.id}: ${s.title}`, { timeout: 30_000 }, async () => {
        await s.run(a);
        let set = ran.get(a.name);
        if (set === undefined) { set = new Set(); ran.set(a.name, set); }
        set.add(s.id);
      });
    }
  }

  test("contract completeness: every registered adapter ran every scenario, and no exported adapter factory is unregistered", () => {
    assert.equal(adapters, ADAPTERS, "the contract must run the full ADAPTERS registry");
    assert.equal(scenarios, SCENARIOS, "the contract must run the full SCENARIOS list");
    assert.equal(new Set(ADAPTERS.map((a) => a.name)).size, ADAPTERS.length, "adapter names are unique");
    assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length, "scenario ids are unique");
    const missing: string[] = [];
    for (const a of ADAPTERS) {
      const got = ran.get(a.name) ?? new Set<string>();
      for (const s of SCENARIOS) if (!got.has(s.id)) missing.push(`${a.name}/${s.id}`);
    }
    assert.deepEqual(missing, [], `adapter/scenario pairs that did not run (skipped, filtered or failed): ${missing.join(", ")}`);
    const registered = new Set(ADAPTERS.flatMap((a) => a.factories));
    const exported = Object.keys(pkg).filter((k) => /^create\w*Adapter$/.test(k));
    assert.ok(exported.length >= 3, `expected at least three exported adapter factories, saw ${exported.join(", ")}`);
    const unregistered = exported.filter((k) => !registered.has(k));
    assert.deepEqual(unregistered, [], `exported adapter factories with no contract entry (add a WireAdapter to ADAPTERS): ${unregistered.join(", ")}`);
    for (const f of registered) assert.ok(exported.includes(f), `${f} is registered but no longer exported`);
  });
}
