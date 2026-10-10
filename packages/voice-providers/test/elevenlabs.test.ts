import { test } from "node:test";
import assert from "node:assert/strict";
import { createElevenLabs } from "../src/providers/elevenlabs.ts";
import { SENTINEL_KEY, json, sinePcm16, startFakeVendor, type FakeSocket } from "./helpers/fake-vendor.ts";
import { assertNoKey, collect, getSecret, noSleep, until, usageSink } from "./helpers/common.ts";
import { isVoiceProviderError } from "../src/errors.ts";

function ttsSocketServer(received: string[]): (s: FakeSocket) => void {
  return (s) => {
    let n = 0;
    (async () => {
      let seen = 0;
      for (;;) {
        await s.waitFor(seen + 1);
        if (s.closedWith !== undefined) return;
        const f = s.json(seen++);
        received.push(JSON.stringify(f));
        if (typeof f.text === "string" && f.text.trim() !== "" && !f.flush) s.send({ audio: Buffer.from(sinePcm16(240, 24000, 200 + 100 * n++)).toString("base64"), isFinal: false });
        if (f.text === "") { s.send({ audio: "", isFinal: true }); return; }
      }
    })();
  };
}

test("HTTP TTS sends the key in the header only, reports chars, honours zero retention and format", async () => {
  const pcm = sinePcm16(2400, 24000);
  const v = await startFakeVendor({ http: (req, res) => { res.writeHead(200, { "content-type": "audio/pcm" }); res.end(Buffer.from(pcm)); } });
  try {
    const { sink, reports } = usageSink();
    const { tts } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "voiceA", zeroRetention: true, usage: sink, sleep: noSleep });
    const r = await tts.synthesize("Hallo Welt", { voiceSettings: { stability: 0.4, speed: 1.1 } });
    assert.equal(r.format, "pcm16");
    assert.equal(r.sampleRate, 24000);
    assert.deepEqual([...r.data], [...pcm]);
    assert.deepEqual(r.usage, { provider: "elevenlabs", operation: "tts", model: "eleven_flash_v2_5", chars: 10 });
    assert.equal(reports.length, 1);
    const req = v.requests[0]!;
    assert.equal(req.headers["xi-api-key"], SENTINEL_KEY);
    assert.ok(req.url.startsWith("/v1/text-to-speech/voiceA?"));
    assert.match(req.url, /output_format=pcm_24000/);
    assert.match(req.url, /enable_logging=false/);
    assert.ok(!req.url.includes(SENTINEL_KEY));
    const body = JSON.parse(req.body.toString());
    assert.equal(body.text, "Hallo Welt");
    assert.deepEqual(body.voice_settings, { stability: 0.4, speed: 1.1 });
    assertNoKey({ r, reports }, "tts result");
  } finally { await v.close(); }
});

test("HTTP TTS refuses unsupported format and missing voice before any request", async () => {
  const v = await startFakeVendor({});
  try {
    const { tts } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl });
    await assert.rejects(tts.synthesize("x", { voice: "a", format: "mp3", sampleRate: 16000 }), (e) => isVoiceProviderError(e) && e.code === "unsupported");
    await assert.rejects(tts.synthesize("x"), (e) => isVoiceProviderError(e) && e.code === "invalid_request");
    assert.equal(v.requests.length, 0);
  } finally { await v.close(); }
});

