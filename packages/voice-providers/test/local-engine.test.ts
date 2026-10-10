import { test } from "node:test";
import assert from "node:assert/strict";
import { createSherpaEngine, platformAvailability, resolveModel } from "../src/local/engine.ts";
import { builtinCatalog } from "../src/local/catalog.ts";
import { isVoiceProviderError } from "../src/errors.ts";

test("platform availability: supported platform/arch pairs pass, others explain themselves", () => {
  for (const [p, a] of [["linux", "x64"], ["linux", "arm64"], ["darwin", "arm64"], ["win32", "x64"]] as const) assert.deepEqual(platformAvailability(p, a), { ok: true });
  const bad = platformAvailability("freebsd", "x64");
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.reason, /freebsd\/x64.*cloud voice provider/);
  const win = platformAvailability("win32", "arm64");
  assert.equal(win.ok, false);
});

test("engine kinds: which catalog engines the sherpa adapter can run", () => {
  const e = createSherpaEngine();
  assert.equal(e.supports("stt", "streaming-transducer"), true);
  assert.equal(e.supports("stt", "nemo-transducer"), true);
  assert.equal(e.supports("stt", "nemo-ctc"), true);
  assert.equal(e.supports("tts", "vits"), true);
  assert.equal(e.supports("tts", "kokoro"), true);
  assert.equal(e.supports("tts", "pocket-tts"), false);
  assert.equal(e.supports("vad", "silero-vad"), true);
});

test("without the native module the engine is lazy: availability is platform-only and loading reports unavailable", async () => {
  const e = createSherpaEngine({ loadModule: async () => { throw new Error("Cannot find module"); } });
  assert.deepEqual(e.availability(), platformAvailability());
  const m = resolveModel(builtinCatalog().models["silero-vad"]!, "/models/silero-vad");
  await assert.rejects(e.loadVad(m), (err) => !isVoiceProviderError(err) || err.code === "unavailable");
});

test("sherpa configs are built from the catalog roles (fake module records them)", async () => {
  const seen: Record<string, any> = {};
  class Rec { constructor(cfg: any) { seen["online"] = cfg; } createStream() { return { acceptWaveform() {} }; } isReady() { return false; } decode() {} getResult() { return { text: " hi " }; } isEndpoint() { return false; } reset() {} }
  class Tts { sampleRate = 22050; numSpeakers = 1; constructor(cfg: any) { seen["tts"] = cfg; } async generateAsync() { return { samples: new Float32Array(4), sampleRate: 22050 }; } }
  class Vad { constructor(cfg: any) { seen["vad"] = cfg; } acceptWaveform() {} isDetected() { return true; } }
  const engine = createSherpaEngine({ loadModule: async () => ({ OnlineRecognizer: Rec, OfflineTts: Tts, Vad }), numThreads: 3 });
  const c = builtinCatalog();
  const asr = await engine.loadAsr(resolveModel(c.models["kroko-de"]!, "/m/kroko-de"));
  assert.equal(asr.streaming, true);
  assert.equal(seen["online"].modelConfig.transducer.encoder, "/m/kroko-de/encoder.onnx");
  assert.equal(seen["online"].modelConfig.tokens, "/m/kroko-de/tokens.txt");
  assert.equal(seen["online"].modelConfig.numThreads, 3);
  const st = asr.createStream();
  assert.equal(st.result().text, "hi");
  const tts = await engine.loadTts(resolveModel(c.models["kokoro-multi"]!, "/m/kokoro"));
  assert.equal(seen["tts"].model.kokoro.voices, "/m/kokoro/voices.bin");
  assert.equal(tts.sampleRate, 22050);
  assert.equal((await tts.generate("hi", {})).samples.length, 4);
  const vad = await engine.loadVad(resolveModel(c.models["silero-vad"]!, "/m/vad"));
  assert.equal(seen["vad"].sileroVad.model, "/m/vad/silero_vad.onnx");
  assert.equal(vad.isSpeech(), true);
});

test("dispose frees native objects where the binding offers a free/delete/destroy, tolerates their absence and failures", async () => {
  const freed: string[] = [];
  class Rec { createStream() { return { acceptWaveform() {}, free: () => freed.push("stream") }; } isReady() { return false; } decode() {} getResult() { return { text: "" }; } isEndpoint() { return false; } reset() {} free() { freed.push("rec"); } }
  class Tts { sampleRate = 16000; delete() { freed.push("tts"); throw new Error("native failure"); } }
  class Vad { acceptWaveform() {} isDetected() { return false; } }
  const engine = createSherpaEngine({ loadModule: async () => ({ OnlineRecognizer: Rec, OfflineTts: Tts, Vad }) });
  const c = builtinCatalog();
  const asr = await engine.loadAsr(resolveModel(c.models["kroko-de"]!, "/m/k"));
  const st = asr.createStream();
  const open = asr.createStream();
  st.dispose();
  st.dispose();
  assert.deepEqual(freed, ["stream"], "a stream is freed once");
  asr.dispose();
  assert.deepEqual(freed, ["stream", "stream", "rec"], "dispose frees streams still open, then the recogniser");
  void open;
  const tts = await engine.loadTts(resolveModel(c.models["kokoro-multi"]!, "/m/t"));
  assert.doesNotThrow(() => tts.dispose());
  assert.ok(freed.includes("tts"));
  const vad = await engine.loadVad(resolveModel(c.models["silero-vad"]!, "/m/v"));
  assert.doesNotThrow(() => vad.dispose());
});

test("the Parakeet 110M entry runs as a single-file CTC model, not a transducer", async () => {
  const seen: Record<string, any> = {};
  class Offline { constructor(cfg: any) { seen["offline"] = cfg; } createStream() { return { acceptWaveform() {} }; } async decodeAsync() {} getResult() { return { text: "ok" }; } }
  const engine = createSherpaEngine({ loadModule: async () => ({ OfflineRecognizer: Offline }) });
  const m = builtinCatalog().models["parakeet-110m-en"]!;
  assert.equal(m.engine, "nemo-ctc");
  const asr = await engine.loadAsr(resolveModel(m, "/m/p110"));
  assert.equal(asr.streaming, false);
  assert.equal(seen["offline"].modelConfig.nemoCtc.model, "/m/p110/model.int8.onnx");
  assert.equal(seen["offline"].modelConfig.tokens, "/m/p110/tokens.txt");
  assert.equal(seen["offline"].modelConfig.transducer, undefined);
});
