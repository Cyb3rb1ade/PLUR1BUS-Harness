// Step 6, adapter error table: the SAME simulated provider responses go through EVERY exported adapter factory, and each
// cell states the error kind, whether it is retryable, and that no secret reaches the error. One table, one place to see
// that the five adapters agree.
//
// Where the list of adapters comes from: `src/` has no runtime registry (`ProviderRegistry` in `profiles/` is a
// caller-supplied Map), so the registry is the public surface, `src/index.ts`: every export named `create*Adapter`.
// A cross-check reads the `.ts` files under `src/` and fails when a factory is defined but not exported, or exported but
// defined nowhere, or when a `client.ts` / `adapter.ts` defines none. The per-adapter config (they differ) is the only
// hand-written part, keyed by factory name; a factory without an entry fails the completeness test.
//
// Source of truth for the expectations: the `Error classes` table in docs/providers.md. docs/errors.md has no section
// for chat-provider error kinds (it covers CLI `E_*` codes and the voice package), and docs/provider-matrix.md has no
// HTTP-status rows for these adapters. Several cells are documented by class only ("other 4xx", "any 5xx", "transport
// errors"); each cell's `via` says which row. Nothing here is pinned as "undokumentiert": every cell has a documented row.
//
// Transport: an injected `fetch` returning in-memory `Response`s; no socket, no network. No timer is armed (all three
// bounds are `null`), so nothing sleeps. The adapters never wait on a Retry-After themselves (the router does), so that
// wait is checked through the router's injectable `Clock`. A client-side timeout is NOT simulated: `Run` uses the global
// `setTimeout` with no seam, so the timeout row is HTTP 408 (documented as `timeout`, `timeoutPhase: "headers"`).
//
// Secrets: the credential (and a caller header value) is a marker string. Every provider body and the transport error
// echo the markers into each field the provider controls, so the redaction is exercised, not just absent. The scan covers
// message, name, stack, every own property, the whole `cause` chain, JSON.stringify and util.inspect.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inspect } from "node:util";
import * as pkg from "../src/index.ts";
import {
  createAnthropicAdapter, createChatCompletionsAdapter, createGeminiAdapter, createLocalChatAdapter, createResponsesAdapter,
  ProviderError, ProviderRouter,
} from "../src/index.ts";
import type { CallOptions, ChatRequest, ChatResult, ChatStreamEvent, ProviderErrorKind, RouterEvent, Timeouts } from "../src/index.ts";
import { drain, FakeClock } from "./router/helpers.ts";

const SECRET_ONE = "MARKER_SECRET_ONE"; // the credential
const SECRET_TWO = "MARKER_SECRET_TWO"; // a caller-supplied header value ("account ref"), a secret too (RULING in every adapter)
const RETRY_AFTER_S = 7;

const REQ: ChatRequest = { model: "table-model", messages: [{ role: "user", content: "hi" }] };
const NO_TIMERS: Partial<Timeouts> = { headersMs: null, idleMs: null, totalMs: null };
const EXTRA_HEADERS = { "x-account-ref": SECRET_TWO };

// ---------------------------------------------------------------------------------------------- the adapter list

const FACTORIES: readonly string[] = Object.keys(pkg).filter((k) => /^create\w*Adapter$/.test(k)).sort();

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function srcFiles(): string[] {
  return readdirSync(SRC, { recursive: true }).map(String).filter((p) => p.endsWith(".ts")).sort();
}

/** Every `export function|const create…Adapter` in `src/`, with the file that defines it. */
function definedInSrc(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of srcFiles()) {
    const text = readFileSync(`${SRC}${file}`, "utf8");
    for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(create\w*Adapter)\b/g)) out.set(m[1]!, file);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- the transport

interface Call { url: string; headers: Headers }

function fakeFetch(respond: () => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return respond();
  }) as typeof fetch;
  return { fetch: f, calls };
}

interface Adapter {
  complete(req: ChatRequest, o?: CallOptions): Promise<ChatResult>;
  stream(req: ChatRequest, o?: CallOptions): AsyncGenerator<ChatStreamEvent, void, void>;
}

