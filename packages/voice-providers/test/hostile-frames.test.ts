// Hostile or malformed upstream frames must end a session with one `upstream_protocol` error event and a clean close.
// They must never throw out of the socket's data handler (which would be an uncaught exception in the daemon).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isVoiceProviderError, type VoiceProviderError } from "../src/errors.ts";
import { createElevenLabs } from "../src/providers/elevenlabs.ts";
import { createGeminiLive } from "../src/providers/gemini.ts";
import { createGrokVoice } from "../src/providers/grok.ts";
import { startRealtimeSession, type RealtimeCodec } from "../src/providers/realtime-base.ts";
import type { RealtimeEvent } from "../src/types.ts";
import type { WsLike } from "../src/ws.ts";
import { startFakeVendor, type FakeSocket } from "./helpers/fake-vendor.ts";
import { collect, getSecret, until } from "./helpers/common.ts";

const errorCodes = (evs: RealtimeEvent[]): string[] => evs.filter((e) => e.type === "error").map((e) => ((e as { error: VoiceProviderError }).error).code);

const geminiHostile: Array<[string, unknown]> = [
  ["parts as an object", { serverContent: { modelTurn: { parts: { inlineData: { data: "AAAA" } } } } }],
  ["parts as a string", { serverContent: { modelTurn: { parts: "abc" } } }],
  ["serverContent as a string", { serverContent: "x" }],
  ["serverContent as an array", { serverContent: [1] }],
  ["functionCalls as a string", { toolCall: { functionCalls: "x" } }],
  ["usageMetadata as an array", { usageMetadata: [1, 2] }],
  ["a JSON array instead of an object", [1, 2, 3]],
  ["a bare string instead of JSON", "this is not json"],
  ["truncated JSON", "{\"serverContent\":"],
];

for (const [name, frame] of geminiHostile) {
  test(`gemini: ${name} ends the session with upstream_protocol and a close frame, not a crash`, async () => {
    const v = await startFakeVendor({ ws: (s) => { (async () => { await s.waitFor(1); s.send({ setupComplete: {} }); s.send(frame as never); })(); } });
    try {
      const session = await createGeminiLive({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m" }).connect();
      const evs = await until(session.events[Symbol.asyncIterator](), (e) => e.type === "closed");
      assert.deepEqual(evs.map((e) => e.type), ["ready", "error", "closed"]);
      assert.deepEqual(errorCodes(evs), ["upstream_protocol"]);
      assert.equal(await v.sockets[0]!.waitClosed(), 1002);
      assert.throws(() => session.sendText("late"), (e) => isVoiceProviderError(e) && e.code === "closed");
    } finally { await v.close(); }
  });
}

const grokHostile: Array<[string, unknown]> = [
  ["a JSON array", [1]],
  ["a bare string", "nope"],
  ["a JSON number", "42"],
];
for (const [name, frame] of grokHostile) {
  test(`grok: ${name} ends the session with upstream_protocol`, async () => {
    const v = await startFakeVendor({ ws: (s) => { s.send({ type: "session.created" }); s.send(frame as never); } });
    try {
      const session = await createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m" }).connect();
      const evs = await until(session.events[Symbol.asyncIterator](), (e) => e.type === "closed");
      assert.deepEqual(errorCodes(evs), ["upstream_protocol"]);
      assert.equal(await v.sockets[0]!.waitClosed(), 1002);
    } finally { await v.close(); }
  });
}

test("grok: a well-formed frame with hostile field types is survived without ending the session", async () => {
  const v = await startFakeVendor({ ws: (s) => {
    s.send({ type: "session.created" });
    s.send({ type: "response.audio.delta", delta: 12345 });
    s.send({ type: "response.done", response: "not-an-object" });
    s.send({ type: "response.function_call_arguments.done", arguments: "{broken", call_id: 7, name: null });
    s.send({ type: "response.done", response: { usage: { input_tokens: "many", output_tokens: {} } } });
    s.close(1000);
  } });
  try {
    const session = await createGrokVoice({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m" }).connect();
    const evs = await until(session.events[Symbol.asyncIterator](), (e) => e.type === "closed");
    assert.deepEqual(errorCodes(evs), []);
    assert.ok(evs.some((e) => e.type === "turn.done"));
  } finally { await v.close(); }
});

test("elevenlabs TTS stream: a non-JSON frame fails the stream with upstream_protocol and closes the socket", async () => {
  const v = await startFakeVendor({ ws: (s: FakeSocket) => { (async () => { await s.waitFor(1); s.send("garbage, not json"); })(); } });
  try {
    const { tts } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "v" });
    async function* text() { yield "Hello "; }
    await assert.rejects(collect(tts.synthesizeStream(text())), (e) => isVoiceProviderError(e) && e.code === "upstream_protocol");
    assert.equal(await v.sockets[0]!.waitClosed(), 1002);
  } finally { await v.close(); }
});

test("elevenlabs TTS stream: a close with a protocol code maps to upstream_protocol, not network", async () => {
  const v = await startFakeVendor({ ws: (s: FakeSocket) => { (async () => { await s.waitFor(1); s.close(1007); })(); } });
  try {
    const { tts } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultVoice: "v" });
    async function* text() { yield "Hello "; }
    await assert.rejects(collect(tts.synthesizeStream(text())), (e) => isVoiceProviderError(e) && e.code === "upstream_protocol");
  } finally { await v.close(); }
});

