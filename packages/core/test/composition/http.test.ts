import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { anthropicBreakpoints, providerFetch } from "../../src/composition/http.ts";
import { promptContext } from "../../src/composition/context.ts";
import { ProviderError } from "../../../providers/src/index.ts";
import type { RenderedPrompt } from "../../src/prompt/index.ts";

// A hand-built rendered prompt: anthropicBreakpoints reads only `segments` and `breakpoints`.
function prompt(segments: unknown[], breakpoints: unknown[]): RenderedPrompt { return { segments, breakpoints } as unknown as RenderedPrompt; }
const bp = (segment: number, ttl: "5m" | "1h") => ({ segment, ttl, zone: "x", kind: "zone", byteOffset: 0, tokenEstimate: 0, hash: "h" });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function anthropicBody() {
  return {
    model: "m",
    tools: [{ name: "a", input_schema: {} }, { name: "b", input_schema: {}, cache_control: { type: "ephemeral" } }],
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }, { type: "text", text: "mem" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "a", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, { type: "text", text: "live recall" }] },
    ],
  };
}
const segments = [
  { zone: "tools", kind: "tool_def", text: "a" }, { zone: "tools", kind: "tool_def", text: "b" },
  { zone: "system", kind: "system", text: "sys" }, { zone: "memory", kind: "memory", text: "mem" },
  { zone: "conversation", kind: "text", role: "user", text: "hello" },
  { zone: "conversation", kind: "tool_use", role: "assistant", text: "", id: "t1" },
  { zone: "conversation", kind: "tool_result", role: "user", text: "ok", id: "t1" },
  { zone: "volatile", kind: "context", role: "user", text: "live recall" },
];

describe("composition/http anthropicBreakpoints", () => {
  it("returns the very same body untouched when no rendered prompt is in scope", () => {
    const body = anthropicBody();
    const before = clone(body);
    assert.equal(anthropicBreakpoints(body), body);
    assert.deepEqual(body, before, "existing cache_control markers survive when there is no prompt context");
  });

  it("clears every old marker and places exactly the builder's breakpoints (tools, memory/system, conversation)", () => {
    const body = anthropicBody();
    const out = promptContext.run(prompt(segments, [bp(1, "1h"), bp(3, "1h"), bp(6, "5m")]), () => anthropicBreakpoints(body)) as ReturnType<typeof anthropicBody>;
    assert.equal(out, body, "mutates and returns the same object");
    const marked = (x: unknown) => (x as { cache_control?: unknown }).cache_control;
    assert.equal(marked(out.tools[0]), undefined);
    assert.deepEqual(marked(out.tools[1]), { type: "ephemeral", ttl: "1h" });
    assert.equal(marked(out.system[0]), undefined, "the stale marker on the system block is removed");
    assert.deepEqual(marked(out.system[1]), { type: "ephemeral", ttl: "1h" }, "memory is the 2nd stable text segment");
    assert.equal(marked(out.messages[0]!.content[0]), undefined);
    assert.deepEqual(marked(out.messages[2]!.content[0]), { type: "ephemeral" }, "5m is the default ttl, written without a ttl field");
    assert.equal(marked(out.messages[2]!.content[1]), undefined, "volatile recall is never cached");
  });

  it("an interior conversation breakpoint lands on the matching tool_use block", () => {
    const body = anthropicBody();
    promptContext.run(prompt(segments, [bp(5, "5m")]), () => anthropicBreakpoints(body));
    assert.deepEqual((body.messages[1]!.content[0] as Record<string, unknown>).cache_control, { type: "ephemeral" });
  });

  it("a breakpoint whose segment has no counterpart in the body is dropped rather than misplaced", () => {
    const body = anthropicBody();
    body.messages = [{ role: "user", content: [{ type: "text", text: "something else" }] }];
    promptContext.run(prompt(segments, [bp(4, "5m")]), () => anthropicBreakpoints(body));
    assert.equal(JSON.stringify(body).includes("cache_control"), false);
  });

  it("a body without tools, system or messages is handled", () => {
    const out = promptContext.run(prompt(segments, [bp(1, "1h"), bp(3, "5m"), bp(6, "5m")]), () => anthropicBreakpoints({ model: "m" }));
    assert.deepEqual(out, { model: "m" });
  });

  it("no breakpoints: markers are cleared and none are added", () => {
    const body = anthropicBody();
    promptContext.run(prompt(segments, []), () => anthropicBreakpoints(body));
    assert.equal(JSON.stringify(body).includes("cache_control"), false);
  });
});