test("text-input streaming over the socket: chunks in order, flush then end-of-input, audio chunks out in order", async () => {
  const received: string[] = [];
  const v = await startFakeVendor({ ws: ttsSocketServer(received) });
  try {
    const { sink, reports } = usageSink();
    const { tts } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "voiceA", zeroRetention: true, usage: sink });
    async function* text() { yield "Hello"; yield "world."; }
    const chunks = await collect(tts.synthesizeStream(text(), {}));
    assert.equal(chunks.length, 2);
    for (const c of chunks) { assert.equal(c.format, "pcm16"); assert.equal(c.sampleRate, 24000); assert.equal(c.data.byteLength, 480); }
    assert.notDeepEqual([...chunks[0]!.data], [...chunks[1]!.data]);
    const frames = received.map((r) => JSON.parse(r));
    assert.equal(frames[0].text, " ");
    assert.ok(frames[0].generation_config.chunk_length_schedule.length > 0);
    assert.deepEqual(frames.slice(1).map((f) => f.text), ["Hello ", "world. ", " ", ""]);
    assert.equal(frames[3].flush, true);
    const sock = v.sockets[0]!;
    assert.equal(sock.req.headers["xi-api-key"], SENTINEL_KEY);
    assert.match(sock.req.url ?? "", /\/v1\/text-to-speech\/voiceA\/stream-input\?/);
    assert.match(sock.req.url ?? "", /enable_logging=false/);
    assert.ok(!(sock.req.url ?? "").includes(SENTINEL_KEY));
    assert.deepEqual(reports, [{ provider: "elevenlabs", operation: "tts", model: "eleven_flash_v2_5", chars: 11 }]);
    assert.ok(!received.join("").includes(SENTINEL_KEY));
  } finally { await v.close(); }
});

test("aborting a socket stream mid-way throws aborted and closes the socket", async () => {
  const v = await startFakeVendor({ ws: (s) => { s.waitFor(2).then(() => s.send({ audio: Buffer.from(sinePcm16(100, 24000)).toString("base64") })); } });
  try {
    const { tts } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "voiceA" });
    const ctl = new AbortController();
    async function* text() { yield "one "; await new Promise(() => {}); }
    const it = tts.synthesizeStream(text(), { signal: ctl.signal })[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(first.done, false);
    ctl.abort();
    await assert.rejects(it.next(), (e) => isVoiceProviderError(e) && e.code === "aborted");
    assert.ok([1000, 1005].includes(await v.sockets[0]!.waitClosed()));
  } finally { await v.close(); }
});

test("a vendor error frame becomes a unified error and the key never shows", async () => {
  const v = await startFakeVendor({ ws: (s) => { s.waitFor(1).then(() => s.send({ error: "quota_exceeded", message: `bad key ${SENTINEL_KEY}` })); } });
  try {
    const { tts } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "voiceA" });
    async function* text() { yield "hi"; }
    await assert.rejects(collect(tts.synthesizeStream(text())), (e) => { assert.ok(isVoiceProviderError(e)); assert.equal(e.code, "rate_limited"); assertNoKey(e, "error"); return true; });
  } finally { await v.close(); }
});

test("string input uses the HTTP streaming endpoint and yields chunks as they arrive", async () => {
  const v = await startFakeVendor({ http: async (req, res) => { res.writeHead(200); for (let i = 0; i < 3; i++) { res.write(Buffer.from(sinePcm16(80, 24000, 300 + i * 50))); await new Promise((r) => setImmediate(r)); } res.end(); } });
  try {
    const { tts } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "voiceA" });
    const chunks = await collect(tts.synthesizeStream("Hello"));
    assert.ok(chunks.length >= 1);
    assert.equal(chunks.reduce((n, c) => n + c.data.byteLength, 0), 480);
    assert.match(v.requests[0]!.url, /\/stream\?/);
  } finally { await v.close(); }
});

test("rate limit: Retry-After is honoured through the injected sleep, then succeeds; errors carry retryAfterMs when retries run out", async () => {
  let calls = 0;
  const v = await startFakeVendor({ http: (req, res) => { calls++; if (calls <= 2) json(res, 429, { detail: "slow down" }, { "retry-after": "7" }); else { res.writeHead(200); res.end(Buffer.from(sinePcm16(10, 24000))); } } });
  try {
    const waits: number[] = [];
    const { tts } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "v", sleep: async (ms) => { waits.push(ms); } });
    const r = await tts.synthesize("x");
    assert.equal(r.data.byteLength, 20);
    assert.deepEqual(waits, [7000, 7000]);
    calls = -10;
    const { tts: strict } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "v", retries: 0 });
    await assert.rejects(strict.synthesize("x"), (e) => isVoiceProviderError(e) && e.code === "rate_limited" && e.retryAfterMs === 7000);
  } finally { await v.close(); }
});

