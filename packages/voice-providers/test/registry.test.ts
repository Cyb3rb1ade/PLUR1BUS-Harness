import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceProviders, discover, CLOUD_PROVIDER_IDS } from "../src/registry.ts";
import { SENTINEL_KEY, json, sinePcm16, startFakeVendor } from "./helpers/fake-vendor.ts";
import { assertNoKey, collect, getSecret, noSleep } from "./helpers/common.ts";
import type { Logger } from "../src/types.ts";

test("cloud is off by default and until a key reference is set", () => {
  const none = createVoiceProviders(undefined, { getSecret });
  assert.deepEqual(none.status.map((s) => s.state), ["disabled", "disabled", "disabled", "disabled"]);
  assert.deepEqual(none.status.map((s) => s.id), [...CLOUD_PROVIDER_IDS]);
  assert.deepEqual([none.asr, none.tts, none.realtime], [{}, {}, {}]);

  const enabledNoKey = createVoiceProviders({ elevenlabs: { enabled: true }, xai: { enabled: true }, gemini: { enabled: true } }, { getSecret });
  assert.deepEqual(enabledNoKey.status.map((s) => s.state), ["missing_key", "missing_key", "missing_key", "disabled"]);
  assert.deepEqual(Object.keys(enabledNoKey.tts), []);

  const keyButDisabled = createVoiceProviders({ elevenlabs: { enabled: false, apiKeyRef: "voice.key" } }, { getSecret });
  assert.equal(keyButDisabled.status[0]!.state, "disabled");
  assert.deepEqual(Object.keys(keyButDisabled.tts), []);
});

test("enabled providers with a key reference are registered with their capabilities; Polly needs no key reference", () => {
  const reg = createVoiceProviders({ elevenlabs: { enabled: true, apiKeyRef: "voice.key" }, xai: { enabled: true, apiKeyRef: "voice.key" }, gemini: { enabled: true, apiKeyRef: "voice.key" }, polly: { enabled: true, region: "eu-central-1", credentials: { profile: "work" } } }, { getSecret });
  assert.deepEqual(reg.status.map((s) => [s.id, s.state, s.capabilities.join("+")]), [["elevenlabs", "ready", "asr+tts"], ["xai", "ready", "realtime"], ["gemini", "ready", "realtime"], ["polly", "ready", "tts"]]);
  assert.deepEqual(Object.keys(reg.tts).sort(), ["elevenlabs", "polly"]);
  assert.deepEqual(Object.keys(reg.asr), ["elevenlabs"]);
  assert.deepEqual(Object.keys(reg.realtime).sort(), ["gemini", "xai"]);
});

test("config reaches the providers: baseUrl, default voice/model and zero retention", async () => {
  const v = await startFakeVendor({ http: (req, res) => { res.writeHead(200); res.end(Buffer.from(sinePcm16(10, 24000))); } });
  try {
    const reg = createVoiceProviders({ elevenlabs: { enabled: true, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "cfgVoice", defaultModel: "cfgModel", zeroRetention: true } }, { getSecret, sleep: noSleep });
    await reg.tts.elevenlabs!.synthesize("x");
    const req = v.requests[0]!;
    assert.ok(req.url.startsWith("/v1/text-to-speech/cfgVoice?"));
    assert.equal(JSON.parse(req.body.toString()).model_id, "cfgModel");
    assert.match(req.url, /enable_logging=false/);
  } finally { await v.close(); }
});

test("discover aggregates models and voices from every provider; a failing provider yields only its error code", async () => {
  const good = await startFakeVendor({ http: (req, res) => {
    if (req.url.startsWith("/v2/voices")) json(res, 200, { voices: [{ voice_id: "v1", name: "Adam" }] });
    else if (req.url.startsWith("/v1/models")) json(res, 200, [{ model_id: "tts1", name: "T", can_do_text_to_speech: true }, { model_id: "scribe_v1", name: "S" }]);
    else json(res, 404, {});
  } });
  const bad = await startFakeVendor({ http: (_r, res) => json(res, 401, { detail: `key ${SENTINEL_KEY} rejected` }) });
  try {
    const reg = createVoiceProviders({ elevenlabs: { enabled: true, apiKeyRef: "voice.key", baseUrl: good.httpUrl }, xai: { enabled: true, apiKeyRef: "voice.key", baseUrl: bad.httpUrl }, polly: { enabled: true } }, {
      getSecret, sleep: noSleep,
      pollyClientFactory: async () => ({ async synthesize() { return new Uint8Array(); }, async describeVoices() { return { Voices: [{ Id: "Vicki", Name: "Vicki", SupportedEngines: ["neural"] }] }; } }),
    });
    const d = await discover(reg);
    assert.deepEqual(d.models.map((m) => `${m.provider}/${m.kind}/${m.id}`).sort(), ["elevenlabs/asr/scribe_v1", "elevenlabs/tts/tts1", "polly/tts/neural"]);
    assert.deepEqual(d.voices.map((v) => `${v.provider}/${v.id}`).sort(), ["elevenlabs/v1", "polly/Vicki"]);
    assert.deepEqual(d.errors, [{ provider: "xai", kind: "realtime", code: "auth" }]);
    assertNoKey(d, "discovery result");
  } finally { await good.close(); await bad.close(); }
});

test("logging: a capture logger sees no provider key across successful and failing calls", async () => {
  const lines: string[] = [];
  const logger: Logger = { debug: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`), warn: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`) };
  const v = await startFakeVendor({ http: (req, res) => { if (req.url.includes("fail")) json(res, 401, {}); else { res.writeHead(200); res.end(Buffer.from(sinePcm16(10, 24000))); } } });
  try {
    const reg = createVoiceProviders({ elevenlabs: { enabled: true, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "v" } }, { getSecret, logger, sleep: noSleep });
    await reg.tts.elevenlabs!.synthesize("ok");
    await assert.rejects(reg.tts.elevenlabs!.synthesize("x", { voice: "fail" }));
    await collect(reg.tts.elevenlabs!.synthesizeStream("hello"));
    assert.ok(lines.length > 0);
    assertNoKey(lines, "log lines");
  } finally { await v.close(); }
});
