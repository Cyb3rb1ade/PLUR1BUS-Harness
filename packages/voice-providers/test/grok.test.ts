import { test } from "node:test";
import assert from "node:assert/strict";
import { createGrokVoice } from "../src/providers/grok.ts";
import { SENTINEL_KEY, json, sinePcm16, startFakeVendor } from "./helpers/fake-vendor.ts";
import { assertNoKey, getSecret, until, usageSink } from "./helpers/common.ts";
import { isVoiceProviderError } from "../src/errors.ts";
import type { RealtimeEvent } from "../src/types.ts";

test("session up: handshake carries the key, setup frame configures voice/tools, events map to the unified set", async () => {
  const b64 = Buffer.from(sinePcm16(480, 24000)).toString("base64");
  const v = await startFakeVendor({ ws: (s) => {
    (async () => {
      s.send({ type: "session.created" });
      await s.waitFor(3); // setup, one audio frame, one tool result + response.create
      s.send({ type: "input_audio_buffer.speech_started" });
      s.send({ type: "conversation.item.input_audio_transcription.completed", transcript: "wie spät ist es" });
      s.send({ type: "response.function_call_arguments.done", call_id: "c1", name: "clock", arguments: "{\"tz\":\"CET\"}" });
      s.send({ type: "response.output_audio.delta", delta: b64 });
      s.send({ type: "response.output_audio_transcript.delta", delta: "Es ist " });
      s.send({ type: "response.output_audio_transcript.delta", delta: "acht." });
      s.send({ type: "response.output_audio_transcript.done", transcript: "Es ist acht." });
      s.send({ type: "response.done", response: { usage: { input_tokens: 12, output_tokens: 30 } } });
      s.close(1000);
    })();
  } });
  try {
    const { sink, reports } = usageSink();
    const p = createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "grok-voice-x", defaultVoice: "ara", usage: sink });
    const session = await p.connect({ instructions: "Sei kurz.", tools: [{ name: "clock", description: "time", parameters: { type: "object", properties: { tz: { type: "string" } } } }] });
    const it = session.events[Symbol.asyncIterator]();
    session.sendAudio(sinePcm16(160)); // held until ready, flushed after
    session.submitToolResult("c0", { ok: true });
    const evs: RealtimeEvent[] = await until(it, (e) => e.type === "closed");
    assert.deepEqual(evs.map((e) => e.type), ["ready", "interrupted", "transcript", "tool.call", "audio", "transcript", "transcript", "transcript", "usage", "turn.done", "closed"]);
    const audio = evs.find((e) => e.type === "audio") as Extract<RealtimeEvent, { type: "audio" }>;
    assert.equal(audio.chunk.sampleRate, 24000);
    assert.equal(audio.chunk.data.byteLength, 960);
    const call = evs.find((e) => e.type === "tool.call") as Extract<RealtimeEvent, { type: "tool.call" }>;
    assert.deepEqual([call.callId, call.name, call.arguments], ["c1", "clock", { tz: "CET" }]);
    const finals = evs.filter((e) => e.type === "transcript" && e.final).map((e) => (e as { role: string; text: string }).role + ":" + (e as { text: string }).text);
    assert.deepEqual(finals, ["user:wie spät ist es", "assistant:Es ist acht."]);
    assert.deepEqual(reports, [{ provider: "xai", operation: "realtime", model: "grok-voice-x", inputTokens: 12, outputTokens: 30 }]);

    const sock = v.sockets[0]!;
    assert.equal(sock.req.headers["authorization"], `Bearer ${SENTINEL_KEY}`);
    assert.match(sock.req.url ?? "", /^\/v1\/realtime\?model=grok-voice-x$/);
    const frames = sock.jsonFrames();
    assert.equal(frames[0].type, "session.update");
    assert.equal(frames[0].session.instructions, "Sei kurz.");
    assert.equal(frames[0].session.voice, "ara");
    assert.equal(frames[0].session.tools[0].name, "clock");
    assert.equal(frames[1].type, "input_audio_buffer.append");
    assert.equal(frames[2].item.type, "function_call_output");
    assertNoKey(evs, "events");
  } finally { await v.close(); }
});