interface Target {
  /** The wire's name in docs/providers.md and in the report table. */
  readonly label: string;
  /** `test/contract/fixtures/<wire>.cut.sse`: two text deltas, then the stream is cut. */
  readonly fixtureWire: string;
  /** The secrets this adapter holds (a loopback model server has no credential, only the caller header). */
  readonly secrets: readonly string[];
  make(f: typeof fetch): Adapter;
}

const CLOUD = "https://provider.invalid/v1";
const LOOPBACK_URL = "http://127.0.0.1:11434/v1";

/** Keyed by factory name; the keys are checked against the package's exports. */
const TARGETS: Readonly<Record<string, Target>> = {
  createChatCompletionsAdapter: {
    label: "chat_completions", fixtureWire: "openai", secrets: [SECRET_ONE, SECRET_TWO],
    make: (f) => createChatCompletionsAdapter({ baseUrl: CLOUD, credentials: { authorization: () => `Bearer ${SECRET_ONE}` }, headers: EXTRA_HEADERS, timeouts: NO_TIMERS, fetch: f }),
  },
  createGeminiAdapter: {
    label: "gemini", fixtureWire: "gemini", secrets: [SECRET_ONE, SECRET_TWO],
    make: (f) => createGeminiAdapter({ baseUrl: CLOUD, credentials: { apiKey: () => SECRET_ONE }, headers: EXTRA_HEADERS, timeouts: NO_TIMERS, fetch: f }),
  },
  createAnthropicAdapter: {
    label: "anthropic_messages", fixtureWire: "anthropic", secrets: [SECRET_ONE, SECRET_TWO],
    make: (f) => createAnthropicAdapter({ baseUrl: CLOUD, credentials: { apiKey: () => SECRET_ONE }, headers: EXTRA_HEADERS, timeouts: NO_TIMERS, fetch: f }),
  },
  createResponsesAdapter: {
    label: "codex_responses", fixtureWire: "responses", secrets: [SECRET_ONE, SECRET_TWO],
    make: (f) => createResponsesAdapter({ baseUrl: CLOUD, credentials: { authorization: () => `Bearer ${SECRET_ONE}` }, headers: EXTRA_HEADERS, timeouts: NO_TIMERS, fetch: f }),
  },
  createLocalChatAdapter: {
    label: "local (Ollama / LM Studio)", fixtureWire: "ollama", secrets: [SECRET_TWO],
    make: (f) => createLocalChatAdapter({ state: "ok", baseUrl: LOOPBACK_URL }, createChatCompletionsAdapter, { fetch: f, headers: EXTRA_HEADERS, timeouts: NO_TIMERS }),
  },
};

// ---------------------------------------------------------------------------------------------- the simulated responses

const echo = (secrets: readonly string[]): string => secrets.join(" and ");

/** An error body that repeats the credential in every field the provider chooses (message, type, code, gRPC status). */
function errorBody(message: string, secrets: readonly string[]): string {
  return JSON.stringify({ error: { message: `${message} (the provider saw ${echo(secrets)})`, type: `type_${secrets[0]}`, code: `code_${secrets[0]}`, status: `STATUS_${secrets[0]}` } });
}

function httpResponse(status: number, message: string, secrets: readonly string[], headers: Record<string, string> = {}): Response {
  return new Response(errorBody(message, secrets), { status, headers: { "content-type": "application/json", ...headers } });
}

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

/** Two text deltas arrive, then the connection breaks (undici's `TypeError: terminated`, its cause echoing the request headers). */
function cutResponse(first: Uint8Array, secrets: readonly string[]): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (!sent) { sent = true; c.enqueue(first); return; }
      c.error(new TypeError("terminated", { cause: Object.assign(new Error(`other side closed; the request had carried ${echo(secrets)}`), { code: "UND_ERR_SOCKET" }) }));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Expect {
  kind: ProviderErrorKind;
  retryable: boolean;
  status: number | undefined;
  retryAfterMs: number | undefined;
  timeoutPhase: "headers" | "idle" | "total" | undefined;
  /** Checked only when given (a provider's own code is redacted text, not part of the contract). */
  code?: string | undefined;
}

type Path = "complete" | "stream";

interface Cell {
  readonly id: string;
  readonly title: string;
  /** Both paths share the request code; the non-stream path is run too where the response makes sense for it. */
  readonly paths: readonly Path[];
  respond(t: Target): Response;
  readonly expect: Expect;
  /** The row of docs/providers.md `Error classes` that states this mapping. */
  readonly via: string;
}

