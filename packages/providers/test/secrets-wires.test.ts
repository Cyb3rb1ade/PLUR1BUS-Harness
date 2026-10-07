// H11 secrets hygiene for the anthropic_messages and codex_responses adapters (the older adapters are covered by
// secrets.test.ts, which this file leaves alone). A sentinel credential goes through each adapter; a loopback stub provokes
// every reachable error path (HTTP statuses with the key echoed in message, type and code, JSON and text bodies, in-stream
// error events, malformed and truncated SSE, cut connections, redirects, plain-http refusal, refused connections, timeouts,
// aborts, an unusable key, a transport that echoes its headers, a caller header value echoed back). Every thrown error and
// every router event is scanned recursively (message, providerMessage, code, name, stack, cause chain, every own
// property, JSON.stringify, util.inspect) for the sentinels and for key-shaped strings. The stub also checks that no
// request carries the key anywhere but its own header.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { inspect } from "node:util";
import { createAnthropicAdapter, createResponsesAdapter, ProviderError, ProviderRouter } from "../src/index.ts";
import type { CallOptions, ChatRequest, ChatResult, ChatStreamEvent, RouterEvent, Timeouts } from "../src/index.ts";
import { FakeClock } from "./router/helpers.ts";
import { hold, sleep, sseHeaders, startStub } from "./helpers/stub.ts";
import type { Handler } from "./helpers/stub.ts";

const ANT = "sk-ant-api03-SECRETSENTINEL0123456789abcdef";
const OAI = "sk-proj-SECRETSENTINEL9876543210fedcba";
const HDR = "acct-EXTRAHEADERSENTINEL-0123456789abcdef";

