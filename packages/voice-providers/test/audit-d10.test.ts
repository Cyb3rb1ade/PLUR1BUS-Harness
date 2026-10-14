// Audit round D (agent d10): each test here was red against the module before its fix.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { voiceEgressHosts } from "../src/egress.ts";
import { VoiceProviderError, isVoiceProviderError, redact } from "../src/errors.ts";
import { HttpClient } from "../src/http.ts";
import { createElevenLabs } from "../src/providers/elevenlabs.ts";
import { createGeminiLive } from "../src/providers/gemini.ts";
import { createGrokVoice } from "../src/providers/grok.ts";
import { createVoiceProviders, lookupProvider } from "../src/registry.ts";
import { toVoiceUsage, type RealtimeEvent } from "../src/types.ts";
import { AsyncQueue, assertSecureTransport, pcm16Seconds } from "../src/util.ts";
import { defaultWsFactory, type WsFactory, type WsLike, type WsTimers } from "../src/ws.ts";
import { collect, getSecret, noSleep, until, usageSink } from "./helpers/common.ts";
import { sinePcm16, startFakeVendor } from "./helpers/fake-vendor.ts";
import { startRawServer } from "./helpers/raw-ws-server.ts";

const codeOf = (evs: RealtimeEvent[]): string[] => evs.filter((e) => e.type === "error").map((e) => (e as unknown as { error: VoiceProviderError }).error.code);

function manualTimers(): { timers: WsTimers; fireAll(): void; pending(): number } {
  let seq = 0;
  const q = new Map<number, () => void>();
  return {
    timers: { setTimeout: (fn) => { const id = ++seq; q.set(id, fn); return id; }, clearTimeout: (h) => { q.delete(h as number); } },
    fireAll() { for (const [id, fn] of [...q.entries()]) { q.delete(id); fn(); } },
    pending: () => q.size,
  };
}

/** A socket stand-in that records what the session does to it. */
class StubWs implements WsLike {
  readyState = 1;
  sent: string[] = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  private readonly l: { message: Array<(e: never) => void>; close: Array<(e: never) => void>; error: Array<(e: never) => void> } = { message: [], close: [], error: [] };
  send(d: string | Uint8Array): void { this.sent.push(String(d)); }
  close(code?: number, reason?: string): void { this.closes.push({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) }); }
  addEventListener(type: "message" | "close" | "error", fn: (e: never) => void): void { this.l[type].push(fn); }
  emitClose(code = 1000): void { for (const f of this.l.close) f({ code, reason: "" } as never); }
  emitMessage(data: string): void { for (const f of this.l.message) f({ data } as never); }
}

// ---- registry: prototype names ----

test("registry/egress: a region named like an Object.prototype member falls back to the default host", async () => {
  for (const region of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const d = voiceEgressHosts({ providers: { elevenlabs: { enabled: true, region } } });
    assert.deepEqual(d.hosts.map((h) => h.host), ["api.elevenlabs.io"], region);
    const urls: string[] = [];
    const { tts } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", region, defaultVoice: "v", sleep: noSleep, retries: 0, fetch: async (url) => { urls.push(url); return new Response(new Uint8Array(4)); } });
    await tts.synthesize("x");
    assert.equal(new URL(urls[0]!).host, "api.elevenlabs.io", region);
  }
});

test("registry: lookupProvider returns only own entries, never Object.prototype members", () => {
  const reg = createVoiceProviders({ elevenlabs: { enabled: true, apiKeyRef: "voice.key" } }, { getSecret });
  assert.ok(lookupProvider(reg, "tts", "elevenlabs"));
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    for (const kind of ["asr", "tts", "realtime"] as const) assert.equal(lookupProvider(reg, kind, name), undefined, `${kind}/${name}`);
  }
});

// ---- ws: handshake deadline, send backpressure ----