function http(status: number, message: string, kind: ProviderErrorKind, retryable: boolean, via: string, extra: { headers?: Record<string, string>; retryAfterMs?: number; id?: string; title?: string; timeoutPhase?: "headers" } = {}): Cell {
  return {
    id: extra.id ?? String(status), title: extra.title ?? `HTTP ${status} is "${kind}", ${retryable ? "retryable" : "not retryable"}`,
    paths: ["stream", "complete"],
    respond: (t) => httpResponse(status, message, t.secrets, extra.headers),
    expect: { kind, retryable, status, retryAfterMs: extra.retryAfterMs, timeoutPhase: extra.timeoutPhase },
    via,
  };
}

const PROTOCOL: Omit<Expect, "code"> = { kind: "unknown", retryable: false, status: undefined, retryAfterMs: undefined, timeoutPhase: undefined };

const CELLS: readonly Cell[] = [
  http(401, "the credential was rejected", "auth", false, "auth: 401"),
  http(403, "permission denied", "auth", false, "auth: 403"),
  http(404, "the requested model does not exist", "invalid_request", false, "invalid_request: other 4xx (unknown)", { title: 'HTTP 404 for an unknown model is "invalid_request", not retryable' }),
  http(408, "the server timed out the request", "timeout", true, "timeout: HTTP 408", { timeoutPhase: "headers" }),
  http(413, "the request body is too large", "invalid_request", false, "invalid_request: other 4xx", { title: 'HTTP 413 without a context-length hint is "invalid_request", not retryable' }),
  http(429, "slow down", "rate_limit", true, "rate_limit: 429, honouring Retry-After", {
    id: "429+RA", headers: { "retry-after": String(RETRY_AFTER_S) }, retryAfterMs: RETRY_AFTER_S * 1000,
    title: `HTTP 429 with Retry-After: ${RETRY_AFTER_S} is "rate_limit", retryable, retryAfterMs ${RETRY_AFTER_S * 1000}`,
  }),
  http(429, "slow down", "rate_limit", true, "rate_limit: 429", { id: "429", title: 'HTTP 429 without Retry-After is "rate_limit", retryable, no retryAfterMs' }),
  http(500, "internal failure", "overloaded", true, "overloaded: any 5xx"),
  http(503, "temporarily unavailable", "overloaded", true, "overloaded: any 5xx"),
  {
    id: "truncated JSON", title: "a 200 whose JSON body is cut mid-string is unknown/protocol, not retryable", paths: ["complete", "stream"],
    respond: (t) => jsonResponse(`{"id":"resp_1","choices":[{"index":0,"message":{"role":"assistant","content":"partial ${echo(t.secrets)} and then the body ends here`),
    expect: { ...PROTOCOL, code: "protocol" }, via: "unknown: malformed responses, code protocol",
  },
  {
    id: "invalid JSON", title: "a 200 whose body is not JSON at all is unknown/protocol, not retryable", paths: ["complete", "stream"],
    respond: (t) => jsonResponse(`<html><body>gateway debug page, request headers: ${echo(t.secrets)}</body></html>`),
    expect: { ...PROTOCOL, code: "protocol" }, via: "unknown: malformed responses, code protocol",
  },
  {
    id: "stream cut", title: "the connection breaks after two deltas: network, retryable, the deltas are kept in partial", paths: ["stream"],
    respond: (t) => cutResponse(readFileSync(new URL(`./contract/fixtures/${t.fixtureWire}.cut.sse`, import.meta.url)), t.secrets),
    expect: { kind: "network", retryable: true, status: undefined, retryAfterMs: undefined, timeoutPhase: undefined, code: undefined }, via: "network: transport errors (connection broke)",
  },
];

// ---------------------------------------------------------------------------------------------- the secret scanner

