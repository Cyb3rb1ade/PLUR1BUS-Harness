import { test } from "node:test";
import assert from "node:assert/strict";
import { createGeminiLive } from "../src/providers/gemini.ts";
import { SENTINEL_KEY, json, sinePcm16, startFakeVendor } from "./helpers/fake-vendor.ts";
import { assertNoKey, getSecret, until, usageSink } from "./helpers/common.ts";
import { isVoiceProviderError } from "../src/errors.ts";
import type { RealtimeEvent } from "../src/types.ts";

const WS_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

test("live session: setup message, ready on setupComplete, audio/transcripts/tool calls/usage map to unified events", async () => {
  const b64 = Buffer.from(sinePcm16(480, 24000)).toString("base64");
  const v = await startFakeVendor({ ws: (s) => {
    (async () => {
      await s.waitFor(1);
      s.send({ setupComplete: {} });
      await s.waitFor(3); // setup, audio, tool response
      s.send({ serverContent: { inputTranscription: { text: "wetter " } } });
      s.send({ serverContent: { inputTranscription: { text: "morgen" } } });
      s.send({ toolCall: { functionCalls: [{ id: "f1", name: "weather", args: { day: "tomorrow" } }] } });
      s.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: b64 } }] }, outputTranscription: { text: "Sonnig." } } });
      s.send({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 40, responseTokenCount: 9 } });
      s.close(1000);
    })();
  } });
  try {
    const { sink, reports } = usageSink();
    const p = createGeminiLive({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "models/gemini-live-test", defaultVoice: "Puck", usage: sink });
    const session = await p.connect({ instructions: "Kurz.", tools: [{ name: "weather", parameters: { type: "object" } }] });
    const it = session.events[Symbol.asyncIterator]();
    session.sendAudio(sinePcm16(160, 16000));
    session.submitToolResult("f1", { forecast: "sunny" });
    const evs: RealtimeEvent[] = await until(it, (e) => e.type === "closed");
    assert.deepEqual(evs.map((e) => e.type), ["ready", "transcript", "transcript", "tool.call", "audio", "transcript", "transcript", "transcript", "turn.done", "usage", "closed"]);
    const finals = evs.filter((e) => e.type === "transcript" && e.final).map((e) => (e as { role: string; text: string }).role + ":" + (e as { text: string }).text);
    assert.deepEqual(finals, ["user:wetter morgen", "assistant:Sonnig."]);
    assert.equal(reports.length, 1);
    assert.match(reports[0]!.eventId ?? "", /^gemini:[0-9a-f]{12}:0$/);
    const { eventId: _id, ...rest } = reports[0]!;
    assert.deepEqual(rest, { provider: "gemini", operation: "realtime", model: "models/gemini-live-test", inputTokens: 40, outputTokens: 9 });

    const sock = v.sockets[0]!;
    assert.equal(sock.req.url, WS_PATH, "the key is not in the URL");
    assert.equal(sock.req.headers["x-goog-api-key"], SENTINEL_KEY);
    const [setup, audio, tool] = sock.jsonFrames();
    assert.equal(setup.setup.model, "models/gemini-live-test");
    assert.deepEqual(setup.setup.generationConfig.responseModalities, ["AUDIO"]);
    assert.equal(setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Puck");
    assert.equal(setup.setup.systemInstruction.parts[0].text, "Kurz.");
    assert.equal(setup.setup.tools[0].functionDeclarations[0].name, "weather");
    assert.equal(audio.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
    assert.deepEqual(tool.toolResponse.functionResponses[0], { id: "f1", name: "", response: { forecast: "sunny" } });
    assertNoKey(evs, "events");
  } finally { await v.close(); }
});

test("discovery lists live-capable models, prefers native audio, and connect uses it when no model is configured", async () => {
  const v = await startFakeVendor({
    http: (req, res) => json(res, 200, { models: [
      { name: "models/gemini-2.5-flash", displayName: "Flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-live-2.5-flash-preview", displayName: "Live", supportedGenerationMethods: ["bidiGenerateContent"] },
      { name: "models/gemini-3-flash-native-audio-x", displayName: "Native", supportedGenerationMethods: ["bidiGenerateContent"] },
    ] }),
    ws: (s) => { s.waitFor(1).then(() => s.send({ setupComplete: {} })); },
  });
  try {
    const p = createGeminiLive({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl });
    const models = await p.listModels();
    assert.deepEqual(models.map((m) => [m.id, m.capabilities]), [["models/gemini-2.5-flash", []], ["models/gemini-live-2.5-flash-preview", ["realtime", "native-audio"]], ["models/gemini-3-flash-native-audio-x", ["realtime", "native-audio"]]]);
    assert.equal(v.requests[0]!.headers["x-goog-api-key"], SENTINEL_KEY);
    assert.ok(!v.requests[0]!.url.includes(SENTINEL_KEY));
    const s = await p.connect();
    await s.events[Symbol.asyncIterator]().next();
    assert.equal(v.sockets[0]!.json(0).setup.model, "models/gemini-live-2.5-flash-preview");
    await s.close();
  } finally { await v.close(); }
});

test("interrupt mutes model audio until the turn ends; errors map to unified codes without the key", async () => {
  const b64 = Buffer.from(sinePcm16(48, 24000)).toString("base64");
  const chunk = { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: b64 } }] } } };
  const v = await startFakeVendor({ ws: (s) => { (async () => { await s.waitFor(1); s.send({ setupComplete: {} }); await s.waitFor(2); s.send(chunk); s.send({ serverContent: { turnComplete: true } }); s.send(chunk); s.send({ error: { message: `quota ${SENTINEL_KEY}`, status: "RESOURCE_EXHAUSTED" } }); s.close(1000); })(); } });
  try {
    const s = await createGeminiLive({ getSecret, apiKeyRef: "voice.key", baseUrl: v.httpUrl, defaultModel: "m" }).connect();
    s.interrupt(); // local mute
    s.sendText("go");
    const evs = await until(s.events[Symbol.asyncIterator](), (e) => e.type === "closed");
    assert.deepEqual(evs.map((e) => e.type), ["ready", "turn.done", "audio", "error", "closed"]);
    assert.equal((evs[3] as unknown as { error: { code: string } }).error.code, "rate_limited");
    assertNoKey(evs, "events");
  } finally { await v.close(); }
});

test("handshake failures: 403 -> auth; 429 -> rate_limited; key stays out of the error", async () => {
  const deny = await startFakeVendor({ rejectUpgrade: () => 403 });
  const slow = await startFakeVendor({ rejectUpgrade: () => 429 });
  try {
    await assert.rejects(createGeminiLive({ getSecret, apiKeyRef: "voice.key", baseUrl: deny.httpUrl, defaultModel: "m" }).connect(), (e) => { assert.ok(isVoiceProviderError(e)); assert.equal(e.code, "auth"); assertNoKey(e, "error"); return true; });
    await assert.rejects(createGeminiLive({ getSecret, apiKeyRef: "voice.key", baseUrl: slow.httpUrl, defaultModel: "m" }).connect(), (e) => isVoiceProviderError(e) && e.code === "rate_limited");
  } finally { await deny.close(); await slow.close(); }
});