test("ws: a peer that accepts the TCP connection but never answers the handshake ends in timeout", async () => {
  const held: Socket[] = [];
  const srv = createServer((s) => { held.push(s); s.on("error", () => {}); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const t = manualTimers();
  try {
    const p = defaultWsFactory(`ws://127.0.0.1:${port}/x`, { provider: "t", timers: t.timers });
    const outcome = p.then(() => "resolved", (e) => e);
    while (held.length === 0) await new Promise<void>((r) => setImmediate(r));
    assert.equal(t.pending(), 1, "the handshake deadline is armed");
    t.fireAll();
    const e = await outcome;
    assert.ok(isVoiceProviderError(e) && e.code === "timeout", String(e));
  } finally { for (const s of held) s.destroy(); await new Promise<void>((r) => srv.close(() => r())); }
});

test("ws: send() refuses with overloaded once the unsent backlog passes maxBufferedBytes (the peer does not read)", async () => {
  const server = await startRawServer();
  try {
    const ws = await defaultWsFactory(server.url, { provider: "t", limits: { maxBufferedBytes: 64 * 1024 } });
    const peer = await server.nextPeer();
    peer.socket.pause();
    const chunk = new Uint8Array(256 * 1024);
    let accepted = 0;
    let err: unknown;
    for (let i = 0; i < 400 && err === undefined; i++) {
      try { ws.send(chunk); accepted++; } catch (e) { err = e; }
    }
    assert.ok(isVoiceProviderError(err) && err.code === "overloaded", String(err));
    assert.ok(accepted < 400);
    ws.close();
  } finally { await server.close(); }
});

// ---- http: no deadline on a silent server ----

test("http: a fetch that never answers ends in timeout after headersTimeoutMs; the timer is cleared on success", async () => {
  const t = manualTimers();
  const hang: typeof fetch = (_u, init) => new Promise((_res, rej) => { (init?.signal as AbortSignal).addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); });
  const c = new HttpClient({ provider: "t", fetch: hang as never, retries: 0, headersTimeoutMs: 1000, timers: t.timers });
  const p = c.request("https://api.example.com/x").then(() => "ok", (e) => e);
  assert.equal(t.pending(), 1);
  t.fireAll();
  const e = await p;
  assert.ok(isVoiceProviderError(e) && e.code === "timeout", String(e));

  const t2 = manualTimers();
  const ok = new HttpClient({ provider: "t", fetch: (async () => new Response("{}")) as never, retries: 0, headersTimeoutMs: 1000, timers: t2.timers });
  await ok.request("https://api.example.com/x");
  assert.equal(t2.pending(), 0, "no timer is left behind");
});

test("http: the caller's abort is still reported as aborted, not as timeout", async () => {
  const t = manualTimers();
  const ctl = new AbortController();
  const hang: typeof fetch = (_u, init) => new Promise((_res, rej) => { (init?.signal as AbortSignal).addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); });
  const c = new HttpClient({ provider: "t", fetch: hang as never, retries: 0, headersTimeoutMs: 1000, timers: t.timers });
  const p = c.request("https://api.example.com/x", { signal: ctl.signal }).then(() => "ok", (e) => e);
  ctl.abort();
  const e = await p;
  assert.ok(isVoiceProviderError(e) && e.code === "aborted", String(e));
  assert.equal(t.pending(), 0);
});

// ---- audio: rate validation, usage numbers ----

test("elevenlabs ASR: an invalid sample rate is refused before any network call", async () => {
  let calls = 0;
  const { asr } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", sleep: noSleep, retries: 0, fetch: async () => { calls++; return new Response("{}"); }, wsFactory: async () => { calls++; return new StubWs(); } });
  for (const rate of [0, -16000, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 7, 4_000_000_000]) {
    await assert.rejects(asr.transcribe({ data: sinePcm16(100), format: "pcm16", sampleRate: rate }), (e) => isVoiceProviderError(e) && e.code === "invalid_request", `transcribe ${rate}`);
    await assert.rejects(asr.openStream({ sampleRate: rate }), (e) => isVoiceProviderError(e) && e.code === "invalid_request", `openStream ${rate}`);
  }
  assert.equal(calls, 0);
});

test("usage maths: invalid rates and negative or non-finite numbers never reach the budget as such", () => {
  for (const rate of [0, -1, Number.NaN]) assert.equal(pcm16Seconds(32000, rate), 0);
  assert.equal(pcm16Seconds(-10, 16000), 0);
  assert.equal(pcm16Seconds(32000, 16000), 1);
  const u = toVoiceUsage({ provider: "p", operation: "asr", seconds: -5, inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY }, -3);
  assert.deepEqual(u, { seconds: 0, costMicros: 0, inputTokens: 0, outputTokens: 0 });
});

test("grok: negative token counts in a usage frame are dropped, not reported", async () => {
  const v = await startFakeVendor({ ws: (s) => { s.send({ type: "session.created" }); s.send({ type: "response.done", response: { id: "r1", usage: { input_tokens: -5, output_tokens: 7 } } }); } });
  try {
    const session = await createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m" }).connect();
    const evs = await until(session.events[Symbol.asyncIterator](), (e) => e.type === "turn.done");
    const usage = evs.find((e) => e.type === "usage");
    assert.ok(usage && usage.type === "usage");
    assert.equal(usage.report.inputTokens, undefined);
    assert.equal(usage.report.outputTokens, 7);
    await session.close();
  } finally { await v.close(); }
});

