// W3. Record calls from the production TypeScript catalog adapters.
import { fileURLToPath } from "node:url";
import { createElevenLabs } from "../../packages/voice-providers/src/providers/elevenlabs.ts";
import { createGeminiLive } from "../../packages/voice-providers/src/providers/gemini.ts";
import { createGrokVoice } from "../../packages/voice-providers/src/providers/grok.ts";
import { VoiceProviderError } from "../../packages/voice-providers/src/errors.ts";
import { startFakeVendor, type FakeSocket } from "../../packages/voice-providers/test/helpers/fake-vendor.ts";
import { startStub } from "../../packages/providers/test/helpers/stub.ts";
import { exporterMain } from "./lib.mjs";

const fixtureKey = "synthetic-voice-credential";
const keyHeaders = ["xi-api-key", "x-goog-api-key", "authorization"];
type Operation = "eleven-voices" | "eleven-models" | "gemini-models" | "xai-models";
type Reply = { status?: number; body: unknown };

async function capture(operation: Operation, responses: Reply[]) {
  let sent = 0;
  const stub = await startStub((_request, reply) => {
    const response = responses[sent++];
    if (!response) throw new Error("Unexpected voice request");
    reply.writeHead(response.status ?? 200, { "content-type": "application/json" });
    reply.end(JSON.stringify(response.body));
  });
  try {
    const options = { baseUrl: stub.baseUrl, apiKeyRef: "fixture", getSecret: async () => fixtureKey };
    let expected;
    try {
      if (operation === "eleven-voices") expected = { result: await createElevenLabs(options).tts.listVoices!() };
      else if (operation === "eleven-models") expected = { result: await createElevenLabs(options).tts.listModels!() };
      else if (operation === "gemini-models") expected = { result: await createGeminiLive(options).listModels!() };
      else expected = { result: await createGrokVoice(options).listModels!() };
    } catch (error) {
      if (!(error instanceof VoiceProviderError)) throw error;
      expected = { code: error.code, retryable: error.retryable };
    }
    if (sent !== responses.length) throw new Error(`Expected ${responses.length} requests, received ${sent}`);
    return {
      operation,
      expected,
      exchanges: stub.requests.map((request, index) => ({
        request: {
          method: request.method,
          path: request.url,
          headers: Object.fromEntries(keyHeaders.flatMap((key) => {
            const value = request.headers[key];
            return typeof value === "string" ? [[key, value.replaceAll(fixtureKey, "<credential>")]] : [];
          })),
        },
        response: { status: responses[index]!.status ?? 200,
          body: JSON.parse(JSON.stringify(responses[index]!.body).replaceAll(fixtureKey, "<credential>")) },
      })),
    };
  } finally {
    await stub.close();
  }
}

async function captureSynthesis() {
  const bytes = Buffer.from([0, 1, 2, 255]);
  const stub = await startStub((_request, reply) => {
    reply.writeHead(200, { "content-type": "application/octet-stream" });
    reply.end(bytes);
  });
  try {
    const provider = createElevenLabs({
      baseUrl: stub.baseUrl,
      apiKeyRef: "fixture",
      getSecret: async () => fixtureKey,
      zeroRetention: true,
    });
    const input = { text: "A fixture voice 👋", voice: "synthetic/a b", language: "en" };
    const actual = await provider.tts.synthesize(input.text, { voice: input.voice, language: input.language });
    if (stub.requests.length !== 1) throw new Error("Expected a single buffered synthesis request");
    const request = stub.requests[0]!;
    return {
      schema: "plur1bus.parity-wire/1",
      exporter: "scripts/parity/export-voice.ts",
      transport: "http",
      input,
      expected: {
        dataBase64: Buffer.from(actual.data).toString("base64"),
        format: actual.format, sampleRate: actual.sampleRate, usage: actual.usage,
      },
      exchanges: [{
        request: {
          method: request.method, path: request.url, bodyText: request.body,
          headers: { "accept": request.headers["accept"], "content-type": request.headers["content-type"],
            "xi-api-key": String(request.headers["xi-api-key"]).replaceAll(fixtureKey, "<credential>") },
        },
        response: { status: 200, headers: { "content-type": "application/octet-stream" },
          chunksBase64: [bytes.toString("base64")] },
      }],
    };
  } finally {
    await stub.close();
  }
}

async function captureTranscription() {
  const pcm = Uint8Array.from([1, 0, 2, 0, 3, 0]);
  const sampleRate = 16000;
  const fixtureBoundary = "voice-fixture-multipart";
  const reply = { text: "Fixture transcript", language_code: "en",
    words: [{ type: "word", text: "Fixture", start: 0.1, end: 0.25 }, { type: "spacing", text: " " }] };
  let exchange;
  const provider = createElevenLabs({
    baseUrl: "http://localhost",
    apiKeyRef: "fixture",
    getSecret: async () => fixtureKey,
    zeroRetention: true,
    fetch: async (url, init) => {
      const request = new Request(url, init);
      const type = request.headers.get("content-type")!;
      const boundary = type.split("boundary=")[1]!;
      const wire = Buffer.from(await request.arrayBuffer()).toString("latin1").replaceAll(boundary, fixtureBoundary);
      exchange = {
        request: { method: request.method, path: new URL(url).pathname + new URL(url).search,
          headers: { "content-type": type.replace(boundary, fixtureBoundary), "xi-api-key": "<credential>" },
          bodyBase64: Buffer.from(wire, "latin1").toString("base64") },
        response: { status: 200, body: reply },
      };
      return new Response(JSON.stringify(reply), { status: 200 });
    },
  });
  const actual = await provider.asr.transcribe({ data: pcm, format: "pcm16", sampleRate }, { language: "en", timestamps: true });
  if (!exchange) throw new Error("Missing transcription request");
  return { schema: "plur1bus.parity-wire/1", exporter: "scripts/parity/export-voice.ts", transport: "http",
    input: { pcm: [...pcm], sampleRate, fixtureBoundary }, expected: actual, exchanges: [exchange] };
}