const RULES: readonly [string, RegExp][] = [
  ["sentinel", /SECRETSENTINEL|EXTRAHEADERSENTINEL/],
  ["sk-… key shape", /sk-[A-Za-z0-9_-]{16,}/],
  ["Bearer token", /Bearer\s+(?!\[redacted\])\S{8,}/i],
  ["key= query value", /\bkey=(?!\[redacted\])[^\s&"',}\]]+/i],
];

function surfaces(v: unknown): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<unknown>();
  const walk = (x: unknown, path: string, depth: number): void => {
    if (typeof x === "string") { out.push([path, x]); return; }
    if (typeof x === "number" || typeof x === "boolean" || typeof x === "bigint") { out.push([path, String(x)]); return; }
    if (typeof x !== "object" || x === null || seen.has(x) || depth > 12) return;
    seen.add(x);
    if (x instanceof Error) out.push([`${path}.name`, x.name]);
    for (const k of Reflect.ownKeys(x)) {
      let val: unknown;
      try { val = (x as Record<PropertyKey, unknown>)[k]; } catch { continue; }
      if (typeof k === "string") out.push([`${path}.<key>`, k]);
      walk(val, `${path}.${String(k)}`, depth + 1);
    }
  };
  walk(v, "value", 0);
  try { out.push(["JSON.stringify", JSON.stringify(v) ?? ""]); } catch { /* circular: the walk covered it */ }
  out.push(["util.inspect", inspect(v, { depth: 10, showHidden: true })]);
  return out;
}

function findLeaks(label: string, v: unknown): string[] {
  const hits: string[] = [];
  for (const [path, text] of surfaces(v)) {
    for (const [rule, re] of RULES) {
      const m = re.exec(text);
      if (m !== null) hits.push(`${label} :: ${rule} :: ${path} :: ${JSON.stringify(text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 8))}`);
    }
  }
  return hits.slice(0, 3);
}

test("scanner self-test: every rule fires on a seeded value, and the placeholder is not a finding", () => {
  const e = new ProviderError("network", "x", { cause: new Error(`deep ${ANT} and ${HDR}`) });
  assert.ok(findLeaks("seed", e).some((l) => l.includes("sentinel")));
  for (const s of ["use sk-live-abcdefghijklmnop1", "Authorization: Bearer abcdefgh12345", "https://x.invalid/?a=1&key=abc123"]) assert.ok(findLeaks("seed", new Error(s)).length > 0, s);
  assert.deepEqual(findLeaks("clean", new ProviderError("auth", "request rejected (HTTP 401): Bearer [redacted] ?key=[redacted]")), []);
});

// ------------------------------------------------------------------------------------------------ targets

interface Over { timeouts?: Partial<Timeouts>; headers?: Record<string, string>; fetch?: typeof fetch; credential?: () => string | undefined | Promise<string | undefined> }
interface Adapter {
  complete(req: ChatRequest, o?: CallOptions): Promise<ChatResult>;
  stream(req: ChatRequest, o?: CallOptions): AsyncGenerator<ChatStreamEvent, void, void>;
}
interface Target {
  readonly name: "anthropic_messages" | "codex_responses";
  readonly key: string;
  make(baseUrl: string, over?: Over): Adapter;
  /** An error body echoing `echo` in every field the provider controls. */
  errBody(message: string, type: string, code: string): string;
  /** An SSE body: two text deltas, then the in-stream failure echoing `echo`. */
  failingStream(echo: string): string;
  readonly okStream: string;
}

const TIMEOUTS: Partial<Timeouts> = { headersMs: 5_000, idleMs: 5_000, totalMs: 10_000 };
const sse = (frames: [string, object][]) => frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`).join("");
const aOpen: [string, object][] = [
  ["message_start", { message: { id: "m", model: "x", usage: { input_tokens: 1 } } }],
  ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hel" } }],
];
const rOpen: [string, object][] = [
  ["response.created", { response: { id: "r", model: "x" } }],
  ["response.output_item.added", { output_index: 0, item: { type: "message" } }],
  ["response.output_text.delta", { output_index: 0, delta: "Hel" }],
];

const TARGETS: readonly Target[] = [
  {
    name: "anthropic_messages", key: ANT,
    errBody: (message, type) => JSON.stringify({ type: "error", error: { type, message } }),
    failingStream: (echo) => sse([...aOpen, ["error", { error: { type: "api_error", message: `upstream said ${echo}` } }]]),
    okStream: sse([...aOpen, ["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }], ["message_stop", {}]]),
    make: (baseUrl, over) => createAnthropicAdapter({
      baseUrl, credentials: { apiKey: over?.credential ?? (() => ANT) }, timeouts: over?.timeouts ?? TIMEOUTS,
      ...(over?.headers ? { headers: over.headers } : {}), ...(over?.fetch ? { fetch: over.fetch } : {}),
    }),
  },
  {
    name: "codex_responses", key: OAI,
    errBody: (message, type, code) => JSON.stringify({ error: { message, type, code, param: null } }),
    failingStream: (echo) => sse([...rOpen, ["error", { code: "server_error", message: `upstream said ${echo}` }]]),
    okStream: sse([...rOpen, ["response.output_item.done", { output_index: 0, item: {} }], ["response.completed", { response: { status: "completed" } }]]),
    make: (baseUrl, over) => createResponsesAdapter({
      baseUrl, credentials: { authorization: over?.credential ? async () => { const k = await over.credential!(); return k === undefined ? undefined : `Bearer ${k}`; } : () => `Bearer ${OAI}` }, timeouts: over?.timeouts ?? TIMEOUTS,
      ...(over?.headers ? { headers: over.headers } : {}), ...(over?.fetch ? { fetch: over.fetch } : {}),
    }),
  },
];

const REQ: ChatRequest = { model: "secrets-model", messages: [{ role: "user", content: "hi" }] };
const drain = async (g: AsyncGenerator<ChatStreamEvent, void, void>) => { for await (const _ of g) { /* drained */ } };
const calls: [string, (a: Adapter, o?: CallOptions) => Promise<unknown>][] = [["complete", (a, o) => a.complete(REQ, o)], ["stream", (a, o) => drain(a.stream(REQ, o))]];

/** Runs `fn`, returns what it threw (or undefined). */
const thrown = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

interface Case { label: string; handler: Handler; over?: Over; opts?: () => CallOptions; expect?: (e: unknown) => void }
const body = (res: import("node:http").ServerResponse, status: number, headers: Record<string, string>, text: string) => { res.writeHead(status, headers); res.end(text); };

function cases(t: Target): Case[] {
  const echo = `${t.key} Bearer ${t.key} https://x.invalid/v1?key=${t.key}`;
  const out: Case[] = [];
  for (const status of [400, 401, 403, 404, 408, 413, 429, 500, 502, 503, 529]) {
    out.push({ label: `HTTP ${status}, key echoed in message, type and code`, handler: (_q, res) => body(res, status, { "content-type": "application/json" }, t.errBody(echo, `type_${t.key}`, `code_${t.key}`)) });
  }
  out.push(
    { label: "HTTP 500, plain text echoing the key", handler: (_q, res) => body(res, 500, { "content-type": "text/plain" }, `crash: ${echo}`) },
    { label: "HTTP 400, JSON that is not the documented shape, key in a stray field", handler: (_q, res) => body(res, 400, { "content-type": "application/json" }, JSON.stringify({ detail: echo, nested: { x: echo } })) },
    { label: "HTTP 429 with the key in headers the adapter reads", handler: (_q, res) => body(res, 429, { "content-type": "application/json", "retry-after": `${t.key}`, "x-ratelimit-reset-requests": t.key }, t.errBody("slow", "x", "y")) },
    { label: "302 redirect with the key in Location", handler: (_q, res) => body(res, 302, { location: `https://elsewhere.invalid/v1/x?key=${t.key}` }, "") },
    { label: "200 JSON error object echoing the key", handler: (_q, res) => body(res, 200, { "content-type": "application/json" }, t.errBody(echo, "api_error", "server_error")) },
    { label: "200 JSON that is not JSON, key in the text", handler: (_q, res) => body(res, 200, { "content-type": "application/json" }, `{not json ${echo}`) },
    { label: "200 with a content type that carries the key", handler: (_q, res) => body(res, 200, { "content-type": `text/x-${t.key}` }, "x") },
    { label: "in-stream error event echoing the key", handler: (_q, res) => { sseHeaders(res); res.end(t.failingStream(echo)); } },
    { label: "malformed SSE data echoing the key", handler: (_q, res) => { sseHeaders(res); res.end(`data: {broken ${echo}\n\n`); } },
    { label: "stream truncated after content", handler: (_q, res) => { sseHeaders(res); res.end(t.okStream.slice(0, t.okStream.lastIndexOf("event:"))); } },
    { label: "connection cut after content", handler: async (_q, res) => { sseHeaders(res); res.write(t.okStream.slice(0, 120)); await sleep(30); res.destroy(); } },
    { label: "caller header value echoed back in an error", over: { headers: { "x-account": HDR } }, handler: (_q, res) => body(res, 400, { "content-type": "application/json" }, t.errBody(`bad account ${HDR}`, "invalid_request_error", "x")) },
    { label: "an unusable key (whitespace)", over: { credential: () => `${t.key} with space` }, handler: (_q, res) => body(res, 200, {}, "{}") },
    { label: "a credentials provider that throws", over: { credential: () => { throw new Error("vault locked"); } }, handler: (_q, res) => body(res, 200, {}, "{}") },
    {
      label: "a transport that fails with the request headers in its message", handler: (_q, res) => body(res, 200, {}, "{}"),
      over: { fetch: (async (_u: unknown, init?: RequestInit) => { throw new TypeError(`fetch failed: ${JSON.stringify([...new Headers(init?.headers).entries()])}`, { cause: new Error(`socket: ${t.key}`) }); }) as unknown as typeof fetch },
    },
    { label: "timeout on a server that never answers", over: { timeouts: { headersMs: 80, idleMs: 80, totalMs: 200 } }, handler: (_q, res) => hold(res) },
    { label: "idle timeout mid-stream", over: { timeouts: { headersMs: 1000, idleMs: 80, totalMs: 2000 } }, handler: async (_q, res) => { sseHeaders(res); res.write(t.okStream.slice(0, 120)); await hold(res); } },
    { label: "abort mid-stream", handler: async (_q, res) => { sseHeaders(res); res.write(t.okStream.slice(0, 120)); await hold(res); }, opts: () => ({ signal: AbortSignal.timeout(100) }) },
  );
  return out;
}

