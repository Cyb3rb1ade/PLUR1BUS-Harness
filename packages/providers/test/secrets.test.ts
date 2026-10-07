// C10 secrets hygiene. A sentinel key goes through every adapter (chat_completions, Gemini, the local adapter) and the
// router wrapping them; a loopback stub provokes every error path that is reachable (HTTP statuses, servers that echo the
// key in JSON, text, headers and structured fields, malformed JSON/SSE, truncation, cut connections, redirects, plain-http
// refusal, timeouts, aborts, safety blocks, tool-schema refusals, refused connections, a transport that echoes headers).
// Every thrown error and every router event is scanned recursively (message, providerMessage, code, name, stack, the
// cause chain, every own property, JSON.stringify, util.inspect) for the sentinels and for key-shaped strings.
// A finding is NOT fixed here: the test asserts the correct behaviour and stays red (see the report of the task).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { inspect } from "node:util";
import { createChatCompletionsAdapter, createGeminiAdapter, createLocalChatAdapter, ProviderError, ProviderRouter } from "../src/index.ts";
import type { CallOptions, ChatRequest, ChatResult, ChatStreamEvent, RouterEvent, Timeouts } from "../src/index.ts";
import { FakeClock } from "./router/helpers.ts";
import { hold, sleep, sseHeaders, startStub } from "./helpers/stub.ts";
import type { Handler, Recorded } from "./helpers/stub.ts";

const SK = "sk-test-SECRETSENTINEL0123456789abcdef";
const AIZA = "AIzaSyTESTSENTINEL0123456789abcdefghijk";
const SK_EXTRA = "sk-test-EXTRAHEADERSENTINEL0123456789abcdef";
const AIZA_EXTRA = "AIzaSyTESTEXTRAHDRSENTINEL0123456789abcdefg";

// ------------------------------------------------------------------------------------------------ the scanner

const RULES: readonly [string, RegExp][] = [
  ["sentinel sk", /sk-test-SECRETSENTINEL0123456789abcdef/],
  ["sentinel AIza", /AIzaSyTESTSENTINEL0123456789abcdefghijk/],
  ["sentinel marker", /SECRETSENTINEL|TESTSENTINEL|EXTRAHEADERSENTINEL|EXTRAHDRSENTINEL/],
  ["sk-… key shape", /sk-[A-Za-z0-9_-]{16,}/],
  ["AIza… key shape", /AIza[0-9A-Za-z_-]{20,}/],
  // The adapters' own placeholder "[redacted]" after "Bearer " / "key=" is the fix, not a leak.
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
  try { out.push(["JSON.stringify", JSON.stringify(v) ?? ""]); } catch { /* circular or BigInt: the walk covered it */ }
  out.push(["util.inspect", inspect(v, { depth: 10, showHidden: true })]);
  return out;
}

function findLeaks(label: string, v: unknown): string[] {
  // One line per value: the rules that fired, the property paths they fired in (JSON/inspect copies are noise, listed last), one excerpt.
  const rules = new Set<string>();
  const paths = new Set<string>();
  let excerpt = "";
  for (const [path, text] of surfaces(v)) {
    for (const [rule, re] of RULES) {
      const m = re.exec(text);
      if (m === null) continue;
      rules.add(rule);
      paths.add(path);
      if (excerpt === "" || rule === "sentinel sk" || rule === "sentinel AIza") excerpt = JSON.stringify(text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 8));
    }
  }
  if (rules.size === 0) return [];
  const props = [...paths].filter((p) => !p.startsWith("JSON.") && !p.startsWith("util."));
  return [`${label} :: ${[...rules].join(" + ")} :: in ${(props.length > 0 ? props : [...paths]).slice(0, 5).join(", ")} :: ${excerpt}`];
}

test("scanner self-test: every rule fires on a seeded value, and the placeholder is not a finding", () => {
  const e = new ProviderError("network", "x", { cause: new Error(`deep ${SK} and ${AIZA}`) });
  assert.ok(findLeaks("seed", e).some((l) => l.includes("sentinel sk")));
  assert.ok(findLeaks("seed", e).some((l) => l.includes("sentinel AIza")));
  for (const s of ["use sk-live-abcdefghijklmnop1", "AIzaAAAAAAAAAAAAAAAAAAAAAAAA", "Authorization: Bearer abcdefgh12345", "https://x.invalid/?a=1&key=abc123"]) {
    assert.ok(findLeaks("seed", new Error(s)).length > 0, s);
  }
  assert.deepEqual(findLeaks("clean", new ProviderError("auth", "request rejected (HTTP 401): Bearer [redacted] ?key=[redacted]")), []);
});

// ------------------------------------------------------------------------------------------------ targets