/** Every string reachable from `v`: own properties (also non-enumerable), the cause chain, JSON and `util.inspect`. */
function surfaces(v: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (x: unknown, depth: number): void => {
    if (typeof x === "string") { out.push(x); return; }
    if (typeof x === "number" || typeof x === "boolean" || typeof x === "bigint") { out.push(String(x)); return; }
    if (typeof x !== "object" || x === null || seen.has(x) || depth > 12) return;
    seen.add(x);
    if (x instanceof Error) out.push(x.name, x.message, x.stack ?? "");
    for (const k of Reflect.ownKeys(x)) {
      if (typeof k === "string") out.push(k);
      let val: unknown;
      try { val = (x as Record<PropertyKey, unknown>)[k]; } catch { continue; }
      walk(val, depth + 1);
    }
  };
  walk(v, 0);
  try { out.push(JSON.stringify(v) ?? ""); } catch { /* circular: the walk covered it */ }
  out.push(inspect(v, { depth: 10, showHidden: true }));
  return out;
}

function leaked(v: unknown, secrets: readonly string[]): string[] {
  const all = surfaces(v);
  return secrets.filter((s) => all.some((text) => text.includes(s)));
}

test("scanner self-test: a secret in the message, the cause chain or a property is found, a redacted text is not", () => {
  assert.deepEqual(leaked(new ProviderError("network", `x ${SECRET_ONE}`), [SECRET_ONE]), [SECRET_ONE]);
  assert.deepEqual(leaked(new ProviderError("network", "x", { cause: new Error("outer", { cause: new Error(`deep ${SECRET_TWO}`) }) }), [SECRET_ONE, SECRET_TWO]), [SECRET_TWO]);
  assert.deepEqual(leaked(new ProviderError("auth", "x", { providerMessage: `m ${SECRET_ONE}` }), [SECRET_ONE]), [SECRET_ONE]);
  assert.deepEqual(leaked(new ProviderError("auth", "request rejected (HTTP 401): [redacted]", { code: "[redacted]" }), [SECRET_ONE, SECRET_TWO]), []);
});

// ---------------------------------------------------------------------------------------------- registry completeness

test("registry: the exported adapter factories are exactly the ones defined under src/", () => {
  const defined = definedInSrc();
  const definedNames = [...defined.keys()].sort();
  const notExported = definedNames.filter((n) => !FACTORIES.includes(n)).map((n) => `${n} (${defined.get(n)})`);
  const notDefined = FACTORIES.filter((n) => !defined.has(n));
  assert.deepEqual(notExported, [], `adapter factories defined in src/ but not exported from src/index.ts: ${notExported.join(", ")}`);
  assert.deepEqual(notDefined, [], `adapter factories exported from src/index.ts but defined nowhere under src/: ${notDefined.join(", ")}`);
  assert.ok(FACTORIES.length >= 5, `expected at least five exported adapter factories, saw ${FACTORIES.join(", ")}`);
});

test("registry: every client.ts / adapter.ts under src/ defines an adapter factory", () => {
  const defined = definedInSrc();
  const files = new Set(defined.values());
  const without = srcFiles().filter((f) => /(^|\/)(client|adapter)\.ts$/.test(f) && !files.has(f));
  assert.deepEqual(without, [], `adapter files that define no create*Adapter factory (unregistered?): ${without.join(", ")}`);
});

test("table completeness: every exported adapter factory has a table target, and no target is stale", () => {
  const missing = FACTORIES.filter((n) => TARGETS[n] === undefined);
  assert.deepEqual(missing, [], `exported adapter factories with no target in this table (add one to TARGETS): ${missing.join(", ")}`);
  const stale = Object.keys(TARGETS).filter((n) => !FACTORIES.includes(n));
  assert.deepEqual(stale, [], `table targets whose factory is no longer exported: ${stale.join(", ")}`);
});

// ---------------------------------------------------------------------------------------------- the table

async function outcome(a: Adapter, path: Path): Promise<{ error: unknown; events: ChatStreamEvent[] }> {
  const events: ChatStreamEvent[] = [];
  try {
    if (path === "complete") await a.complete(REQ);
    else for await (const e of a.stream(REQ)) events.push(e);
  } catch (error) {
    return { error, events };
  }
  assert.fail(`${path}() was expected to fail and returned normally`);
}