for (const t of TARGETS) {
  test(`${t.name}: no error, cause, partial result or router event leaks the credential`, { timeout: 120_000 }, async () => {
    const leaks: string[] = [];
    const sent: string[] = [];
    for (const c of cases(t)) {
      for (const [kind, call] of calls) {
        const stub = await startStub(c.handler);
        try {
          const e = await thrown(call(t.make(stub.baseUrl, c.over), c.opts?.()));
          for (const r of stub.requests) sent.push(JSON.stringify({ url: r.url, body: r.body, headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => k !== "authorization" && k !== "x-api-key")) }));
          if (e === undefined) leaks.push(`${c.label} (${kind}) :: did not fail`);
          else leaks.push(...findLeaks(`${c.label} (${kind})`, e));
          if (!(e instanceof ProviderError)) leaks.push(`${c.label} (${kind}) :: threw a non-ProviderError: ${String(e).slice(0, 80)}`);
        } finally { await stub.close(); }
      }
    }
    assert.deepEqual(leaks, []);
    assert.deepEqual(sent.filter((s) => s.includes(t.key)), [], "the credential appears only in its own header");
  });

  test(`${t.name}: a refused connection and a plain-http refusal leak nothing`, { timeout: 30_000 }, async () => {
    const closed = await new Promise<string>((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(`http://127.0.0.1:${p}/v1`)); }); });
    const never = (async () => { throw new Error("fetch must not be called"); }) as unknown as typeof fetch;
    for (const [kind, call] of calls) {
      const e1 = await thrown(call(t.make(closed)));
      assert.ok(e1 instanceof ProviderError && e1.kind === "network", `${kind}: ${String(e1)}`);
      assert.deepEqual(findLeaks(`refused (${kind})`, e1), []);
      const e2 = await thrown(call(t.make("http://203.0.113.9:8080/v1", { fetch: never })));
      assert.ok(e2 instanceof ProviderError && e2.kind === "invalid_request", `${kind}: ${String(e2)}`);
      assert.deepEqual(findLeaks(`plain http (${kind})`, e2), []);
    }
  });

  test(`${t.name}: router events and the error the router rethrows leak nothing`, { timeout: 30_000 }, async () => {
    const events: RouterEvent[] = [];
    const stubs = [await startStub((_q, res) => body(res, 529, { "content-type": "application/json" }, t.errBody(`overloaded ${t.key}`, "overloaded_error", "server_is_overloaded"))), await startStub((_q, res) => body(res, 401, { "content-type": "application/json" }, t.errBody(`bad key ${t.key}`, "authentication_error", "invalid_api_key")))];
    try {
      const router = new ProviderRouter({
        profiles: { p: [{ provider: "a", model: "m1", adapter: t.make(stubs[0]!.baseUrl) }, { provider: "b", model: "m2", adapter: t.make(stubs[1]!.baseUrl) }] },
        clock: new FakeClock(), random: () => 0.5, retry: { maxRetries: 1 }, onEvent: (e) => events.push(e),
      });
      const e = await thrown(router.complete("p", REQ));
      assert.ok(e instanceof ProviderError && e.kind === "auth", String(e));
      assert.deepEqual(findLeaks("router error", e), []);
      assert.ok(events.length > 0);
      assert.deepEqual(findLeaks("router events", events), []);
    } finally { await Promise.all(stubs.map((s) => s.close())); }
  });
}