interface Over {
  timeouts?: Partial<Timeouts>;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  auth?: () => string | undefined | Promise<string | undefined>;
}
interface Adapter {
  complete(req: ChatRequest, o?: CallOptions): Promise<ChatResult>;
  stream(req: ChatRequest, o?: CallOptions): AsyncGenerator<ChatStreamEvent, void, void>;
}
interface Target {
  readonly name: "chat_completions" | "gemini" | "local";
  readonly wire: "openai" | "gemini";
  /** The secret this target sends (the local adapter sends none). */
  readonly key: string | undefined;
  make(baseUrl: string, over?: Over): Adapter;
  errBody(status: number, message: string, code?: string, type?: string): string;
}

const BASE_TIMEOUTS: Partial<Timeouts> = { headersMs: 5_000, idleMs: 5_000, totalMs: 10_000 };
const GSTATUS: Record<number, string> = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 408: "DEADLINE_EXCEEDED", 413: "INVALID_ARGUMENT", 429: "RESOURCE_EXHAUSTED", 500: "INTERNAL", 502: "UNAVAILABLE", 503: "UNAVAILABLE", 529: "UNAVAILABLE" };
const oaiBody = (_s: number, message: string, code?: string, type?: string) => JSON.stringify({ error: { message, type: type ?? "invalid_request_error", code: code ?? null } });

function chatConfig(baseUrl: string, over: Over | undefined, auth: () => string | undefined | Promise<string | undefined>) {
  return {
    baseUrl, credentials: { authorization: over?.auth ?? auth }, timeouts: over?.timeouts ?? BASE_TIMEOUTS,
    ...(over?.headers ? { headers: over.headers } : {}), ...(over?.fetch ? { fetch: over.fetch } : {}),
  };
}

const TARGETS: readonly Target[] = [
  {
    name: "chat_completions", wire: "openai", key: SK, errBody: oaiBody,
    make: (baseUrl, over) => createChatCompletionsAdapter(chatConfig(baseUrl, over, () => `Bearer ${SK}`)),
  },
  {
    name: "gemini", wire: "gemini", key: AIZA,
    errBody: (status, message, code, type) => JSON.stringify({ error: { code: status, message, status: type ?? code ?? GSTATUS[status] ?? "UNKNOWN" } }),
    make: (baseUrl, over) => createGeminiAdapter({
      baseUrl, credentials: { apiKey: over?.auth ?? (() => AIZA) }, timeouts: over?.timeouts ?? BASE_TIMEOUTS,
      ...(over?.headers ? { headers: over.headers } : {}), ...(over?.fetch ? { fetch: over.fetch } : {}),
    }),
  },
  {
    name: "local", wire: "openai", key: undefined, errBody: oaiBody,
    make: (baseUrl, over) => createLocalChatAdapter({ state: "ok", baseUrl }, createChatCompletionsAdapter, {
      timeouts: over?.timeouts ?? BASE_TIMEOUTS, ...(over?.headers ? { headers: over.headers } : {}), ...(over?.fetch ? { fetch: over.fetch } : {}),
    }),
  },
];

const REQ: ChatRequest = { model: "secrets-model", messages: [{ role: "user", content: "hi" }] };

// ------------------------------------------------------------------------------------------------ server pieces

type Echo = (t: Target, rec: Recorded) => string;
/** What a leaky server says back: the key everywhere a server might put it. The local adapter sends no key, so its server echoes what it actually saw. */
const echoText: Echo = (t, rec) => t.key !== undefined
  ? `Incorrect API key provided: ${t.key}. Authorization: Bearer ${t.key}. Retry at https://api.example.invalid/v1?key=${t.key}`
  : `unauthorized; request seen: ${JSON.stringify({ url: rec.url, headers: rec.headers })}`;
const echoHeaders: Echo = (_t, rec) => `request headers: ${JSON.stringify(rec.headers)}`;
const hdrEcho = (t: Target, rec: Recorded): string => (t.key !== undefined ? `Bearer ${t.key}` : JSON.stringify(rec.headers).slice(0, 300));

const RETRY_AFTER = new Set([429, 503, 529]);
interface ErrOpts { msg?: (e: string) => string; code?: (e: string) => string; type?: (e: string) => string; echo?: Echo; ct?: string }

function jsonErr(t: Target, status: number, o: ErrOpts = {}): Handler {
  return (_q, res, rec) => {
    const e = (o.echo ?? echoText)(t, rec);
    const headers: Record<string, string> = { "content-type": o.ct ?? "application/json", "x-request-echo": hdrEcho(t, rec) };
    if (RETRY_AFTER.has(status)) headers["retry-after"] = "1";
    res.writeHead(status, headers);
    res.end(t.errBody(status, o.msg ? o.msg(e) : e, o.code?.(e), o.type?.(e)));
  };
}