test("auth errors are not retried and a missing secret fails before the network", async () => {
  let calls = 0;
  const v = await startFakeVendor({ http: (_req, res) => { calls++; json(res, 401, { detail: { status: "invalid_api_key" } }); } });
  try {
    const { tts } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "v", sleep: noSleep });
    await assert.rejects(tts.synthesize("x"), (e) => isVoiceProviderError(e) && e.code === "auth" && e.status === 401);
    assert.equal(calls, 1);
    const { tts: nokey } = createElevenLabs({ getSecret, apiKeyRef: "missing.ref", baseUrl: v.httpUrl, defaultVoice: "v" });
    await assert.rejects(nokey.synthesize("x"), (e) => isVoiceProviderError(e) && e.code === "auth");
    assert.equal(calls, 1);
    const { tts: noref } = createElevenLabs({ getSecret, apiKeyRef: undefined, baseUrl: v.httpUrl, defaultVoice: "v" });
    await assert.rejects(noref.synthesize("x"), (e) => isVoiceProviderError(e) && e.code === "auth");
  } finally { await v.close(); }
});

test("discovery maps voices (paged) and models, and splits tts from asr models", async () => {
  const v = await startFakeVendor({ http: (req, res) => {
    if (req.url.startsWith("/v2/voices")) {
      if (req.url.includes("next_page_token=p2")) json(res, 200, { voices: [{ voice_id: "v3", name: "Clara", labels: { gender: "female", language: "de" } }], has_more: false });
      else json(res, 200, { voices: [{ voice_id: "v1", name: "Adam", labels: { gender: "male" }, verified_languages: [{ language: "en" }, { language: "de" }], preview_url: "https://x/y.mp3" }, { name: "nameless" }], has_more: true, next_page_token: "p2" });
    } else if (req.url.startsWith("/v1/models")) json(res, 200, [{ model_id: "eleven_flash_v2_5", name: "Flash", can_do_text_to_speech: true, languages: [{ language_id: "en" }, { language_id: "de" }] }, { model_id: "scribe_v1", name: "Scribe", can_do_text_to_speech: false }]);
    else json(res, 404, {});
  } });
  try {
    const { tts, asr } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl });
    const voices = await tts.listVoices();
    assert.deepEqual(voices.map((x) => x.id), ["v1", "v3"]);
    assert.deepEqual(voices[0], { id: "v1", name: "Adam", languages: ["en", "de"], gender: "male", previewUrl: "https://x/y.mp3" });
    assert.deepEqual((await tts.listModels()).map((m) => m.id), ["eleven_flash_v2_5"]);
    assert.deepEqual((await asr.listModels()).map((m) => m.id), ["scribe_v1"]);
    assert.ok(v.requests.every((r) => r.headers["xi-api-key"] === SENTINEL_KEY));
  } finally { await v.close(); }
});