for (const [name, frame] of [["a JSON array", [1]], ["a bare string", "x"]] as Array<[string, unknown]>) {
  test(`elevenlabs ASR session: ${name} yields one upstream_protocol error and a clean close`, async () => {
    const v = await startFakeVendor({ ws: (s) => { s.send({ message_type: "session_started" }); s.send(frame as never); } });
    try {
      const { asr } = createElevenLabs({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl });
      const session = await asr.openStream({ sampleRate: 16000 });
      const evs = await until(session.events[Symbol.asyncIterator](), (e) => e.type === "closed");
      assert.deepEqual(evs.map((e) => e.type), ["ready", "error", "closed"]);
      assert.equal((evs[1] as { error: VoiceProviderError }).error.code, "upstream_protocol");
      assert.equal(await v.sockets[0]!.waitClosed(), 1002);
    } finally { await v.close(); }
  });
}

test("realtime session shell: a codec that throws, and a send on a closing socket, end the session once; a throwing usage sink does not", async () => {
  const listeners: { message: Array<(e: { data: string }) => void>; close: Array<(e: { code: number; reason: string }) => void> } = { message: [], close: [] };
  const sent: string[] = [];
  const closedWith: number[] = [];
  const ws = {
    readyState: 1,
    send: (d: string) => { if (d === "BOOM") throw new Error("closed"); sent.push(d); },
    close: (code?: number) => { closedWith.push(code ?? 1000); for (const l of listeners.close) l({ code: code ?? 1000, reason: "" }); },
    addEventListener: (t: "message" | "close" | "error", l: never) => { if (t === "message") listeners.message.push(l); if (t === "close") listeners.close.push(l); },
  } as unknown as WsLike;
  let decodeThrows = false;
  const codec: RealtimeCodec = {
    init: () => ["init"],
    isReady: () => true,
    decode: (f) => {
      if (decodeThrows) throw new TypeError("shape");
      return f["usage"] ? [{ type: "usage", report: { provider: "p", operation: "realtime" } }] : [];
    },
    audio: () => "a", text: () => ["t"], interrupt: () => [], toolResult: () => [],
  };
  const session = startRealtimeSession({ provider: "p", ws, codec, report: () => { throw new Error("sink"); } });
  const it = session.events[Symbol.asyncIterator]();
  for (const l of listeners.message) l({ data: JSON.stringify({ usage: 1 }) });
  decodeThrows = true;
  for (const l of listeners.message) l({ data: JSON.stringify({ x: 1 }) });
  for (const l of listeners.message) l({ data: JSON.stringify({ x: 2 }) }); // ignored after the failure
  const evs = await until(it, (e) => e.type === "closed");
  assert.deepEqual(evs.map((e) => e.type), ["ready", "usage", "error", "closed"]);
  assert.equal((evs[2] as { error: VoiceProviderError }).error.code, "upstream_protocol");
  assert.deepEqual(closedWith, [1002]);
  assert.throws(() => session.sendAudio(new Uint8Array(2)), (e) => isVoiceProviderError(e) && e.code === "closed");
});