function textErr(t: Target, status: number, ct = "text/plain", wrap = (e: string) => e, echo: Echo = echoText): Handler {
  return (_q, res, rec) => {
    const headers: Record<string, string> = { "content-type": ct, "x-request-echo": hdrEcho(t, rec) };
    if (RETRY_AFTER.has(status)) headers["retry-after"] = "1";
    res.writeHead(status, headers);
    res.end(wrap(echo(t, rec)));
  };
}

const J = JSON.stringify;
const textFrame = (t: Target, s: string) => t.wire === "gemini"
  ? J({ candidates: [{ content: { parts: [{ text: s }], role: "model" }, index: 0 }] })
  : J({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: s }, finish_reason: null }] });
const errFrame = (t: Target, message: string, code?: string, type?: string) => t.wire === "gemini"
  ? J({ error: { code: 503, message, status: type ?? code ?? "UNAVAILABLE" } })
  : J({ error: { message, type: type ?? "server_error", code: code ?? null } });

type After = "end" | "hold" | "destroy";
function sseServe(t: Target, frames: (e: string) => string[], after: After = "end", echo: Echo = echoText): Handler {
  return async (_q, res, rec) => {
    sseHeaders(res);
    const eol = t.wire === "gemini" ? "\r\n\r\n" : "\n\n";
    for (const f of frames(echo(t, rec))) await new Promise<void>((ok) => res.write(`data: ${f}${eol}`, () => ok()));
    if (after === "end") res.end();
    else if (after === "destroy") { await sleep(40); res.destroy(); }
    else await new Promise<void>((ok) => { if (res.destroyed) ok(); else res.on("close", () => ok()); });
  };
}

const holdForever: Handler = async (_q, res) => { await hold(res); };

async function deadBase(): Promise<string> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return `http://127.0.0.1:${port}/v1`;
}

const throwingFetch = (async () => { throw new Error("fetch must not be called"); }) as unknown as typeof fetch;

// ------------------------------------------------------------------------------------------------ the exerciser

type Mode = "complete" | "stream" | "router";
const ALL: Mode[] = ["complete", "stream", "router"];
const STREAMING: Mode[] = ["stream", "router"];

interface Case {
  label: string;
  handler?: Handler;
  modes?: Mode[];
  over?: Over;
  req?: ChatRequest;
  baseUrl?: string;
  abortAfterMs?: number;
  /** Default true: every mode must fail (a case that quietly succeeds proves nothing). */
  failing?: boolean;
}

interface Capture { errors: { mode: Mode; error: unknown }[]; passed: Mode[]; events: RouterEvent[]; requests: Recorded[] }

async function guarded<T>(label: string, p: Promise<T>, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<never>((_ok, no) => { timer = setTimeout(() => no(new Error(`${label}: pending after ${ms} ms (hang)`)), ms); });
  try { return await Promise.race([p, hung]); } finally { clearTimeout(timer); }
}

async function exercise(t: Target, c: Case): Promise<Capture> {
  const stub = await startStub(c.handler ?? ((_q, res) => { res.end(); }));
  const cap: Capture = { errors: [], passed: [], events: [], requests: stub.requests };
  const req = c.req ?? REQ;
  try {
    for (const mode of c.modes ?? ALL) {
      const adapter = t.make(c.baseUrl ?? stub.baseUrl, c.over);
      const ac = new AbortController();
      const timer = c.abortAfterMs === undefined ? undefined : setTimeout(() => ac.abort(new Error("stop")), c.abortAfterMs);
      const opts: CallOptions = c.abortAfterMs === undefined ? {} : { signal: ac.signal };
      try {
        await guarded(`${t.name}/${c.label}/${mode}`, (async () => {
          if (mode === "complete") await adapter.complete(req, opts);
          else if (mode === "stream") { for await (const _e of adapter.stream(req, opts)) { /* drain */ } }
          else {
            const router = new ProviderRouter({
              profiles: { p: [{ provider: "t", model: req.model, adapter }] }, clock: new FakeClock(), random: () => 0,
              retry: { maxRetries: 1 }, breaker: { failureThreshold: 1000 }, onEvent: (e) => cap.events.push(e),
            });
            for await (const _e of router.stream("p", req, opts)) { /* drain */ }
          }
        })());
        cap.passed.push(mode);
      } catch (error) { cap.errors.push({ mode, error }); } finally { clearTimeout(timer); }
    }
  } finally { await stub.close(); }
  return cap;
}

interface Report { leaks: string[]; problems: string[]; errors: number; redactions: number; requests: number }