test("batch ASR uploads WAV with model, language and timestamps and maps words", async () => {
  const v = await startFakeVendor({ http: (req, res) => json(res, 200, { language_code: "de", text: "guten tag", words: [{ text: "guten", start: 0.1, end: 0.4, type: "word" }, { text: " ", type: "spacing", start: 0.4, end: 0.45 }, { text: "tag", start: 0.5, end: 0.9, type: "word" }] }) });
  try {
    const { sink, reports } = usageSink();
    const { asr } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, zeroRetention: true, usage: sink });
    const r = await asr.transcribe({ data: sinePcm16(16000), format: "pcm16", sampleRate: 16000 }, { language: "de", timestamps: true });
    assert.equal(r.text, "guten tag");
    assert.equal(r.language, "de");
    assert.deepEqual(r.words, [{ text: "guten", startMs: 100, endMs: 400 }, { text: "tag", startMs: 500, endMs: 900 }]);
    assert.equal(r.usage.seconds, 1);
    assert.equal(reports.length, 1);
    const req = v.requests[0]!;
    assert.match(req.url, /^\/v1\/speech-to-text\?/);
    assert.match(req.url, /enable_logging=false/);
    const body = req.body.toString("latin1");
    assert.match(body, /name="model_id"\r\n\r\nscribe_v2/);
    assert.match(body, /name="language_code"\r\n\r\nde/);
    assert.match(body, /name="timestamps_granularity"\r\n\r\nword/);
    assert.ok(body.includes("RIFF"));
    assert.equal(req.headers["xi-api-key"], SENTINEL_KEY);
    assertNoKey(r, "asr result");
  } finally { await v.close(); }
});

test("realtime ASR: partials then finals, audio buffered until session_started, commit sent", async () => {
  const v = await startFakeVendor({ ws: (s) => {
    (async () => {
      await new Promise((r) => setImmediate(r));
      s.send({ message_type: "session_started", session_id: "s1" });
      await s.waitFor(2);
      s.send({ message_type: "partial_transcript", text: "hall" });
      s.send({ message_type: "partial_transcript", text: "hallo wel" });
      await s.waitFor(3);
      s.send({ message_type: "committed_transcript", text: "hallo welt" });
    })();
  } });
  try {
    const { asr } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl });
    const session = await asr.openStream({ language: "de", sampleRate: 16000 });
    session.sendAudio(sinePcm16(160)); // before session_started: must be held
    session.sendAudio(sinePcm16(160));
    const it = session.events[Symbol.asyncIterator]();
    assert.deepEqual(await it.next(), { done: false, value: { type: "ready" } });
    session.commit();
    const evs = await until(it, (e) => e.type === "final");
    assert.deepEqual(evs.map((e) => e.type), ["partial", "partial", "final"]);
    assert.equal((evs[2] as { text: string }).text, "hallo welt");
    const sock = v.sockets[0]!;
    assert.match(sock.req.url ?? "", /audio_format=pcm_16000/);
    assert.match(sock.req.url ?? "", /language_code=de/);
    const frames = sock.jsonFrames();
    assert.equal(frames.length, 3);
    assert.equal(frames[0].message_type, "input_audio_chunk");
    assert.equal(frames[0].commit, false);
    assert.equal(frames[2].commit, true);
    assert.equal(Buffer.from(frames[0].audio_base_64, "base64").byteLength, 320);
    await session.close();
    assert.equal((await until(it, (e) => e.type === "closed")).at(-1)?.type, "closed");
  } finally { await v.close(); }
});

test("realtime ASR maps a handshake 401 to auth", async () => {
  const v = await startFakeVendor({ rejectUpgrade: () => 401 });
  try {
    const { asr } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl });
    await assert.rejects(asr.openStream(), (e) => { assert.ok(isVoiceProviderError(e)); assert.equal(e.code, "auth"); assertNoKey(e, "error"); return true; });
  } finally { await v.close(); }
});

test("output_format uses only variants the vendor documents (mp3 bitrate depends on the rate)", async () => {
  const { ELEVENLABS } = await import("../src/constants.ts");
  assert.equal(ELEVENLABS.outputFormat("mp3", 22050), "mp3_22050_32");
  assert.equal(ELEVENLABS.outputFormat("mp3", 24000), "mp3_24000_48");
  assert.equal(ELEVENLABS.outputFormat("mp3", 44100), "mp3_44100_128");
  assert.equal(ELEVENLABS.outputFormat("mp3", 16000), undefined);
});
