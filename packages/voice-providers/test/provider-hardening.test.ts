// F8 (Gemini key never in a URL), F12 (stable usage ids, no double counting), F17 (ElevenLabs logs the host only),
// F18 (Polly listModels survives being detached). Fixture keys are built at run time, never literal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isVoiceProviderError } from "../src/errors.ts";
import { createElevenLabs } from "../src/providers/elevenlabs.ts";
import { createGeminiLive } from "../src/providers/gemini.ts";
import { createGrokVoice } from "../src/providers/grok.ts";
import { createPolly, type PollyClientLike } from "../src/providers/polly.ts";
import type { Logger, RealtimeEvent } from "../src/types.ts";
import type { WsFactory, WsLike } from "../src/ws.ts";
import { SENTINEL_KEY, startFakeVendor } from "./helpers/fake-vendor.ts";
import { assertNoKey, getSecret, until, usageSink } from "./helpers/common.ts";

const GEMINI_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

function capturingFactory(): { factory: WsFactory; urls: string[]; headers: Array<Record<string, string> | undefined> } {
  const urls: string[] = [];
  const headers: Array<Record<string, string> | undefined> = [];
  const factory: WsFactory = async (url, init) => {
    urls.push(url);
    headers.push(init.headers);
    const ws: WsLike = { readyState: 1, send() {}, close() {}, addEventListener() {} };
    return ws;
  };
  return { factory, urls, headers };
}

test("gemini: the key goes in the x-goog-api-key header, never in the WebSocket URL; the query form is an explicit fallback", async () => {
  const cap = capturingFactory();
  await createGeminiLive({ getSecret, apiKeyRef: "voice.key", defaultModel: "m", wsFactory: cap.factory }).connect();
  assert.equal(cap.urls[0], `wss://generativelanguage.googleapis.com${GEMINI_PATH}`);
  assert.equal(cap.headers[0]!["x-goog-api-key"], SENTINEL_KEY);
  assertNoKey(cap.urls, "websocket url");

  const q = capturingFactory();
  await createGeminiLive({ getSecret, apiKeyRef: "voice.key", defaultModel: "m", wsFactory: q.factory, keyTransport: "query" }).connect();
  assert.ok(q.urls[0]!.includes(`?key=${encodeURIComponent(SENTINEL_KEY)}`));
  assert.equal(q.headers[0], undefined);
});

test("gemini: a failed handshake leaves the key out of the error and out of every log line, in both transports", async () => {
  for (const keyTransport of ["header", "query"] as const) {
    const v = await startFakeVendor({ rejectUpgrade: () => 403 });
    const lines: string[] = [];
    const logger: Logger = { debug: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`), warn: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`) };
    try {
      await assert.rejects(createGeminiLive({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m", keyTransport, logger }).connect(), (e) => { assert.ok(isVoiceProviderError(e)); assert.equal(e.code, "auth"); assertNoKey({ message: e.message, json: e.toJSON(), stack: e.stack }, "error"); return true; });
      assertNoKey(lines, "log lines");
    } finally { await v.close(); }
  }
});

function geminiUsageServer(frames: unknown[]) {
  return startFakeVendor({ ws: (s) => { (async () => { await s.waitFor(1); s.send({ setupComplete: {} }); for (const f of frames) s.send(f as never); s.close(1000); })(); } });
}

test("gemini usage: cumulative usageMetadata within a turn is reported once, with a stable eventId; each turn gets its own id", async () => {
  const v = await geminiUsageServer([
    { serverContent: { outputTranscription: { text: "a" } }, usageMetadata: { promptTokenCount: 10, responseTokenCount: 2 } },
    { serverContent: { outputTranscription: { text: "b" } }, usageMetadata: { promptTokenCount: 10, responseTokenCount: 5 } },
    { serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 10, responseTokenCount: 9 } },
    { serverContent: { outputTranscription: { text: "c" } } },
    { serverContent: { turnComplete: true } },
    { usageMetadata: { promptTokenCount: 30, responseTokenCount: 4 } }, // arrives after its turn completed
  ]);
  try {
    const { sink, reports } = usageSink();
    const session = await createGeminiLive({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m", usage: sink }).connect();
    const evs: RealtimeEvent[] = await until(session.events[Symbol.asyncIterator](), (e) => e.type === "closed");
    assert.equal(evs.filter((e) => e.type === "usage").length, 2);
    assert.deepEqual(reports.map((r) => [r.inputTokens, r.outputTokens]), [[10, 9], [30, 4]]);
    const ids = reports.map((r) => r.eventId);
    assert.match(ids[0]!, /^gemini:[0-9a-f]{12}:0$/);
    assert.match(ids[1]!, /^gemini:[0-9a-f]{12}:1$/);
    assert.equal(ids[0]!.split(":")[1], ids[1]!.split(":")[1], "one session id");
  } finally { await v.close(); }
});

test("gemini usage: two sessions never share an eventId", async () => {
  const frames = [{ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 1, responseTokenCount: 1 } }];
  const v = await geminiUsageServer(frames);
  try {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { sink, reports } = usageSink();
      const s = await createGeminiLive({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m", usage: sink }).connect();
      await until(s.events[Symbol.asyncIterator](), (e) => e.type === "closed");
      ids.push(reports[0]!.eventId!);
    }
    assert.notEqual(ids[0], ids[1]);
  } finally { await v.close(); }
});

test("grok usage: the response id becomes the eventId", async () => {
  const v = await startFakeVendor({ ws: (s) => { s.send({ type: "session.created" }); s.send({ type: "response.done", response: { id: "resp_42", usage: { input_tokens: 3, output_tokens: 4 } } }); s.close(1000); } });
  try {
    const { sink, reports } = usageSink();
    const s = await createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m", usage: sink }).connect();
    await until(s.events[Symbol.asyncIterator](), (e) => e.type === "closed");
    assert.equal(reports[0]!.eventId, "xai:resp_42");
  } finally { await v.close(); }
});

test("elevenlabs: the ready log line carries the host only, not userinfo, path or query of a baseUrl", () => {
  const lines: string[] = [];
  const logger: Logger = { debug: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`), warn: () => {} };
  const secretUser = ["user", "x9z"].join("");
  const secretPass = ["pa", "ss", "w0rd"].join("");
  createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: `https://${secretUser}:${secretPass}@relay.example.com:8443/private/path?token=abc`, logger });
  const text = lines.join("\n");
  assert.ok(text.includes("relay.example.com:8443"));
  for (const bad of [secretUser, secretPass, "private", "token"]) assert.ok(!text.includes(bad), `log line leaks ${bad}`);
});

test("polly: listModels and listVoices work when detached from the provider object", async () => {
  const client: PollyClientLike = {
    async synthesize() { return new Uint8Array(0); },
    async describeVoices() { return { Voices: [{ Id: "Vicki", SupportedEngines: ["neural", "standard"] }, { Id: "Joanna", SupportedEngines: ["neural"] }] }; },
  };
  const { listModels, listVoices } = createPolly({ clientFactory: async () => client });
  assert.deepEqual((await listModels()).map((m) => m.id), ["neural", "standard"]);
  assert.deepEqual((await listVoices()).map((v) => v.id), ["Vicki", "Joanna"]);
});