async function runCases(t: Target, cases: Case[]): Promise<Report> {
  const r: Report = { leaks: [], problems: [], errors: 0, redactions: 0, requests: 0 };
  for (const c of cases) {
    const cap = await exercise(t, c);
    r.errors += cap.errors.length;
    r.requests += cap.requests.length;
    for (const { mode, error } of cap.errors) {
      r.leaks.push(...findLeaks(`${t.name} :: ${c.label} :: ${mode}`, error));
      if (inspect(error, { depth: 10, showHidden: true }).includes("[redacted]")) r.redactions++;
    }
    r.leaks.push(...findLeaks(`${t.name} :: ${c.label} :: router events`, cap.events));
    if (c.failing !== false && cap.passed.length > 0) r.problems.push(`${t.name} :: ${c.label}: ${cap.passed.join(",")} did not fail, the path was not provoked`);
    for (const rec of cap.requests) {
      const wire = `${rec.url ?? ""}|${rec.body}`;
      for (const s of [SK, AIZA, SK_EXTRA, AIZA_EXTRA]) if (wire.includes(s)) r.problems.push(`${t.name} :: ${c.label}: a secret travelled in the URL or body`);
      if (t.name === "chat_completions" && rec.headers["authorization"] !== `Bearer ${SK}`) r.problems.push(`${t.name} :: ${c.label}: authorization header missing`);
      if (t.name === "gemini" && rec.headers["x-goog-api-key"] !== AIZA) r.problems.push(`${t.name} :: ${c.label}: x-goog-api-key header missing`);
      if (t.name === "local" && (rec.headers["authorization"] !== undefined || rec.headers["x-goog-api-key"] !== undefined)) r.problems.push(`${t.name} :: ${c.label}: a loopback server was sent credentials`);
    }
  }
  return r;
}

function verdict(rs: Report, what: string, o: { minErrors?: number; redactions?: boolean } = {}): void {
  assert.deepEqual(rs.problems, [], `test setup: ${what}`);
  assert.ok(rs.errors >= (o.minErrors ?? 1), `${what}: only ${rs.errors} errors were provoked`);
  if (o.redactions) assert.ok(rs.redactions > 0, `${what}: no error showed "[redacted]", so the server echo never reached the adapter and the test was vacuous`);
  assert.equal(rs.leaks.length, 0, `LEAKS (${rs.leaks.length}):\n${rs.leaks.slice(0, 40).join("\n")}${rs.leaks.length > 40 ? `\n… ${rs.leaks.length - 40} more` : ""}`);
}

const T = { timeout: 120_000 };
const STATUSES = [400, 401, 403, 404, 408, 413, 429, 500, 502, 503, 529];
const TOOLS_REQ: ChatRequest = { ...REQ, tools: [{ name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } }] };

// ------------------------------------------------------------------------------------------------ the matrix