async function captureRealtime(vendor: "grok" | "gemini" | "eleven-asr") {
  const pcm = Uint8Array.from([1, 0, 2, 0]);
  const model = vendor === "eleven-asr" ? "scribe_v2_realtime" : "fixture-live";
  const sampleRate = 16000;
  const ready = vendor === "grok" ? { type: "session.created" } : vendor === "gemini"
    ? { setupComplete: {} } : { message_type: "session_started" };
  const answer = vendor === "grok" ? { type: "response.audio.delta", delta: "AQACAA==" } : vendor === "gemini"
    ? { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AQACAA==" } }] } } }
    : { message_type: "committed_transcript", text: "Fixture transcript" };
  const hasSetup = vendor !== "eleven-asr";
  const reply = async (socket: FakeSocket) => {
    if (hasSetup) await socket.waitFor(1);
    socket.send(ready);
    await socket.waitFor(hasSetup ? 2 : 1);
    socket.send(answer);
  };
  const server = await startFakeVendor({ ws: (socket) => { void reply(socket); } });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 3000);
  try {
    const config = { baseUrl: server.httpUrl, apiKeyRef: "fixture", getSecret: async () => fixtureKey, defaultModel: model };
    const session = vendor === "eleven-asr"
      ? await createElevenLabs(config).asr.openStream({ model, sampleRate, signal: abort.signal })
      : await (vendor === "grok" ? createGrokVoice(config) : createGeminiLive(config))
        .connect({ model, inputSampleRate: sampleRate, signal: abort.signal });
    try {
      const stream = session.events[Symbol.asyncIterator]();
      const first = (await stream.next()).value;
      if (first?.type !== "ready") throw new Error("Missing realtime readiness");
      session.sendAudio(pcm);
      const second = (await stream.next()).value;
      if (second?.type !== "audio" && second?.type !== "final") throw new Error("Missing realtime data");
      const peer = server.sockets[0]!;
      const frames = peer.jsonFrames();
      return {
        schema: "plur1bus.parity-wire/1", exporter: "scripts/parity/export-voice.ts", transport: "websocket",
        input: { vendor, model, sampleRate, pcm: [...pcm] },
        request: { path: peer.req.url, headers: Object.fromEntries(keyHeaders.flatMap((key) => {
          const value = peer.req.headers[key];
          return typeof value === "string" ? [[key, value.replaceAll(fixtureKey, "<credential>")]] : [];
        })) },
        expected: [first, second.type === "audio"
          ? { type: "audio", bytes: [...second.chunk.data], sampleRate: second.chunk.sampleRate }
          : second],
        exchanges: [
          { send: hasSetup ? [frames[0]] : [], receive: [ready] },
          { send: [frames[hasSetup ? 1 : 0]], receive: [answer] },
        ],
      };
    } finally {
      await session.close();
    }
  } finally {
    clearTimeout(timeout);
    await server.close();
  }
}

export async function buildVoiceFixtures() {
  return {
    synthesis: await captureSynthesis(),
    "grok-realtime": await captureRealtime("grok"),
    "gemini-realtime": await captureRealtime("gemini"),
    "eleven-asr-realtime": await captureRealtime("eleven-asr"),
    transcription: await captureTranscription(),
    catalog: {
      schema: "plur1bus.parity-wire/1",
      exporter: "scripts/parity/export-voice.ts",
      scenarios: [
        await capture("eleven-voices", [
          { body: { voices: [{ voice_id: "voice-a", name: "A", labels: { language: "en", gender: "neutral" },
            verified_languages: [{ language: "en" }, { language: "de" }] }], has_more: true, next_page_token: "next + page" } },
          { body: { voices: [{ voice_id: "voice-b" }], has_more: false } },
        ]),
        await capture("eleven-models", [{ body: [
          { model_id: "variant", name: "Model", can_do_text_to_speech: true, languages: [{ language_id: "en" }] },
          { model_id: "scribe-only" },
        ] }]),
        await capture("gemini-models", [
          { body: { models: [{ name: "models/live", supportedGenerationMethods: ["bidiGenerateContent"] }], nextPageToken: "two /" } },
          { body: { models: [{ name: "models/text", displayName: "Text" }] } },
        ]),
        await capture("xai-models", [{ body: { data: [{ id: "fixture-voice" }, { id: "fixture-text" }] } }]),
        await capture("eleven-voices", [{ status: 401, body: { error: fixtureKey } }]),
        await capture("xai-models", [{ status: 404, body: { error: fixtureKey } }]),
      ],
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "voice", build: buildVoiceFixtures });
}