test("gemini: an audio part whose mime type names rate 0 or an absurd rate ends the session as upstream_protocol", async () => {
  for (const rate of ["0", "999999999"]) {
    const v = await startFakeVendor({ ws: (s) => { (async () => { await s.waitFor(1); s.send({ setupComplete: {} }); s.send({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: `audio/pcm;rate=${rate}` } }] } } }); })(); } });
    try {
      const session = await createGeminiLive({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m" }).connect();
      const evs = await until(session.events[Symbol.asyncIterator](), (e) => e.type === "closed");
      assert.deepEqual(codeOf(evs), ["upstream_protocol"], rate);
      assert.ok(!evs.some((e) => e.type === "audio"));
    } finally { await v.close(); }
  }
});

test("gemini: negative or fractional token counts are not reported as tokens", async () => {
  const v = await startFakeVendor({ ws: (s) => { (async () => { await s.waitFor(1); s.send({ setupComplete: {} }); s.send({ usageMetadata: { promptTokenCount: -4, responseTokenCount: 9 }, serverContent: { turnComplete: true } }); })(); } });
  try {
    const session = await createGeminiLive({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m" }).connect();
    const evs = await until(session.events[Symbol.asyncIterator](), (e) => e.type === "usage");
    const usage = evs.find((e) => e.type === "usage");
    assert.ok(usage && usage.type === "usage");
    assert.equal(usage.report.inputTokens, undefined);
    assert.equal(usage.report.outputTokens, 9);
    await session.close();
  } finally { await v.close(); }
});

test("elevenlabs ASR: audio sent after close() is refused and not billed", async () => {
  const v = await startFakeVendor({ ws: (s) => { s.send({ message_type: "session_started" }); } });
  try {
    const { sink, reports } = usageSink();
    const { asr } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, usage: sink });
    const session = await asr.openStream({ sampleRate: 16000 });
    const it = session.events[Symbol.asyncIterator]();
    await until(it, (e) => e.type === "ready");
    session.sendAudio(sinePcm16(16000, 16000));
    await session.close();
    assert.throws(() => session.sendAudio(sinePcm16(160000, 16000)), (e) => isVoiceProviderError(e) && e.code === "closed");
    await until(it, (e) => e.type === "closed");
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.seconds, 1);
  } finally { await v.close(); }
});

// ---- security: credentials in URLs, secrets in messages ----

test("assertSecureTransport refuses a URL with userinfo and never echoes it", () => {
  for (const url of ["https://user:hunter2@api.example.com/x", "wss://user:hunter2@api.example.com/x", "http://user:hunter2@127.0.0.1:9/x", "https://:hunter2@api.example.com"]) {
    assert.throws(() => assertSecureTransport(url, "t"), (e) => isVoiceProviderError(e) && e.code === "config" && !e.message.includes("hunter2"), url);
  }
});

test("a baseUrl with userinfo is a config error before any request, and egress declaration refuses it too", async () => {
  let calls = 0;
  const { tts } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: "https://bob:hunter2@relay.example.com", defaultVoice: "v", sleep: noSleep, retries: 0, fetch: async () => { calls++; return new Response(new Uint8Array(2)); } });
  await assert.rejects(tts.synthesize("x"), (e) => isVoiceProviderError(e) && e.code === "config" && !e.message.includes("hunter2"));
  assert.equal(calls, 0);
  assert.throws(() => voiceEgressHosts({ providers: { xai: { enabled: true, baseUrl: "https://bob:hunter2@relay.example.com" } } }), (e) => !String((e as Error).message).includes("hunter2"));
  assert.throws(() => voiceEgressHosts({ providers: { xai: { enabled: true, baseUrl: "ftp://relay.example.com" } } }));
});

test("redact removes the percent-encoded form of a secret too", () => {
  const secret = "ab+cd/ef=gh&ij";
  const msg = `GET https://h.example/p?foo=${encodeURIComponent(secret)} failed`;
  const out = redact(msg, [secret]);
  assert.ok(!out.includes(encodeURIComponent(secret)), out);
  assert.ok(!out.includes(secret), out);
  assert.equal(new VoiceProviderError("network", msg, { secrets: [secret] }).message.includes(encodeURIComponent(secret)), false);
});

// ---- realtime: bounded buffers, abort, listeners ----

test("AsyncQueue with maxItems fails with overloaded instead of growing, and delivers what it already holds first", async () => {
  const q = new AsyncQueue<number>({ maxItems: 3 });
  assert.equal(q.push(1), true);
  q.push(2);
  q.push(3);
  assert.equal(q.push(4), false);
  assert.equal(q.closed, true);
  const got: number[] = [];
  await assert.rejects((async () => { for await (const x of q) got.push(x); })(), (e) => isVoiceProviderError(e) && e.code === "overloaded");
  assert.deepEqual(got, [1, 2, 3]);
});