describe("composition/http providerFetch with an injected transport", () => {
  const never = { decide: async () => { throw new Error("egress must not be consulted for a recorded transport"); } };
  const okResponse = () => new Response("{}", { status: 200 });

  it("hands the exact request on, forces redirect:error and never touches egress", async () => {
    let seen: { input: unknown; init: RequestInit | undefined } | undefined;
    const f = providerFetch(never, "chat_completions", (async (input: unknown, init?: RequestInit) => { seen = { input, init }; return okResponse(); }) as typeof fetch);
    const res = await f("https://api.example.invalid/v1/chat", { method: "POST", headers: { "x-probe": "1" }, body: '{"a":1}', redirect: "follow" });
    assert.equal(res.status, 200);
    assert.equal(seen!.input, "https://api.example.invalid/v1/chat");
    assert.equal(seen!.init!.redirect, "error");
    assert.equal(seen!.init!.body, '{"a":1}');
    assert.equal(seen!.init!.method, "POST");
    assert.deepEqual(seen!.init!.headers, { "x-probe": "1" });
  });

  it("rewrites the body only for the anthropic_messages format", async () => {
    const bodies: Record<string, unknown> = {};
    for (const format of ["anthropic_messages", "chat_completions", "gemini", "codex_responses"]) {
      const f = providerFetch(never, format, (async (_i: unknown, init?: RequestInit) => { bodies[format] = init?.body; return okResponse(); }) as typeof fetch);
      await promptContext.run(prompt(segments, []), () => f("https://x.invalid/", { method: "POST", body: JSON.stringify(anthropicBody()) }));
    }
    assert.equal(JSON.stringify(JSON.parse(bodies.anthropic_messages as string)).includes("cache_control"), false, "anthropic: markers cleared");
    for (const format of ["chat_completions", "gemini", "codex_responses"]) assert.equal(JSON.stringify(JSON.parse(bodies[format] as string)).includes("cache_control"), true, `${format} body is passed through verbatim`);
  });

  it("a non-string body is passed through untouched even for anthropic_messages", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    let got: unknown;
    const f = providerFetch(never, "anthropic_messages", (async (_i: unknown, init?: RequestInit) => { got = init?.body; return okResponse(); }) as typeof fetch);
    await f("https://x.invalid/", { method: "POST", body: bytes });
    assert.equal(got, bytes);
  });

  it("a request without a body forwards no body key", async () => {
    let init: RequestInit | undefined;
    const f = providerFetch(never, "anthropic_messages", (async (_i: unknown, i?: RequestInit) => { init = i; return okResponse(); }) as typeof fetch);
    await f("https://x.invalid/", { method: "GET" });
    assert.equal("body" in init!, false);
  });

  // A non-JSON string body on an anthropic request is refused locally with the adapter's own error type, so router retry and
  // error mapping see a typed failure (and the budget knows nothing billable left the harness).
  it("an unparsable anthropic body is refused as a ProviderError (request_refused_locally) and nothing is sent", async () => {
    let called = false;
    const f = providerFetch(never, "anthropic_messages", (async () => { called = true; return okResponse(); }) as typeof fetch);
    await assert.rejects(() => f("https://x.invalid/", { method: "POST", body: "not json" }), (e) => e instanceof ProviderError && e.kind === "invalid_request" && e.code === "request_refused_locally" && !(e instanceof SyntaxError));
    assert.equal(called, false);
  });

  it("an anthropic body that parses to a non-object is refused the same way", async () => {
    let called = false;
    const f = providerFetch(never, "anthropic_messages", (async () => { called = true; return okResponse(); }) as typeof fetch);
    for (const body of ["null", "[]", "42"]) await assert.rejects(() => f("https://x.invalid/", { method: "POST", body }), (e) => e instanceof ProviderError && e.code === "request_refused_locally", body);
    assert.equal(called, false);
  });

  it("an already aborted signal throws before anything is sent", async () => {
    let called = false;
    const ac = new AbortController(); ac.abort(new Error("stop"));
    const f = providerFetch(never, "chat_completions", (async () => { called = true; return okResponse(); }) as typeof fetch);
    await assert.rejects(() => f("https://x.invalid/", { signal: ac.signal }), /stop/);
    assert.equal(called, false);
  });
});

