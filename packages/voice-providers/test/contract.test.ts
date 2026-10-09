// One contract, every provider: the same assertions run against ElevenLabs, Grok Voice, Gemini Live, Polly and the
// local fallback, each over its own fake server or fake engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICE_ERROR_CODES, VoiceProviderError, isVoiceProviderError } from "../src/errors.ts";
import type { AsrProvider, RealtimeProvider, TtsProvider, UsageReport } from "../src/types.ts";
import { createElevenLabs } from "../src/providers/elevenlabs.ts";
import { createGrokVoice } from "../src/providers/grok.ts";
import { createGeminiLive } from "../src/providers/gemini.ts";
import { createPolly } from "../src/providers/polly.ts";
import { LocalVoice } from "../src/local/voice.ts";
import { SENTINEL_KEY, json, sinePcm16, startFakeVendor } from "./helpers/fake-vendor.ts";
import { assertNoKey, collect, getSecret, until } from "./helpers/common.ts";
import { FakeEngine, testCatalogOverride, testFiles } from "./helpers/fake-engine.ts";

interface Case<T> { name: string; make(usage: (r: UsageReport) => void): Promise<{ provider: T; cleanup(): Promise<void> }> }

const ttsCases: Case<TtsProvider>[] = [
  { name: "elevenlabs", async make(usage) {
    const v = await startFakeVendor({
      http: (req, res) => {
        if (req.url.startsWith("/v2/voices")) json(res, 200, { voices: [{ voice_id: "v1", name: "A" }] });
        else if (req.url.startsWith("/v1/models")) json(res, 200, [{ model_id: "m1", name: "M", can_do_text_to_speech: true }]);
        else { res.writeHead(200); res.end(Buffer.from(sinePcm16(240, 24000))); }
      },
      ws: (s) => { (async () => { for (let i = 0; ; i++) { await s.waitFor(i + 1); if (s.closedWith !== undefined) return; const f = s.json(i); if (f.text === "") { s.send({ audio: "", isFinal: true }); return; } if (f.text.trim() && !f.flush) s.send({ audio: Buffer.from(sinePcm16(120, 24000)).toString("base64") }); } })(); },
    });
    return { provider: createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "v1", usage }).tts, cleanup: () => v.close() };
  } },
  { name: "polly", async make(usage) {
    return { provider: createPolly({ defaultVoice: "Vicki", usage, clientFactory: async () => ({
      async synthesize(input) { return (async function* () { yield sinePcm16(100 * input.Text.length, 16000); })(); },
      async describeVoices() { return { Voices: [{ Id: "Vicki", Name: "Vicki", SupportedEngines: ["neural"] }] }; },
    }) }), cleanup: async () => {} };
  } },
  { name: "local", async make(usage) {
    const files = testFiles();
    const v = await startFakeVendor({ http: (req, res) => { const d = files[req.url.slice(1)]!; res.writeHead(200, { "content-length": d.length }); res.end(Buffer.from(d)); } });
    const dir = await mkdtemp(join(tmpdir(), "voice-contract-"));
    const voice = new LocalVoice({ config: { catalogOverride: testCatalogOverride(v.httpUrl, files) }, modelsDir: dir, engine: new FakeEngine(), usage });
    await voice.setLanguage("de", { download: true });
    return { provider: voice.tts, cleanup: async () => { await v.close(); await rm(dir, { recursive: true, force: true }); } };
  } },
];

for (const c of ttsCases) {
  test(`contract tts / ${c.name}: batch, streaming, usage, discovery, abort, error codes, no key`, async () => {
    const reports: UsageReport[] = [];
    const { provider, cleanup } = await c.make((r) => reports.push(r));
    try {
      assert.equal(provider.kind, "tts");
      assert.equal(typeof provider.id, "string");
      assert.equal(typeof provider.textInputStreaming, "boolean");
      assert.ok(provider.formats.includes("pcm16"));
      const one = await provider.synthesize("Hallo", {});
      assert.ok(one.data.byteLength > 0 && one.data.byteLength % 2 === 0);
      assert.equal(one.format, "pcm16");
      assert.ok(one.sampleRate > 0);
      assert.equal(one.usage.operation, "tts");
      assert.equal(one.usage.provider, provider.id);
      assert.equal(one.usage.chars, 5);
      assert.ok(reports.length >= 1 && reports.every((r) => r.operation === "tts"));

      async function* text() { yield "Erster Satz. "; yield "Zweiter Satz."; }
      const chunks = await collect(provider.synthesizeStream(text(), {}));
      assert.ok(chunks.length >= 1);
      assert.ok(chunks.every((x) => x.data.byteLength > 0 && x.format === "pcm16" && x.sampleRate > 0));

      for (const v of await provider.listVoices()) assert.ok(typeof v.id === "string" && typeof v.name === "string");
      for (const m of await provider.listModels()) assert.ok(typeof m.id === "string" && Array.isArray(m.capabilities));

      await assert.rejects(provider.synthesize("x", { signal: AbortSignal.abort() }), (e) => isVoiceProviderError(e) && e.code === "aborted");
      await assert.rejects(provider.synthesize("x", { format: "opus", sampleRate: 12345 }), (e) => isVoiceProviderError(e) && VOICE_ERROR_CODES.includes(e.code));
      assertNoKey({ one, chunks, reports }, `${c.name} results`);
    } finally { await cleanup(); }
  });
}

