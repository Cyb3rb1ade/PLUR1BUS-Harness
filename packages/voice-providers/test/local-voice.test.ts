import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalVoice, type LocalVoiceConfig } from "../src/local/voice.ts";
import { isVoiceProviderError } from "../src/errors.ts";
import { startFakeVendor, sinePcm16, type FakeVendor } from "./helpers/fake-vendor.ts";
import { FakeEngine, testCatalogOverride, testFiles } from "./helpers/fake-engine.ts";
import { collect, until } from "./helpers/common.ts";
import { builtinCatalog } from "../src/local/catalog.ts";
import type { DownloadProgress } from "../src/local/download.ts";

interface Rig { voice: LocalVoice; engine: FakeEngine; vendor: FakeVendor; dir: string; hits: string[]; done(): Promise<void> }
async function rig(config: LocalVoiceConfig = {}, locale = "de_DE.UTF-8", now?: () => number): Promise<Rig> {
  const files = testFiles();
  const hits: string[] = [];
  const vendor = await startFakeVendor({ http: (req, res) => { hits.push(req.url.slice(1)); const d = files[req.url.slice(1)]; if (!d) { res.statusCode = 404; res.end(); return; } res.writeHead(200, { "content-length": d.length }); res.end(Buffer.from(d)); } });
  const dir = await mkdtemp(join(tmpdir(), "voice-local-"));
  const engine = new FakeEngine();
  const voice = new LocalVoice({ config: { ...config, catalogOverride: testCatalogOverride(vendor.httpUrl, files) }, modelsDir: dir, engine, systemLocale: () => locale, ...(now ? { now } : {}) });
  return { voice, engine, vendor, dir, hits, done: async () => { await vendor.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("default language is the system language when the catalog has it, else English", async () => {
  const r = await rig({}, "de_DE.UTF-8");
  try {
    assert.equal(r.voice.defaultLanguage(), "de");
    assert.equal(r.voice.resolveFor().language, "de");
    for (const [loc, want] of [["en-GB", "en"], ["fr_FR", "en"], ["DE-at", "de"], ["", "en"]] as const) {
      const v = new LocalVoice({ modelsDir: r.dir, engine: r.engine, catalog: r.voice.catalog, systemLocale: () => loc });
      assert.equal(v.defaultLanguage(), want, loc);
    }
  } finally { await r.done(); }
});

test("config language and per-agent overrides win over the system default, per field", async () => {
  const r = await rig({ language: "en", profile: "fast", perAgent: { bernd: { language: "de", profile: "quality" }, anna: { profile: "quality" } } });
  try {
    assert.deepEqual(r.voice.resolveFor(), { language: "en", profile: "fast" });
    assert.deepEqual(r.voice.resolveFor("bernd"), { language: "de", profile: "quality" });
    assert.deepEqual(r.voice.resolveFor("anna"), { language: "en", profile: "quality" });
    assert.deepEqual(r.voice.resolveFor("unknown"), { language: "en", profile: "fast" });
  } finally { await r.done(); }
});

test("listLanguages reports fast/quality, stt/tts, licences, sizes and install state from the catalog", async () => {
  const r = await rig();
  try {
    const langs = await r.voice.listLanguages();
    assert.deepEqual(langs.map((l) => l.code), ["de", "en"]);
    const de = langs[0]!;
    assert.equal(de.profiles.fast.stt.id, "t-stt-de");
    assert.equal(de.profiles.fast.stt.streaming, true);
    assert.equal(de.profiles.quality.tts.id, "t-tts-de-nc");
    assert.equal(de.profiles.quality.needsLicenceConfirmation, true);
    assert.match(de.profiles.quality.licenceNotices[0]!, /NON-COMMERCIAL/);
    assert.equal(de.profiles.fast.needsLicenceConfirmation, false);
    assert.equal(de.profiles.fast.installed, false);
    assert.ok((de.profiles.fast.sizeBytes ?? 0) > 0);
    assert.equal(langs[1]!.profiles.quality.ttsFallback?.id, "t-kokoro");
    assert.equal((await r.voice.getLanguage("de"))?.name, "Deutsch");
    assert.equal(await r.voice.getLanguage("xx"), undefined);
    await r.voice.setLanguage("de", { download: true });
    assert.equal((await r.voice.getLanguage("de"))?.profiles.fast.installed, true);
    assert.equal((await r.voice.getLanguage("de"))?.current, true);
  } finally { await r.done(); }
});

test("setLanguage without download refuses with a clear message; with download it fetches, reports progress and loads", async () => {
  const r = await rig();
  try {
    await assert.rejects(r.voice.setLanguage("de"), (e) => isVoiceProviderError(e) && e.code === "unavailable" && /not installed/.test(e.message) && /download: true/.test(e.message));
    assert.equal(r.hits.length, 0);
    const progress: DownloadProgress[] = [];
    const st = await r.voice.setLanguage("de", { download: true, onProgress: (p) => progress.push(p) });
    assert.deepEqual([st.language, st.profile, st.stt.id, st.tts.id, st.vad.id], ["de", "fast", "t-stt-de", "t-tts-de", "t-vad"]);
    assert.deepEqual([...new Set(progress.map((p) => p.modelId))].sort(), ["t-stt-de", "t-tts-de", "t-vad"]);
    assert.deepEqual(r.engine.events.filter((e) => e.startsWith("load:")).sort(), ["load:t-stt-de", "load:t-tts-de", "load:t-vad"]);
    assert.equal(r.voice.capability().state, "ready");
    const hitsBefore = r.hits.length;
    await r.voice.setLanguage("de");
    assert.equal(r.hits.length, hitsBefore, "installed models are not downloaded again");
  } finally { await r.done(); }
});

test("non-commercial tier is refused without confirmation and accepted with it (option or config)", async () => {
  const r = await rig();
  try {
    await assert.rejects(r.voice.setLanguage("de", { profile: "quality", download: true }), (e) => isVoiceProviderError(e) && e.code === "licence_required");
    assert.equal(r.hits.length, 0, "refused before any download");
    assert.equal(r.voice.current(), undefined);
    const st = await r.voice.setLanguage("de", { profile: "quality", download: true, acceptNcLicence: true });
    assert.equal(st.tts.id, "t-tts-de-nc");
  } finally { await r.done(); }
  const r2 = await rig({ acceptNcLicence: true, profile: "quality" });
  try {
    assert.equal((await r2.voice.setLanguage("de", { download: true })).tts.id, "t-tts-de-nc");
  } finally { await r2.done(); }
});

test("platform without a sherpa-onnx build: capability unavailable with a clear message, setLanguage throws unavailable", async () => {
  const r = await rig();
  try {
    r.engine.avail = { ok: false, reason: "local voice (sherpa-onnx) has no build for freebsd/x64; use a cloud voice provider on this machine" };
    const cap = r.voice.capability();
    assert.equal(cap.state, "unavailable");
    assert.match(cap.message, /freebsd\/x64/);
    await assert.rejects(r.voice.setLanguage("de", { download: true }), (e) => isVoiceProviderError(e) && e.code === "unavailable" && /freebsd/.test(e.message));
    assert.equal(r.hits.length, 0);
    await assert.rejects(r.voice.asr.transcribe({ data: sinePcm16(100), format: "pcm16", sampleRate: 16000 }), (e) => isVoiceProviderError(e) && e.code === "unavailable");
  } finally { await r.done(); }
});

test("a tier whose engine the runtime lacks falls back to the declared TTS fallback; without a fallback it refuses clearly", async () => {
  const r = await rig();
  try {
    r.engine.unsupportedEngines.add("pocket-tts");
    const st = await r.voice.setLanguage("en", { profile: "quality", download: true });
    assert.equal(st.tts.id, "t-kokoro");
    assert.equal(st.usedTtsFallback, true);
    r.engine.unsupportedEngines.add("vits");
    await assert.rejects(r.voice.setLanguage("de", { download: true }), (e) => isVoiceProviderError(e) && e.code === "unavailable" && /"vits" engine/.test(e.message));
    assert.equal(r.voice.current()?.language, "en", "the failed switch keeps the working language");
  } finally { await r.done(); }
});

test("switching language loads the new models first, then unloads the old ones; a failing load keeps the old setup", async () => {
  const r = await rig();
  try {
    await r.voice.setLanguage("de", { download: true });
    r.engine.events.length = 0;
    await r.voice.setLanguage("en", { download: true });
    const ev = r.engine.events;
    const lastLoad = Math.max(...ev.map((e, i) => (e.startsWith("load:") ? i : -1)));
    const firstDispose = ev.findIndex((e) => e.startsWith("dispose:"));
    assert.ok(firstDispose > lastLoad, ev.join(","));
    assert.deepEqual(ev.filter((e) => e.startsWith("dispose:")).sort(), ["dispose:t-stt-de", "dispose:t-tts-de", "dispose:t-vad"]);
    assert.equal(r.voice.current()?.language, "en");
    r.engine.events.length = 0;
    r.engine.failLoad = "t-tts-de";
    await assert.rejects(r.voice.setLanguage("de"), (e) => isVoiceProviderError(e) && e.code === "unavailable");
    assert.equal(r.voice.current()?.language, "en");
    assert.ok(r.engine.events.includes("dispose:t-stt-de"), "partially loaded models are released");
    assert.ok(!r.engine.events.includes("dispose:t-stt-en"), "the working models stay loaded");
  } finally { await r.done(); }
});

test("concurrent setLanguage calls are serialised and the last one wins", async () => {
  const r = await rig();
  try {
    const a = r.voice.setLanguage("de", { download: true });
    const b = r.voice.setLanguage("en", { download: true });
    await Promise.all([a, b]);
    assert.equal(r.voice.current()?.language, "en");
    assert.equal(r.engine.events.filter((e) => e === "dispose:t-stt-de").length, 1);
  } finally { await r.done(); }
});

test("useForAgent switches to the agent's language only when it differs", async () => {
  const r = await rig({ perAgent: { bernd: { language: "en" } }, language: "de" });
  try {
    await r.voice.setLanguage("de", { download: true });
    const before = r.engine.events.length;
    await r.voice.useForAgent("anna", { download: true });
    assert.equal(r.engine.events.length, before, "same language: no reload");
    const st = await r.voice.useForAgent("bernd", { download: true });
    assert.equal(st.language, "en");
  } finally { await r.done(); }
});

test("warm() runs one inference per model and times each with the injected clock", async () => {
  let t = 1000;
  const r = await rig({}, "de", () => { t += 7; return t; });
  try {
    await assert.rejects(r.voice.warm(), (e) => isVoiceProviderError(e) && e.code === "unavailable");
    await r.voice.setLanguage("de", { download: true });
    const w = await r.voice.warm();
    assert.deepEqual(w, { asrMs: 7, ttsMs: 7 });
    assert.ok(r.engine.events.includes("warm:asr:t-stt-de") && r.engine.events.includes("warm:tts:t-tts-de"));
  } finally { await r.done(); }
});

test("local ASR provider: streaming partials, endpoint finals, commit, and batch transcribe with usage", async () => {
  const usage: unknown[] = [];
  const files = testFiles();
  const vendor = await startFakeVendor({ http: (req, res) => { const d = files[req.url.slice(1)]!; res.writeHead(200, { "content-length": d.length }); res.end(Buffer.from(d)); } });
  const dir = await mkdtemp(join(tmpdir(), "voice-local-"));
  try {
    const voice = new LocalVoice({ config: { catalogOverride: testCatalogOverride(vendor.httpUrl, files) }, modelsDir: dir, engine: new FakeEngine(), usage: (u) => usage.push(u) });
    await voice.setLanguage("de", { download: true });
    const s = await voice.asr.openStream({ sampleRate: 16000 });
    const it = s.events[Symbol.asyncIterator]();
    assert.equal((await it.next()).value.type, "ready");
    s.sendAudio(sinePcm16(1600)); // 10 ms*... -> partial
    s.sendAudio(sinePcm16(1700)); // total >= 3200 samples -> endpoint -> final
    s.sendAudio(sinePcm16(800));
    s.commit();
    await s.close();
    const seq = [{ type: "partial", text: "heard 10" }, { type: "final", text: "heard 20" }, { type: "partial", text: "heard 5" }, { type: "final", text: "final 5" }, { type: "closed" }];
    const got = (await collect({ [Symbol.asyncIterator]: () => it })).map((e) => e.type === "partial" || e.type === "final" ? { type: e.type, text: e.text } : { type: e.type });
    assert.deepEqual(got, seq);
    const r = await voice.asr.transcribe({ data: sinePcm16(16000), format: "pcm16", sampleRate: 16000 });
    assert.equal(r.text, "final 100");
    assert.equal(r.language, "de");
    assert.deepEqual(usage, [{ provider: "local", operation: "asr", model: "t-stt-de", seconds: 1 }]);
    const models = await voice.asr.listModels();
    assert.deepEqual(models[0]!.capabilities, ["asr", "streaming"]);
  } finally { await vendor.close(); await rm(dir, { recursive: true, force: true }); }
});

test("non-streaming ASR tier decodes on commit", async () => {
  const r = await rig({ profile: "quality", acceptNcLicence: true });
  try {
    await r.voice.setLanguage("de", { download: true });
    const s = await r.voice.asr.openStream({ sampleRate: 16000 });
    const it = s.events[Symbol.asyncIterator]();
    await it.next();
    s.sendAudio(sinePcm16(500));
    s.sendAudio(sinePcm16(500));
    s.commit();
    const evs = await until(it, (e) => e.type === "final");
    assert.deepEqual(evs.map((e) => e.type), ["final"]);
    assert.equal((evs[0] as { text: string }).text, "offline 1000");
    await s.close();
  } finally { await r.done(); }
});

test("local TTS provider: pcm16 at the model rate, resampling, speakers by name, streaming in sentence order, usage", async () => {
  const usage: unknown[] = [];
  const files = testFiles();
  const vendor = await startFakeVendor({ http: (req, res) => { const d = files[req.url.slice(1)]!; res.writeHead(200, { "content-length": d.length }); res.end(Buffer.from(d)); } });
  const dir = await mkdtemp(join(tmpdir(), "voice-local-"));
  try {
    const engine = new FakeEngine();
    engine.unsupportedEngines.add("pocket-tts");
    const voice = new LocalVoice({ config: { catalogOverride: testCatalogOverride(vendor.httpUrl, files), profile: "quality" }, modelsDir: dir, engine, usage: (u) => usage.push(u) });
    await voice.setLanguage("en", { download: true }); // pocket unsupported -> kokoro fallback
    assert.equal(voice.current()?.tts.id, "t-kokoro");
    const r = await voice.tts.synthesize("Hello", { voice: "am_michael" });
    assert.equal(r.sampleRate, 24000);
    assert.equal(r.data.byteLength, 100 * 5 * 2);
    const r16 = await voice.tts.synthesize("Hello", { sampleRate: 16000 });
    assert.equal(r16.sampleRate, 16000);
    assert.equal(r16.data.byteLength, Math.round((500 * 16000) / 24000) * 2);
    await assert.rejects(voice.tts.synthesize("x", { voice: "nobody" }), (e) => isVoiceProviderError(e) && e.code === "invalid_request");
    await assert.rejects(voice.tts.synthesize("x", { format: "mp3" }), (e) => isVoiceProviderError(e) && e.code === "unsupported");
    assert.deepEqual((await voice.tts.listVoices()).map((v) => v.id), ["af_heart", "am_michael"]);
    async function* text() { yield "First sentence. Sec"; yield "ond one. Tail"; }
    const out = await collect(voice.tts.synthesizeStream(text()));
    assert.deepEqual(out.map((c) => c.data.byteLength / 2 / 100), [15, 11, 4]);
    assert.deepEqual(usage.at(-1), { provider: "local", operation: "tts", model: "t-kokoro", chars: 32 });
  } finally { await vendor.close(); await rm(dir, { recursive: true, force: true }); }
});

test("the shipped catalog cannot be downloaded until sha256 is pinned: setLanguage says so, nothing is fetched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voice-local-"));
  try {
    const v = new LocalVoice({ config: { acceptNcLicence: true }, modelsDir: dir, engine: new FakeEngine(), catalog: builtinCatalog(), fetch: async () => { throw new Error("must not fetch"); } });
    await assert.rejects(v.setLanguage("en", { download: true }), (e) => isVoiceProviderError(e) && e.code === "catalog");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dispose and reference counting: language switch delays unloading until active streams complete", async () => {
  const r = await rig();
  try {
    await r.voice.setLanguage("de", { download: true });
    // Open an active ASR stream
    const s = await r.voice.asr.openStream();
    r.engine.events.length = 0;
    // Request language switch while stream is open
    const switchPromise = r.voice.setLanguage("en", { download: true });
    await switchPromise;
    // Old de models must NOT be disposed yet while active stream is running!
    assert.equal(r.engine.events.some((e) => e === "dispose:t-stt-de"), false, "active stream protects old model from being disposed immediately");
    // Now close stream
    await s.close();
    // After stream closed, old model is disposed
    assert.equal(r.engine.events.some((e) => e === "dispose:t-stt-de"), true, "old model disposed after active stream closes");
    // Calling voice.dispose() disposes currently loaded models
    r.engine.events.length = 0;
    r.voice.dispose();
    assert.equal(r.engine.events.some((e) => e.startsWith("dispose:")), true, "voice.dispose() releases all resident models");
  } finally { await r.done(); }
});