describe("composition/http providerFetch over the pinned egress transport", () => {
  const servers: http.Server[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }); });
  async function serve(handler: http.RequestListener): Promise<number> {
    const server = http.createServer(handler); servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  }
  const allow = (calls: string[] = []) => ({ decide: async (url: string) => { calls.push(url); return { allowed: true as const, host: "pinned.invalid", port: 0, address: "127.0.0.1", family: 4 as const }; } });

  it("asks egress about the URL, then connects to the vetted address while keeping the original Host", async () => {
    let seenHost = "", seenBody = "", seenLength = "", seenMethod = "";
    const port = await serve((req, res) => {
      seenHost = req.headers.host ?? ""; seenMethod = req.method ?? ""; seenLength = String(req.headers["content-length"]);
      let b = ""; req.on("data", (c: Buffer) => { b += c.toString(); });
      req.on("end", () => { seenBody = b; res.writeHead(200, { "content-type": "text/plain", "x-reply": "yes" }); res.end("héllo"); });
    });
    const asked: string[] = [];
    const f = providerFetch(allow(asked), "chat_completions");
    const res = await f(`http://pinned.invalid:${port}/v1/chat?x=1`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"é":1}' });
    assert.deepEqual(asked, [`http://pinned.invalid:${port}/v1/chat?x=1`]);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-reply"), "yes");
    assert.equal(await res.text(), "héllo");
    assert.equal(seenHost, `pinned.invalid:${port}`, "the name the caller used stays in the request");
    assert.equal(seenMethod, "POST");
    assert.equal(seenBody, '{"é":1}');
    assert.equal(seenLength, String(Buffer.byteLength('{"é":1}')), "content-length counts bytes, not characters");
  });

  it("refuses a redirect instead of following it (credentials never travel to a second host)", async () => {
    let hits = 0;
    const port = await serve((req, res) => { hits++; res.writeHead(302, { location: "http://other.invalid/steal" }); res.end(); });
    const f = providerFetch(allow(), "chat_completions");
    await assert.rejects(() => f(`http://pinned.invalid:${port}/`, { headers: { authorization: "Bearer redact-probe-alpha" } }), (e) => e instanceof ProviderError && e.kind === "invalid_request" && /redirect/.test(e.message));
    assert.equal(hits, 1);
  });

  it("an egress denial is a typed egress_denied error and nothing is connected", async () => {
    let connected = false;
    const port = await serve(() => { connected = true; });
    const f = providerFetch({ decide: async () => ({ allowed: false as const, reason: "host-not-allowed", message: "no" }) } as never, "chat_completions");
    await assert.rejects(() => f(`http://pinned.invalid:${port}/`), (e) => e instanceof ProviderError && e.code === "egress_denied" && e.kind === "invalid_request");
    assert.equal(connected, false);
  });

  const refused: [string, string, RequestInit?][] = [
    ["credentials in the URL", "http://user:redact-probe-alpha@pinned.invalid:1/"],
    ["a username without password", "http://user@pinned.invalid:1/"],
    ["a non-http scheme", "ftp://pinned.invalid/"],
    ["a binary body", "http://pinned.invalid:1/", { method: "POST", body: new Uint8Array([1]) }],
    ["a stream-like body", "http://pinned.invalid:1/", { method: "POST", body: new URLSearchParams({ a: "b" }) }],
  ];
  for (const [name, url, init] of refused) it(`refuses locally: ${name}`, async () => {
    const f = providerFetch(allow(), "chat_completions");
    await assert.rejects(() => f(url, init), (e) => e instanceof ProviderError && e.code === "request_refused_locally");
  });

  it("a Request object is accepted as input", async () => {
    let path = "";
    const port = await serve((req, res) => { path = req.url ?? ""; res.end("ok"); });
    const f = providerFetch(allow(), "chat_completions");
    const res = await f(new Request(`http://pinned.invalid:${port}/r/path`));
    assert.equal(await res.text(), "ok");
    assert.equal(path, "/r/path");
  });

  it("a connection error rejects (no hang)", async () => {
    const port = await serve((_req, res) => res.end());
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    const f = providerFetch(allow(), "chat_completions");
    await assert.rejects(() => f(`http://pinned.invalid:${port}/`), (e) => (e as NodeJS.ErrnoException).code === "ECONNREFUSED");
  });
});