for (const t of TARGETS) {
  test(`${t.name}: HTTP errors (every status) with the key echoed in JSON message, plain text, HTML and a header`, T, async () => {
    const cases: Case[] = [];
    for (const s of STATUSES) {
      cases.push({ label: `${s} json message`, handler: jsonErr(t, s) });
      cases.push({ label: `${s} plain text`, handler: textErr(t, s) });
    }
    cases.push({ label: "502 html", handler: textErr(t, 502, "text/html", (e) => `<html><body><h1>Bad gateway</h1><pre>${e}</pre></body></html>`) });
    cases.push({ label: "400 content_filter", handler: jsonErr(t, 400, { code: () => "content_filter", type: () => "content_filter" }) });
    cases.push({ label: "400 context length", handler: jsonErr(t, 400, { msg: (e) => `maximum context length exceeded; ${e}` }) });
    cases.push({ label: "400 tool schema refusal", handler: jsonErr(t, 400, { msg: (e) => `Invalid schema for function 'get_weather': ${e}` }), req: TOOLS_REQ });
    const rs = await runCases(t, cases);
    verdict(rs, "http matrix", { minErrors: 60, redactions: t.key !== undefined });
    if (t.key !== undefined) assert.ok(rs.requests > 0);
  });

  test(`${t.name}: errors inside a 200 (stream error event, JSON error body) and safety blocks echo the key in their text`, T, async () => {
    const cases: Case[] = [
      { label: "stream error event after deltas", handler: sseServe(t, (e) => [textFrame(t, "Hel"), errFrame(t, e)]), modes: STREAMING },
      { label: "200 json error body", handler: jsonErr(t, 200, { msg: (e) => e }), failing: true },
    ];
    if (t.wire === "gemini") {
      cases.push(
        { label: "prompt blocked (stream), blockReasonMessage echoes", handler: sseServe(t, (e) => [J({ promptFeedback: { blockReason: "SAFETY", blockReasonMessage: e } })]), modes: STREAMING },
        { label: "prompt blocked (json), blockReasonMessage echoes", handler: (_q, res, rec) => { res.writeHead(200, { "content-type": "application/json" }); res.end(J({ promptFeedback: { blockReason: "OTHER", blockReasonMessage: echoText(t, rec) } })); } },
        { label: "candidate SAFETY (stream), finishMessage echoes", handler: sseServe(t, (e) => [J({ candidates: [{ content: { parts: [{ text: "x" }], role: "model" }, finishReason: "SAFETY", finishMessage: e, index: 0 }] })]), modes: STREAMING },
        { label: "candidate RECITATION (json), finishMessage echoes", handler: (_q, res, rec) => { res.writeHead(200, { "content-type": "application/json" }); res.end(J({ candidates: [{ content: { parts: [{ text: "x" }], role: "model" }, finishReason: "RECITATION", finishMessage: echoText(t, rec), index: 0 }] })); } },
      );
    }
    verdict(await runCases(t, cases), "in-200 errors", { minErrors: t.wire === "gemini" ? 14 : 5, redactions: t.key !== undefined });
  });

  test(`${t.name}: structured provider fields (code, type/status, blockReason, safety categories) echo the key`, T, async () => {
    const cases: Case[] = [];
    for (const s of [400, 401, 403, 404, 429, 500, 503]) {
      cases.push({ label: `${s} code/type echo, benign message`, handler: jsonErr(t, s, { msg: () => "request failed", code: (e) => `err_${e}`, type: (e) => `type_${e}` }) });
    }
    cases.push({ label: "stream error frame code/type echo", handler: sseServe(t, (e) => [textFrame(t, "Hel"), errFrame(t, "failed", `c_${e}`, `t_${e}`)]), modes: STREAMING });
    cases.push({ label: "200 json error code/type echo", handler: jsonErr(t, 200, { msg: () => "failed", code: (e) => `c_${e}`, type: (e) => `t_${e}` }) });
    if (t.wire === "gemini") {
      cases.push(
        { label: "prompt blockReason echo", handler: sseServe(t, (e) => [J({ promptFeedback: { blockReason: `BLOCK_${e}` } })]), modes: STREAMING },
        { label: "safetyRatings category echo", handler: sseServe(t, (e) => [J({ candidates: [{ content: { parts: [{ text: "x" }], role: "model" }, finishReason: "SAFETY", safetyRatings: [{ category: e, probability: `P_${e}`, blocked: true }], index: 0 }] })]), modes: STREAMING },
      );
    }
    verdict(await runCases(t, cases), "structured fields", { minErrors: 9 });
  });

  test(`${t.name}: malformed JSON / SSE, invalid UTF-8, empty and truncated streams, cut connections`, T, async () => {
    const jsonBody = (body: (e: string) => string): Handler => (_q, res, rec) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body(echoText(t, rec))); };
    const cases: Case[] = [
      { label: "200 body is the bare echo", handler: jsonBody((e) => e) },
      { label: "200 body is truncated JSON around the echo", handler: jsonBody((e) => `{"echo":"${e}"`) },
      { label: "200 body has an unquoted echo", handler: jsonBody((e) => `{"echo": ${e}}`) },
      { label: "malformed SSE data event around the echo", handler: sseServe(t, (e) => [`{"echo": ${e}`]), modes: STREAMING },
      { label: "SSE data event that is not an object", handler: sseServe(t, (e) => [J(e)]), modes: STREAMING },
      { label: "invalid UTF-8 in the stream", handler: (_q, res) => { sseHeaders(res); res.end(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0xfe, 0x0a, 0x0a])); }, modes: STREAMING },
      { label: "empty event stream", handler: (_q, res) => { sseHeaders(res); res.end(); }, modes: STREAMING },
      { label: "truncated stream (deltas, no finish)", handler: sseServe(t, () => [textFrame(t, "Hel"), textFrame(t, "lo")]), modes: STREAMING },
      { label: "connection cut mid-stream", handler: sseServe(t, () => [textFrame(t, "Hel")], "destroy"), modes: STREAMING },
      { label: "connection cut before any byte", handler: (_q, res) => { res.destroy(); } },
    ];
    verdict(await runCases(t, cases), "malformed", { minErrors: 20 });
  });

  test(`${t.name}: a server-chosen content-type that carries the key`, T, async () => {
    const cases: Case[] = [{
      label: "200 with an echoing content-type", modes: STREAMING,
      handler: (_q, res, rec) => { res.writeHead(200, { "content-type": `text/plain; x-echo=${hdrEcho(t, rec)}` }); res.end("nope"); },
    }];
    verdict(await runCases(t, cases), "content-type", { minErrors: 2 });
  });

  test(`${t.name}: transport and lifecycle paths (refused connection, redirects, timeouts, aborts)`, T, async () => {
    const dead = await deadBase();
    const loc = (s: number): Handler => (_q, res, rec) => {
      res.writeHead(s, { location: `https://example.invalid/cb?key=${t.key ?? "none"}&x=1`, "x-request-echo": hdrEcho(t, rec) });
      res.end(echoText(t, rec));
    };
    const cases: Case[] = [
      { label: "connection refused", baseUrl: dead },
      ...[301, 302, 303, 307, 308].map((s): Case => ({ label: `redirect ${s} with the key in Location`, handler: loc(s) })),
      { label: "timeout waiting for headers", handler: holdForever, over: { timeouts: { headersMs: 120, idleMs: 120, totalMs: 400 } } },
      { label: "idle timeout mid-stream", handler: sseServe(t, () => [textFrame(t, "Hel")], "hold"), over: { timeouts: { headersMs: 1000, idleMs: 120, totalMs: 2000 } }, modes: STREAMING },
      { label: "abort while waiting for headers", handler: holdForever, abortAfterMs: 80 },
      { label: "abort mid-stream", handler: sseServe(t, () => [textFrame(t, "Hel")], "hold"), abortAfterMs: 80, modes: STREAMING },
    ];
    if (t.name !== "local") {
      cases.push({ label: "plain http to a non-loopback host is refused before any I/O", baseUrl: "http://203.0.113.9:8080/v1", over: { fetch: throwingFetch } });
    }
    verdict(await runCases(t, cases), "transport", { minErrors: 24 });
  });

  test(`${t.name}: a transport that echoes the request headers in its own error text`, T, async () => {
    const echoing = (async (_u: unknown, init?: RequestInit) => {
      const pairs: string[] = [];
      new Headers(init?.headers).forEach((v, k) => { pairs.push(`${k}: ${v}`); });
      const h = pairs.join("; ");
      throw new TypeError(`fetch failed: proxy tunnel refused (request headers: ${h})`, { cause: new Error(`upstream said: ${h}`) });
    }) as unknown as typeof fetch;
    const rs = await runCases(t, [{ label: "injected fetch throws with the request headers in its message", over: { fetch: echoing } }]);
    verdict(rs, "echoing transport", { minErrors: 3 });
  });

  test(`${t.name}: extra headers (api-key style) echoed back by the server`, T, async () => {
    const extra: Record<string, string> = t.name === "gemini" ? { "x-extra-key": AIZA_EXTRA } : { "x-api-key": SK_EXTRA };
    const over: Over = { headers: extra };
    const cases: Case[] = [
      { label: "401 json echoing every request header", handler: jsonErr(t, 401, { echo: echoHeaders }), over },
      { label: "500 text echoing every request header", handler: textErr(t, 500, "text/plain", (e) => e, echoHeaders), over },
      { label: "stream error event echoing every request header", handler: sseServe(t, (e) => [textFrame(t, "Hel"), errFrame(t, e)], "end", echoHeaders), modes: STREAMING, over },
    ];
    verdict(await runCases(t, cases), "extra headers", { minErrors: 7 });
  });

  test(`${t.name}: credential and configuration refusals (unusable key, failing provider, key in baseUrl, forbidden header)`, T, async () => {
    const secret = t.key ?? SK;
    const unusable = t.name === "gemini"
      ? [`${AIZA} trailing`, `${AIZA}\n`, ""]
      : [`Bearer ${SK}\n`, `Bearer ${SK}\u0000`, ""];
    const cases: Case[] = [];
    if (t.name !== "local") {
      for (const v of unusable) cases.push({ label: `unusable credential ${J(v).slice(0, 14)}…`, over: { auth: () => v }, handler: (_q, res) => { res.end(); } });
      cases.push({ label: "credentials provider throws", over: { auth: () => { throw new Error("vault locked"); } } });
      cases.push({ label: "credentials provider rejects", over: { auth: () => Promise.reject(new Error("vault locked")) } });
      if (t.name === "gemini") cases.push({ label: "no key stored", over: { auth: () => undefined } });
    }
    const rs = await runCases(t, cases);
    // Construction-time refusals throw synchronously: scan them too.
    const ctor: [string, () => unknown][] = t.name === "local"
      ? [
        ["credentials passed to a loopback endpoint", () => createLocalChatAdapter({ state: "ok", baseUrl: "http://127.0.0.1:1/v1" }, createChatCompletionsAdapter, { credentials: { authorization: () => `Bearer ${SK}` } })],
        ["Authorization header to a loopback endpoint", () => createLocalChatAdapter({ state: "ok", baseUrl: "http://127.0.0.1:1/v1" }, createChatCompletionsAdapter, { headers: { Authorization: `Bearer ${SK}` } })],
        ["cookie header to a loopback endpoint", () => createLocalChatAdapter({ state: "ok", baseUrl: "http://127.0.0.1:1/v1" }, createChatCompletionsAdapter, { headers: { cookie: `session=${SK}` } })],
        ["non-loopback endpoint without opt-in", () => createLocalChatAdapter({ state: "ok", baseUrl: `http://203.0.113.9:1/v1?key=${SK}` }, createChatCompletionsAdapter)],
        ["unusable endpoint state", () => createLocalChatAdapter({ state: "unreachable", baseUrl: "http://127.0.0.1:1/v1" }, createChatCompletionsAdapter)],
      ]
      : t.name === "gemini"
        ? [
          ["key as a user:password in baseUrl", () => createGeminiAdapter({ baseUrl: `http://user:${AIZA}@127.0.0.1:1/v1beta`, credentials: { apiKey: () => AIZA } })],
          ["key as ?key= in baseUrl", () => createGeminiAdapter({ baseUrl: `http://127.0.0.1:1/v1beta?key=${AIZA}`, credentials: { apiKey: () => AIZA } })],
          ["key as a fragment in baseUrl", () => createGeminiAdapter({ baseUrl: `http://127.0.0.1:1/v1beta#${AIZA}`, credentials: { apiKey: () => AIZA } })],
          ["key header supplied as an extra header", () => createGeminiAdapter({ baseUrl: "http://127.0.0.1:1/v1beta", credentials: { apiKey: () => AIZA }, headers: { "X-Goog-Api-Key": AIZA } })],
          ["header value with a line break and the key", () => createGeminiAdapter({ baseUrl: "http://127.0.0.1:1/v1beta", credentials: { apiKey: () => AIZA }, headers: { "x-a": `v\r\n${AIZA}` } })],
          ["unparsable baseUrl containing the key", () => createGeminiAdapter({ baseUrl: `not a url ${AIZA}`, credentials: { apiKey: () => AIZA } })],
        ]
        : [
          ["key as a user:password in baseUrl", () => createChatCompletionsAdapter({ baseUrl: `http://user:${SK}@127.0.0.1:1/v1`, credentials: { authorization: () => `Bearer ${SK}` } })],
          ["key as ?key= in baseUrl", () => createChatCompletionsAdapter({ baseUrl: `http://127.0.0.1:1/v1?key=${SK}`, credentials: { authorization: () => `Bearer ${SK}` } })],
          ["key as a fragment in baseUrl", () => createChatCompletionsAdapter({ baseUrl: `http://127.0.0.1:1/v1#${SK}`, credentials: { authorization: () => `Bearer ${SK}` } })],
          ["authorization supplied as an extra header", () => createChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:1/v1", credentials: { authorization: () => `Bearer ${SK}` }, headers: { Authorization: `Bearer ${SK}` } })],
          ["header value with a line break and the key", () => createChatCompletionsAdapter({ baseUrl: "http://127.0.0.1:1/v1", credentials: { authorization: () => `Bearer ${SK}` }, headers: { "x-a": `v\r\n${SK}` } })],
          ["unparsable baseUrl containing the key", () => createChatCompletionsAdapter({ baseUrl: `not a url ${SK}`, credentials: { authorization: () => `Bearer ${SK}` } })],
        ];
    let thrown = 0;
    for (const [label, build] of ctor) {
      try { build(); rs.problems.push(`${t.name} :: ${label}: construction did not throw`); } catch (e) { thrown++; rs.leaks.push(...findLeaks(`${t.name} :: ctor :: ${label}`, e)); }
    }
    rs.errors += thrown;
    // A local adapter handed credentials for a non-loopback endpoint (explicit opt-in) must still refuse plain http before any I/O.
    if (t.name === "local") {
      const adapter = createLocalChatAdapter({ state: "ok", baseUrl: "http://203.0.113.9:8080/v1" }, createChatCompletionsAdapter,
        { credentials: { authorization: () => `Bearer ${SK}` }, fetch: throwingFetch }, { allowNonLoopback: true });
      const e = await adapter.complete(REQ).then(() => undefined, (x: unknown) => x);
      assert.ok(e instanceof ProviderError && e.kind === "invalid_request", String(e));
      rs.leaks.push(...findLeaks("local :: plain http with credentials", e));
      rs.errors++;
    }
    assert.ok(secret.length > 0);
    verdict(rs, "credential refusals", { minErrors: t.name === "local" ? 6 : 10 });
  });

  test(`${t.name}: request-level refusals before any I/O (tool schema, tool names, messages)`, T, async () => {
    const badTools: ChatRequest[] = [
      { ...REQ, tools: [{ name: "a", parameters: { type: "object" } }, { name: "a", parameters: { type: "object" } }] },
      { ...REQ, tools: [{ name: "bad name!", parameters: { type: "object" } }] },
      { ...REQ, toolChoice: { name: "ghost" } },
      { ...REQ, tools: [{ name: "search", parameters: { type: "object", properties: { q: { type: "string", patternProperties: {} } } } }] },
      { ...REQ, tools: [{ name: "search", parameters: { $ref: "#/$defs/missing" } }] },
      { ...REQ, messages: [] },
    ];
    const cases = badTools.map((req, i): Case => ({ label: `refused request #${i}`, req, over: { fetch: throwingFetch }, failing: i === 3 || i === 4 ? t.name === "gemini" : true }));
    const rs = await runCases(t, cases);
    // chat_completions forwards a schema it does not judge: those two (patternProperties / $ref) only fail on Gemini.
    rs.problems = rs.problems.filter((p) => !/refused request #[34]/.test(p));
    verdict(rs, "request refusals", { minErrors: 4 });
  });
}

// ------------------------------------------------------------------------------------------------ the router, wrapping all of them

test("router over chat_completions -> gemini -> local: retries, fallbacks and the final error carry no secret", T, async () => {
  const [chat, gem, loc] = TARGETS as [Target, Target, Target];
  const stubs = await Promise.all([startStub(jsonErr(chat, 503)), startStub(jsonErr(gem, 429, { code: (e) => `c_${e}`, type: (e) => `RESOURCE_EXHAUSTED` })), startStub(textErr(loc, 500))]);
  const leaks: string[] = [];
  try {
    const events: RouterEvent[] = [];
    const mk = () => new ProviderRouter({
      profiles: { p: [
        { provider: "oa", model: "m1", adapter: chat.make(stubs[0].baseUrl) },
        { provider: "gm", model: "m2", adapter: gem.make(stubs[1].baseUrl) },
        { provider: "lo", model: "m3", adapter: loc.make(stubs[2].baseUrl) },
      ] },
      clock: new FakeClock(), random: () => 0, retry: { maxRetries: 1 }, breaker: { failureThreshold: 1000 }, onEvent: (e) => events.push(e),
    });
    const errors: unknown[] = [];
    for (const fn of [
      async () => { for await (const _e of mk().stream("p", REQ)) { /* drain */ } },
      async () => { await mk().complete("p", REQ); },
      async () => { for await (const _e of mk().stream("nope", REQ)) { /* drain */ } },
    ]) { try { await fn(); } catch (e) { errors.push(e); } }
    assert.equal(errors.length, 3, "every router call failed");
    assert.ok(events.some((e) => e.type === "provider.fallback") && events.some((e) => e.type === "provider.retry"), "fallbacks and retries were provoked");
    for (const [i, e] of errors.entries()) leaks.push(...findLeaks(`router chain :: error ${i}`, e));
    leaks.push(...findLeaks("router chain :: events", events));
    // The first candidate's key is auth-failed: auth does not fall back; the error and events must still be clean.
    const authStub = await startStub(jsonErr(chat, 401));
    try {
      const ev2: RouterEvent[] = [];
      const router = new ProviderRouter({ profiles: { p: [{ provider: "oa", model: "m", adapter: chat.make(authStub.baseUrl) }, { provider: "lo", model: "m", adapter: loc.make(stubs[2].baseUrl) }] }, clock: new FakeClock(), onEvent: (e) => ev2.push(e) });
      const e = await router.complete("p", REQ).then(() => undefined, (x: unknown) => x);
      assert.ok(e instanceof ProviderError && e.kind === "auth", String(e));
      leaks.push(...findLeaks("router auth :: error", e), ...findLeaks("router auth :: events", ev2));
    } finally { await authStub.close(); }
  } finally { await Promise.all(stubs.map((s) => s.close())); }
  assert.equal(leaks.length, 0, `LEAKS (${leaks.length}):\n${leaks.join("\n")}`);
});

test("local: the loopback server is never sent the key, whatever the caller's environment holds", T, async () => {
  const [, , loc] = TARGETS as [Target, Target, Target];
  const stub = await startStub((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(J({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })); });
  const saved = { OPENAI_API_KEY: process.env["OPENAI_API_KEY"], GEMINI_API_KEY: process.env["GEMINI_API_KEY"] };
  process.env["OPENAI_API_KEY"] = SK;
  process.env["GEMINI_API_KEY"] = AIZA;
  try {
    await loc.make(stub.baseUrl).complete(REQ);
    for await (const _e of loc.make(stub.baseUrl).stream(REQ)) { /* a JSON body on a stream call fails; the request is what matters */ }
  } catch { /* expected for the stream call */ } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await stub.close();
  }
  assert.ok(stub.requests.length >= 1);
  for (const r of stub.requests) assert.equal(JSON.stringify([r.url, r.headers, r.body]).includes("SENTINEL"), false);
});
