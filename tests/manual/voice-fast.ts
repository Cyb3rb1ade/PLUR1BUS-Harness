// Manual native-model measurement, never part of a test script or CI. Downloads are an explicit preparation step.
// The deterministic agent measures the native voice path's floor, not a production LLM's latency.
import { platform, arch, cpus } from 'node:os';
import { join } from 'node:path';
import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { LocalVoice, loadCatalog, modelSizeBytes, resolveProfile, resample, pcm16ToFloat32, float32ToPcm16 } from '../../packages/voice-providers/src/index.ts';
import { createTalkSession } from '../../packages/core/src/voice/talk.ts';
import { VoiceMetrics } from '../../packages/core/src/voice/metrics.ts';
import { SessionStore } from '../../packages/core/src/session/store.ts';
import { TurnRunner } from '../../packages/core/src/session/turn-loop.ts';
import { Compactor, defaultCompaction } from '../../packages/core/src/session/compaction.ts';
import { FakeChatProvider } from '../../packages/core/src/session/provider.ts';
const dir = process.env.VOICE_BENCH_MODELS ?? join(process.env.HOME ?? '.', '.cache', 'plur1bus-voice-benchmark');
const language = process.env.VOICE_BENCH_LANGUAGE ?? 'en';
const kokoro = process.env.VOICE_BENCH_TTS === 'kokoro';
if (kokoro && language !== 'en') throw new Error('Kokoro benchmark only supports English');
const base = loadCatalog();
const catalog = loadCatalog(kokoro ? { languages: { en: { ...base.languages.en, tts: { fast: 'kokoro-multi' } } } } : undefined);
const baselineRss = process.memoryUsage().rss; let peakRss = baselineRss;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10); sampler.unref();
const voice = new LocalVoice({ modelsDir: dir, catalog, config: { language, profile: 'fast' } });
const acceptLicences = (process.env.VOICE_BENCH_ACCEPT_LICENCES ?? '').split(',').filter(Boolean);
await voice.setLanguage(language, { profile: 'fast', download: process.argv.includes('--prepare'), acceptLicences });
if (process.argv.includes('--prepare')) { console.log(JSON.stringify({ prepared: true, language, profile: 'fast' })); voice.unload(); process.exit(0); }
await voice.warm();
const inputPath = join(dir, `benchmark-input-${language}.pcm`);
let pcm: Uint8Array;
try { pcm = new Uint8Array(await readFile(inputPath)); } catch {
  if (kokoro) throw new Error('Run Piper first to prepare identical English input PCM');
  const input = await voice.tts.synthesize(language === 'de' ? 'Bitte sage mir guten Tag.' : 'Please say hello to me.');
  pcm = float32ToPcm16(resample(pcm16ToFloat32(input.data), input.sampleRate, 16000)); await writeFile(inputPath, pcm);
}
const store = new SessionStore({ path: ':memory:' }); const compactor = new Compactor(store, defaultCompaction());
const runner = new TurnRunner({ store, compactor, provider: () => new FakeChatProvider({ chunkSize: 16 }), memory: { async recall() { return { text: '', degraded: null }; }, async capture() {}, async checkpoint() {} } });
const session = store.createSession({ kind: 'direct', owner: 'benchmark', agentId: 'benchmark', memoryMode: 'incognito' });
const metrics = new VoiceMetrics(); const control = new AbortController(); let delivered: (() => void) | undefined;
const talk = await createTalkSession({ asr: voice.asr, tts: voice.tts, profile: resolveProfile({ enabled: true }), metrics, signal: control.signal, language,
  agent: { start(text, turnProfile) { return runner.submit({ session, caller: { channel: 'cli', accountId: 'benchmark', userId: 'benchmark' }, text, turnProfile }); }, cancel() { runner.cancel(session.id); } },
  receive: async () => { delivered?.(); }, event: e => { if (e.type === 'voice.failed') throw new Error('native voice benchmark failed'); } });
const ttsFirst: number[] = [];
const output = language === 'de' ? 'Guten Tag. Wie kann ich helfen?' : 'Hello. How can I help you?';
async function bytes(path: string): Promise<number> { const info = await stat(path); if (info.isFile()) return info.size; let total = 0; for (const entry of await readdir(path)) total += await bytes(join(path, entry)); return total; }
function stats(values: number[]) { values.sort((a,b) => a-b); return { medianMs: values.length % 2 ? values[Math.floor(values.length / 2)] : (values[values.length / 2 - 1]! + values[values.length / 2]!) / 2, p95Ms: values[Math.ceil(values.length * .95) - 1] }; }
try {
  const turns = Number(process.env.VOICE_BENCH_TURNS ?? 30);
  for (let i = 0; i < turns + 3; i++) {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const firstAudio = new Promise<void>((resolve, reject) => { delivered = resolve; deadline = setTimeout(() => reject(new Error('native model produced no first audio within 30s')), 30000); });
    const ttsStart = performance.now();
    for await (const _ of voice.tts.synthesizeStream(output, { signal: control.signal })) { if (i >= 3) ttsFirst.push(performance.now() - ttsStart); break; }
    talk.speech(true);
    for (let offset = 0; offset < pcm.length; offset += 640) talk.send(pcm.subarray(offset, offset + 640));
    talk.speech(false);
    await firstAudio; clearTimeout(deadline); await talk.idle(); await runner.idle();
    if (i === 2) metrics.recorder.reset();
  }
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  console.log(JSON.stringify({ hardware: { os: platform(), arch: arch(), cpu: cpus()[0]?.model }, node: process.version, language, voice: kokoro ? 'Kokoro af_heart' : language === 'de' ? 'Piper Thorsten low' : 'Piper Lessac low', profile: 'fast', ttsFirstChunk: stats(ttsFirst), ramBytes: { baselineRss, loadedRss: process.memoryUsage().rss, peakRss }, modelBytes: { ttsDownload: modelSizeBytes(catalog.models[catalog.languages[language]!.tts.fast]!), ttsInstalled: await bytes(join(dir, catalog.languages[language]!.tts.fast)) }, agent: 'deterministic in-process (no LLM latency)', input: 'native TTS generated PCM, explicit speech boundary', ...metrics.report() }, null, 2));
} finally { clearInterval(sampler); await talk.close(); await runner.idle(); store.close(); voice.unload(); }