test("realtime session: a consumer that never reads cannot make the event queue grow without bound", async () => {
  const v = await startFakeVendor({ ws: (s) => { s.send({ type: "session.created" }); for (let i = 0; i < 20_000; i++) s.send({ type: "response.audio.delta", delta: "AAAA" }); } });
  try {
    const session = await createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m" }).connect();
    await v.sockets[0]!.waitClosed();
    const evs: RealtimeEvent[] = [];
    await collect({ [Symbol.asyncIterator]: () => { const it = session.events[Symbol.asyncIterator](); return { next: async () => { try { return await it.next(); } catch (e) { evs.push({ type: "error", error: e as Error }); return { value: undefined as never, done: true }; } } }; } }, 50_000).then((all) => evs.unshift(...all));
    assert.ok(evs.length < 20_000, `queue held ${evs.length} events`);
    assert.ok(evs.some((e) => e.type === "error" && isVoiceProviderError(e.error) && e.error.code === "overloaded"));
  } finally { await v.close(); }
});

test("realtime session: audio queued before the session is ready is capped", async () => {
  const v = await startFakeVendor({ ws: () => {} });
  try {
    const session = await createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m" }).connect();
    const chunk = new Uint8Array(64 * 1024);
    let err: unknown;
    let accepted = 0;
    for (let i = 0; i < 2000 && err === undefined; i++) { try { session.sendAudio(chunk); accepted++; } catch (e) { err = e; } }
    assert.ok(isVoiceProviderError(err) && err.code === "overloaded", String(err));
    assert.ok(accepted < 2000);
    await session.close();
  } finally { await v.close(); }
});

test("elevenlabs ASR: audio queued before session_started is capped", async () => {
  const v = await startFakeVendor({ ws: () => {} });
  try {
    const { asr } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl });
    const session = await asr.openStream({ sampleRate: 16000 });
    const chunk = new Uint8Array(64 * 1024);
    let err: unknown;
    for (let i = 0; i < 2000 && err === undefined; i++) { try { session.sendAudio(chunk); } catch (e) { err = e; } }
    assert.ok(isVoiceProviderError(err) && err.code === "overloaded", String(err));
    await session.close();
  } finally { await v.close(); }
});

test("a signal that aborts while the socket is being opened still ends the session", async () => {
  const ctl = new AbortController();
  const ws = new StubWs();
  const factory: WsFactory = async () => { ctl.abort(); return ws; };
  const session = await createGrokVoice({ getSecret, apiKeyRef: "voice.key", defaultModel: "m", wsFactory: factory }).connect({ signal: ctl.signal });
  assert.ok(ws.closes.length > 0, "the socket is closed");
  const it = session.events[Symbol.asyncIterator]();
  const first = await it.next();
  assert.ok(!first.done && first.value.type === "error" && isVoiceProviderError(first.value.error) && first.value.error.code === "aborted");

  const ctl2 = new AbortController();
  const ws2 = new StubWs();
  const { asr } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", wsFactory: async () => { ctl2.abort(); return ws2; } });
  await asr.openStream({ signal: ctl2.signal });
  assert.ok(ws2.closes.length > 0, "asr socket is closed");
});

test("the abort listener is removed from a long-lived signal once the session has ended", async () => {
  const ctl = new AbortController();
  const ws = new StubWs();
  const session = await createGrokVoice({ getSecret, apiKeyRef: "voice.key", defaultModel: "m", wsFactory: async () => ws }).connect({ signal: ctl.signal });
  assert.equal(getEventListeners(ctl.signal, "abort").length, 1);
  ws.emitClose(1000);
  await collect(session.events);
  assert.equal(getEventListeners(ctl.signal, "abort").length, 0);

  const ctl2 = new AbortController();
  const ws2 = new StubWs();
  const { asr } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", wsFactory: async () => ws2 });
  const s2 = await asr.openStream({ signal: ctl2.signal });
  ws2.emitClose(1000);
  await collect(s2.events);
  assert.equal(getEventListeners(ctl2.signal, "abort").length, 0);
});

test("grok: an assistant transcript that never ends is cut off at a size limit with upstream_protocol", async () => {
  const delta = "x".repeat(100_000);
  const v = await startFakeVendor({ ws: (s) => { s.send({ type: "session.created" }); for (let i = 0; i < 30; i++) s.send({ type: "response.audio_transcript.delta", delta }); } });
  try {
    const session = await createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m" }).connect();
    const evs = await until(session.events[Symbol.asyncIterator](), (e) => e.type === "closed", 100);
    assert.deepEqual(codeOf(evs), ["upstream_protocol"]);
  } finally { await v.close(); }
});