function assertExpected(err: unknown, e: Expect): ProviderError {
  assert.ok(err instanceof ProviderError, `expected a ProviderError, got ${String(err)}`);
  assert.equal(err.kind, e.kind, "kind");
  assert.equal(err.retryable, e.retryable, "retryable");
  assert.equal(err.status, e.status, "status");
  assert.equal(err.retryAfterMs, e.retryAfterMs, "retryAfterMs");
  assert.equal(err.timeoutPhase, e.timeoutPhase, "timeoutPhase");
  if ("code" in e) assert.equal(err.code, e.code, "code");
  assert.ok(err.message.length > 0, "the error has a message");
  return err;
}

const observed = new Map<string, Map<string, string>>();

for (const name of FACTORIES) {
  const t = TARGETS[name];
  if (t === undefined) continue; // reported by the completeness test above
  for (const cell of CELLS) {
    test(`[${t.label}] ${cell.id}: ${cell.title}`, { timeout: 10_000 }, async () => {
      const { fetch, calls } = fakeFetch(() => cell.respond(t));
      const adapter = t.make(fetch);
      for (const path of cell.paths) {
        const { error, events } = await outcome(adapter, path);
        const err = assertExpected(error, cell.expect);
        if (cell.id === "stream cut") {
          const text = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []));
          assert.ok(text.length > 0, "at least one delta arrived before the cut");
          assert.equal(err.partial?.text, text.join(""), "what had arrived is kept in partial");
          assert.equal(events.some((e) => e.type === "done" || e.type === "finish"), false, "no finish or done after a cut");
        } else {
          assert.deepEqual(events, [], "nothing is emitted before a failed start");
        }
        assert.deepEqual(leaked({ error, events }, t.secrets), [], `${path}(): a secret reached the error or an event`);
      }
      // The scan is only meaningful if the adapter really held the secrets: they went out on this very request.
      assert.equal(calls.length, cell.paths.length, "one request per path");
      for (const call of calls) {
        const sent: string[] = [];
        call.headers.forEach((v) => sent.push(v));
        for (const s of t.secrets) assert.ok(sent.some((v) => v.includes(s)), `the request carried ${s}`);
      }
      let row = observed.get(t.label);
      if (row === undefined) { row = new Map(); observed.set(t.label, row); }
      row.set(cell.id, `${cell.expect.kind} / ${cell.expect.retryable ? "yes" : "no"} / yes`);
    });
  }
}

// ---------------------------------------------------------------------------------------------- Retry-After through the router clock

for (const name of FACTORIES) {
  const t = TARGETS[name];
  if (t === undefined) continue;
  for (const [id, headers, wait] of [
    ["429+RA", { "retry-after": String(RETRY_AFTER_S) }, RETRY_AFTER_S * 1000],
    // No Retry-After: the plain jittered backoff, floor(0.5 * 250 ms) with the injected random.
    ["429", {}, 125],
  ] as const) {
    test(`[${t.label}] ${id}: the wait before the retry is ${wait} ms, taken through the injected router clock`, { timeout: 10_000 }, async () => {
      const { fetch, calls } = fakeFetch(() => httpResponse(429, "slow down", t.secrets, headers));
      const clock = new FakeClock();
      const events: RouterEvent[] = [];
      const router = new ProviderRouter({
        profiles: { p: [{ provider: "table", model: "table-model", adapter: t.make(fetch) }] },
        clock, random: () => 0.5, retry: { maxRetries: 1, baseMs: 250, maxMs: 8_000, maxRetryAfterMs: 15_000 }, onEvent: (e) => events.push(e),
      });
      const error = await drain(router.stream("p", REQ)).then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof ProviderError, `expected a ProviderError, got ${String(error)}`);
      assert.equal(error.kind, "rate_limit");
      assert.equal(calls.length, 2, "the first attempt and one retry");
      assert.deepEqual(clock.sleeps, [wait], "the only wait went through the injected clock");
      assert.deepEqual(events.flatMap((e) => (e.type === "provider.retry" ? [e.delayMs] : [])), [wait]);
      assert.deepEqual(leaked({ error, events }, t.secrets), [], "a secret reached the router's error or events");
    });
  }
}

test("report: the table, one row per adapter (kind / retryable / documented)", (ctx) => {
  const ids = CELLS.map((c) => c.id);
  ctx.diagnostic(`| adapter | ${ids.join(" | ")} |`);
  for (const [label, row] of observed) ctx.diagnostic(`| ${label} | ${ids.map((id) => row.get(id) ?? "n/a").join(" | ")} |`);
});