test("model discovery fills in when nothing is configured; none found is a clear error", async () => {
  const v = await startFakeVendor({ http: (req, res) => json(res, 200, { data: [{ id: "grok-4" }, { id: "grok-voice-fast" }] }), ws: (s) => s.send({ type: "session.created" }) });
  try {
    const p = createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl });
    assert.deepEqual(await p.listModels(), [{ id: "grok-4", name: "grok-4", capabilities: [] }, { id: "grok-voice-fast", name: "grok-voice-fast", capabilities: ["realtime"] }]);
    const session = await p.connect();
    assert.match(v.sockets[0]!.req.url ?? "", /model=grok-voice-fast/);
    await session.close();
    assert.equal(v.requests[0]!.headers["authorization"], `Bearer ${SENTINEL_KEY}`);
  } finally { await v.close(); }
  const v2 = await startFakeVendor({ http: (_r, res) => json(res, 200, { data: [{ id: "grok-4" }] }) });
  try {
    const p = createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: v2.httpUrl });
    await assert.rejects(p.connect(), (e) => isVoiceProviderError(e) && e.code === "invalid_request");
  } finally { await v2.close(); }
});

test("errors: handshake 401 -> auth, 429 -> rate_limited with Retry-After; error frame -> unified; abnormal close -> error event", async () => {
  const deny = await startFakeVendor({ rejectUpgrade: () => 401 });
  const slow = await startFakeVendor({ rejectUpgrade: () => 429 });
  const frame = await startFakeVendor({ ws: (s) => { s.send({ type: "session.created" }); s.send({ type: "error", error: { type: "invalid_request_error", code: "bad", message: `nope ${SENTINEL_KEY}` } }); s.close(1011); } });
  try {
    await assert.rejects(createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: deny.httpUrl, defaultModel: "m" }).connect(), (e) => { assert.ok(isVoiceProviderError(e)); assert.equal(e.code, "auth"); assertNoKey(e, "err"); return true; });
    await assert.rejects(createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: slow.httpUrl, defaultModel: "m" }).connect(), (e) => isVoiceProviderError(e) && e.code === "rate_limited");
    const s = await createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: frame.httpUrl, defaultModel: "m" }).connect();
    const evs = await until(s.events[Symbol.asyncIterator](), (e) => e.type === "closed");
    const errors = evs.filter((e) => e.type === "error").map((e) => (e as unknown as { error: { code: string } }).error.code);
    assert.deepEqual(errors, ["invalid_request", "network"]);
    assertNoKey(evs, "events");
    assert.throws(() => s.sendText("late"), (e) => isVoiceProviderError(e) && e.code === "closed");
  } finally { await deny.close(); await slow.close(); await frame.close(); }
});

test("interrupt sends response.cancel; abort closes the session with an aborted error event", async () => {
  const v = await startFakeVendor({ ws: (s) => s.send({ type: "session.updated" }) });
  try {
    const ctl = new AbortController();
    const session = await createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m" }).connect({ signal: ctl.signal });
    const it = session.events[Symbol.asyncIterator]();
    assert.equal((await it.next()).value.type, "ready");
    session.interrupt();
    session.sendText("hallo");
    await v.sockets[0]!.waitFor(4);
    assert.deepEqual(v.sockets[0]!.jsonFrames().map((f) => f.type), ["session.update", "response.cancel", "conversation.item.create", "response.create"]);
    ctl.abort();
    const evs = await until(it, (e) => e.type === "closed");
    assert.equal((evs[0] as unknown as { error: { code: string } }).error.code, "aborted");
  } finally { await v.close(); }
});