const asrCases: Case<AsrProvider>[] = [
  { name: "elevenlabs", async make(usage) {
    const v = await startFakeVendor({ http: (req, res) => (req.url.startsWith("/v1/models") ? json(res, 200, [{ model_id: "scribe_v1", name: "Scribe" }]) : json(res, 200, { text: "hallo", language_code: "de" })), ws: (s) => { s.send({ message_type: "session_started" }); } });
    return { provider: createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, usage }).asr, cleanup: () => v.close() };
  } },
  { name: "local", async make(usage) {
    const files = testFiles();
    const v = await startFakeVendor({ http: (req, res) => { const d = files[req.url.slice(1)]!; res.writeHead(200, { "content-length": d.length }); res.end(Buffer.from(d)); } });
    const dir = await mkdtemp(join(tmpdir(), "voice-contract-"));
    const voice = new LocalVoice({ config: { catalogOverride: testCatalogOverride(v.httpUrl, files) }, modelsDir: dir, engine: new FakeEngine(), usage });
    await voice.setLanguage("de", { download: true });
    return { provider: voice.asr, cleanup: async () => { await v.close(); await rm(dir, { recursive: true, force: true }); } };
  } },
];

for (const c of asrCases) {
  test(`contract asr / ${c.name}: batch transcript with usage, streaming session lifecycle, discovery, abort`, async () => {
    const reports: UsageReport[] = [];
    const { provider, cleanup } = await c.make((r) => reports.push(r));
    try {
      assert.equal(provider.kind, "asr");
      const audio = { data: sinePcm16(16000), format: "pcm16" as const, sampleRate: 16000 };
      const r = await provider.transcribe(audio, {});
      assert.equal(typeof r.text, "string");
      assert.equal(r.usage.operation, "asr");
      assert.equal(r.usage.seconds, 1);
      assert.ok(reports.length >= 1);
      const s = await provider.openStream({ sampleRate: 16000 });
      const it = s.events[Symbol.asyncIterator]();
      assert.equal((await it.next()).value.type, "ready");
      s.sendAudio(sinePcm16(160));
      await s.close();
      await s.close(); // idempotent
      const tail = await until(it, (e) => e.type === "closed");
      assert.equal(tail.at(-1)?.type, "closed");
      assert.throws(() => s.sendAudio(sinePcm16(10)), (e) => isVoiceProviderError(e) && e.code === "closed");
      for (const m of await provider.listModels()) assert.ok(typeof m.id === "string");
      await assert.rejects(provider.transcribe(audio, { signal: AbortSignal.abort() }), (e) => isVoiceProviderError(e) && e.code === "aborted");
      assertNoKey({ r, reports }, `${c.name} results`);
    } finally { await cleanup(); }
  });
}

const realtimeCases: Case<RealtimeProvider>[] = [
  { name: "grok", async make(usage) {
    const v = await startFakeVendor({ http: (_r, res) => json(res, 200, { data: [{ id: "grok-voice-x" }] }), ws: (s) => s.send({ type: "session.created" }) });
    return { provider: createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "grok-voice-x", usage }), cleanup: () => v.close() };
  } },
  { name: "gemini", async make(usage) {
    const v = await startFakeVendor({ http: (_r, res) => json(res, 200, { models: [{ name: "models/g-live", supportedGenerationMethods: ["bidiGenerateContent"] }] }), ws: (s) => { s.waitFor(1).then(() => s.send({ setupComplete: {} })); } });
    return { provider: createGeminiLive({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "models/g-live", usage }), cleanup: () => v.close() };
  } },
];

for (const c of realtimeCases) {
  test(`contract realtime / ${c.name}: session up/down, input accepted after ready, idempotent close, abort, discovery, no key`, async () => {
    const { provider, cleanup } = await c.make(() => {});
    try {
      assert.equal(provider.kind, "realtime");
      assert.equal(typeof provider.toolCalls, "boolean");
      const s = await provider.connect({ instructions: "x" });
      const it = s.events[Symbol.asyncIterator]();
      const first = await it.next();
      assert.equal(first.value.type, "ready");
      s.sendAudio(sinePcm16(160));
      s.sendText("hi");
      s.interrupt();
      await s.close();
      await s.close();
      const tail = await until(it, (e) => e.type === "closed");
      assert.equal(tail.at(-1)?.type, "closed");
      assert.deepEqual([...VOICE_ERROR_CODES].filter((x) => tail.some((e) => e.type === "error" && (e.error as VoiceProviderError).code === x)), [], "a clean close raises no error event");
      assert.throws(() => s.sendText("late"), (e) => isVoiceProviderError(e) && e.code === "closed");
      await assert.rejects(provider.connect({ signal: AbortSignal.abort() }), (e) => isVoiceProviderError(e) && e.code === "aborted");
      for (const m of await provider.listModels()) assert.ok(typeof m.id === "string" && Array.isArray(m.capabilities));
      assertNoKey([first, tail], `${c.name} events`);
    } finally { await cleanup(); }
  });
}

test("contract: every provider constructor rejects with `auth` before the network when its secret reference is unresolvable", async () => {
  const v = await startFakeVendor({});
  try {
    const bad = async () => undefined;
    const el = createElevenLabs({ getSecret: bad, apiKeyRef: "nope", baseUrl: v.httpUrl, defaultVoice: "v" });
    const gk = createGrokVoice({ getSecret: bad, apiKeyRef: "nope", baseUrl: v.httpUrl, defaultModel: "m" });
    const gm = createGeminiLive({ getSecret: bad, apiKeyRef: "nope", baseUrl: v.httpUrl, defaultModel: "m" });
    for (const p of [() => el.tts.synthesize("x"), () => el.asr.openStream(), () => gk.connect(), () => gm.connect(), () => el.tts.listVoices(), () => gk.listModels(), () => gm.listModels()]) {
      await assert.rejects(p(), (e) => isVoiceProviderError(e) && e.code === "auth");
    }
    assert.equal(v.requests.length, 0);
    assert.equal(v.sockets.length, 0);
  } finally { await v.close(); }
  assert.ok(SENTINEL_KEY.length > 10);
});
