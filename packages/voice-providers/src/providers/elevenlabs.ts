// ElevenLabs: cloud TTS (HTTP, HTTP streaming, WebSocket text-input streaming) and ASR (batch, realtime socket).
// All endpoint shapes live in constants.ts and are flagged VERIFY there. The API key is resolved from a secret
// reference per call and sent only in the xi-api-key header of server-side requests.
import { ELEVENLABS } from "../constants.ts";
import { VoiceProviderError, abortedError } from "../errors.ts";
import type { AsrEvent, AsrProvider, AsrSession, AsrStreamOptions, AudioChunk, AudioFormat, CallOptions, ModelInfo, TranscribeOptions, TranscriptResult, TtsOptions, TtsProvider, TtsResult, UsageReport, VoiceInfo, WordTiming } from "../types.ts";
import { AsyncQueue, fromBase64, pcm16Seconds, pcm16ToWav, textChunks, toBase64 } from "../util.ts";
import { closeError, openSocket, parseJsonFrame, upstreamProtocolError, type WsLike } from "../ws.ts";
import { KeyHolder, frameError, httpToWs, loggerOf, makeHttp, trimBase, type CloudDeps } from "./common.ts";

export interface ElevenLabsOptions extends CloudDeps {
  /** Secret reference (never the key itself). */
  apiKeyRef: string | undefined;
  baseUrl?: string;
  /** Data-residency region key: default | us | eu | in (see constants). Ignored when baseUrl is set. */
  region?: string;
  defaultVoice?: string;
  defaultModel?: string;
  defaultSttModel?: string;
  /** Ask the vendor not to log or retain content (enable_logging=false). */
  zeroRetention?: boolean;
}

export interface ElevenLabs { tts: TtsProvider; asr: AsrProvider }
const ID = "elevenlabs";

export function createElevenLabs(o: ElevenLabsOptions): ElevenLabs {
  const keys = new KeyHolder(o.getSecret, o.apiKeyRef, ID);
  const http = makeHttp(ID, o, keys);
  const log = loggerOf(o);
  const base = trimBase(o.baseUrl ?? `https://${ELEVENLABS.hosts[o.region ?? "default"] ?? ELEVENLABS.hosts["default"]}`);
  const wsBase = httpToWs(base);
  const query = (params: Record<string, string | undefined>, retention = true): string => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, v);
    if (retention && o.zeroRetention) p.set(ELEVENLABS.zeroRetentionParam[0], ELEVENLABS.zeroRetentionParam[1]);
    const s = p.toString();
    return s === "" ? "" : `?${s}`;
  };
  const report = (r: UsageReport) => { o.usage?.(r); };

  function resolveFormat(opt: TtsOptions): { format: AudioFormat; rate: number; param: string } {
    const format = opt.format ?? "pcm16";
    const rate = opt.sampleRate ?? (format === "opus" ? 48000 : ELEVENLABS.defaultSampleRate);
    const param = ELEVENLABS.outputFormat(format, rate);
    if (!param) throw new VoiceProviderError("unsupported", `${ID}: ${format} at ${rate} Hz is not offered`, { provider: ID });
    return { format, rate, param };
  }
  function voiceOf(opt: TtsOptions): string {
    const v = opt.voice ?? o.defaultVoice;
    if (!v) throw new VoiceProviderError("invalid_request", `${ID}: no voice given and no defaultVoice configured`, { provider: ID });
    return v;
  }
  const modelOf = (opt: TtsOptions): string => opt.model ?? o.defaultModel ?? ELEVENLABS.defaultTtsModel;

  async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { [ELEVENLABS.headerKey]: await keys.get(), ...extra };
  }

  const tts: TtsProvider = {
    id: ID,
    kind: "tts",
    textInputStreaming: true,
    formats: ["pcm16", "mp3", "opus"],

    async synthesize(text, options = {}) {
      const { format, rate, param } = resolveFormat(options);
      const voice = voiceOf(options);
      const body = { text, model_id: modelOf(options), ...(options.voiceSettings ? { voice_settings: options.voiceSettings } : {}), ...(options.language ? { language_code: options.language } : {}) };
      const res = await http.request(`${base}${ELEVENLABS.paths.ttsHttp(voice)}${query({ output_format: param })}`, {
        method: "POST", headers: await authHeaders({ "content-type": "application/json", accept: "audio/*" }), body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}),
      });
      const data = new Uint8Array(await res.arrayBuffer());
      const usage: UsageReport = { provider: ID, operation: "tts", model: modelOf(options), chars: text.length };
      report(usage);
      return { data, format, sampleRate: rate, usage } satisfies TtsResult;
    },

    synthesizeStream(input, options = {}) {
      return typeof input === "string" ? httpStream(input, options) : socketStream(input, options);
    },

    async listVoices(options = {}) {
      const out: VoiceInfo[] = [];
      let token: string | undefined;
      for (let page = 0; page < 20; page++) {
        const j = await http.json<{ voices?: Array<Record<string, any>>; has_more?: boolean; next_page_token?: string }>(`${base}${ELEVENLABS.paths.voices}${query({ page_size: "100", next_page_token: token }, false)}`, { headers: await authHeaders(), ...(options.signal ? { signal: options.signal } : {}) });
        for (const v of j.voices ?? []) {
          if (typeof v["voice_id"] !== "string") continue;
          const langs = [...(Array.isArray(v["verified_languages"]) ? v["verified_languages"].map((l: any) => l?.language) : []), v["labels"]?.language].filter((x): x is string => typeof x === "string");
          out.push({ id: v["voice_id"], name: String(v["name"] ?? v["voice_id"]), ...(langs.length ? { languages: [...new Set(langs)] } : {}), ...(typeof v["labels"]?.gender === "string" ? { gender: v["labels"].gender } : {}), ...(typeof v["preview_url"] === "string" ? { previewUrl: v["preview_url"] } : {}) });
        }
        if (!j.has_more || !j.next_page_token) break;
        token = j.next_page_token;
      }
      return out;
    },

    async listModels(options = {}) {
      return (await listAllModels(options)).filter((m) => m.capabilities.includes("tts"));
    },
  };

  async function listAllModels(options: CallOptions): Promise<ModelInfo[]> {
    const j = await http.json<Array<Record<string, any>>>(`${base}${ELEVENLABS.paths.models}`, { headers: await authHeaders(), ...(options.signal ? { signal: options.signal } : {}) });
    if (!Array.isArray(j)) throw new VoiceProviderError("bad_response", `${ID}: models response is not a list`, { provider: ID });
    return j.filter((m) => typeof m?.["model_id"] === "string").map((m) => {
      const id = String(m["model_id"]);
      const caps: string[] = [];
      if (m["can_do_text_to_speech"]) caps.push("tts");
      if (m["can_do_voice_conversion"]) caps.push("voice-conversion");
      if (/^scribe/.test(id)) caps.push("asr");
      const langs = Array.isArray(m["languages"]) ? m["languages"].map((l: any) => l?.language_id).filter((x: unknown): x is string => typeof x === "string") : [];
      return { id, name: String(m["name"] ?? id), capabilities: caps, ...(langs.length ? { languages: langs } : {}) };
    });
  }

  async function* httpStream(text: string, options: TtsOptions): AsyncGenerator<AudioChunk> {
    const { format, rate, param } = resolveFormat(options);
    const voice = voiceOf(options);
    const res = await http.request(`${base}${ELEVENLABS.paths.ttsHttp(voice)}/stream${query({ output_format: param })}`, {
      method: "POST", headers: await authHeaders({ "content-type": "application/json", accept: "audio/*" }), body: JSON.stringify({ text, model_id: modelOf(options), ...(options.voiceSettings ? { voice_settings: options.voiceSettings } : {}) }), ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!res.body) throw new VoiceProviderError("bad_response", `${ID}: empty stream body`, { provider: ID });
    const reader = res.body.getReader();
    try {
      for (;;) {
        if (options.signal?.aborted) throw abortedError(ID);
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) yield { data: value, format, sampleRate: rate };
      }
    } catch (e) {
      if (options.signal?.aborted) throw abortedError(ID);
      throw e;
    } finally {
      await reader.cancel().catch(() => {});
    }
    report({ provider: ID, operation: "tts", model: modelOf(options), chars: text.length });
  }

  async function* socketStream(input: AsyncIterable<string>, options: TtsOptions): AsyncGenerator<AudioChunk> {
    const { format, rate, param } = resolveFormat(options);
    const voice = voiceOf(options);
    const url = `${wsBase}${ELEVENLABS.paths.ttsStreamInput(voice)}${query({ model_id: modelOf(options), output_format: param, language_code: options.language })}`;
    const ws = await openSocket({ provider: ID, url, headers: await authHeaders(), ...(o.wsFactory ? { factory: o.wsFactory } : {}), ...(options.signal ? { signal: options.signal } : {}), secrets: keys.secrets });
    const q = new AsyncQueue<AudioChunk>();
    let chars = 0;
    let finished = false;
    ws.addEventListener("message", (ev) => {
      try {
        const f = parseJsonFrame(ev.data, ID);
        if (f["error"] !== undefined || f["message_type"] === "error") { q.fail(frameError(ID, f, keys.secrets)); return; }
        if (typeof f["audio"] === "string" && f["audio"] !== "") q.push({ data: fromBase64(f["audio"]), format, sampleRate: rate });
        if (f["isFinal"] === true) { finished = true; q.end(); }
      } catch {
        // A frame we cannot use ends the stream with one protocol error; the socket is closed, nothing escapes.
        q.fail(upstreamProtocolError(ID));
        try { ws.close(1002, "protocol error"); } catch { /* closed */ }
      }
    });
    ws.addEventListener("close", (ev) => { if (!finished) q.fail(ev.code === 1000 || ev.code === 1005 || ev.code === 1001 ? new VoiceProviderError("network", `${ID}: socket closed before the stream finished`, { provider: ID }) : closeError(ID, ev.code)); });
    ws.addEventListener("error", () => q.fail(new VoiceProviderError("network", `${ID}: socket error`, { provider: ID })));
    const onAbort = () => { q.fail(abortedError(ID)); try { ws.close(1000, "aborted"); } catch { /* closed */ } };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      ws.send(JSON.stringify({ text: " ", ...(options.voiceSettings ? { voice_settings: options.voiceSettings } : {}), generation_config: { chunk_length_schedule: ELEVENLABS.chunkLengthSchedule } }));
      const pump = (async () => {
        for await (const chunk of textChunks(input)) {
          if (chunk === "") continue;
          chars += chunk.length;
          ws.send(JSON.stringify({ text: chunk.endsWith(" ") ? chunk : `${chunk} ` }));
        }
        // End of the turn: force the buffered text out, then close the input side.
        ws.send(JSON.stringify({ text: " ", flush: true }));
        ws.send(JSON.stringify({ text: "" }));
      })().catch((e) => q.fail(e));
      for await (const chunk of q) yield chunk;
      await pump;
      report({ provider: ID, operation: "tts", model: modelOf(options), chars });
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      try { ws.close(1000, "done"); } catch { /* closed */ }
    }
  }

  const asr: AsrProvider = {
    id: ID,
    kind: "asr",

    async transcribe(audio, options: TranscribeOptions = {}): Promise<TranscriptResult> {
      if (audio.format !== "pcm16") throw new VoiceProviderError("unsupported", `${ID}: batch transcription takes pcm16 input here`, { provider: ID });
      const model = options.model ?? o.defaultSttModel ?? ELEVENLABS.defaultSttModel;
      const form = new FormData();
      form.set("model_id", model);
      if (options.language) form.set("language_code", options.language);
      if (options.timestamps) form.set("timestamps_granularity", "word");
      form.set("file", new Blob([pcm16ToWav(audio.data, audio.sampleRate) as BlobPart], { type: "audio/wav" }), "audio.wav");
      const j = await http.json<Record<string, any>>(`${base}${ELEVENLABS.paths.sttHttp}${query({})}`, { method: "POST", headers: await authHeaders(), body: form, ...(options.signal ? { signal: options.signal } : {}) });
      if (typeof j["text"] !== "string") throw new VoiceProviderError("bad_response", `${ID}: transcript missing`, { provider: ID });
      const words = options.timestamps ? wordsOf(j["words"]) : undefined;
      const usage: UsageReport = { provider: ID, operation: "asr", model, seconds: pcm16Seconds(audio.data.byteLength, audio.sampleRate) };
      report(usage);
      return { text: j["text"], ...(typeof j["language_code"] === "string" ? { language: j["language_code"] } : {}), ...(words ? { words } : {}), usage };
    },

    async openStream(options: AsrStreamOptions = {}): Promise<AsrSession> {
      const model = options.model ?? ELEVENLABS.defaultRealtimeSttModel;
      const rate = options.sampleRate ?? 16000;
      const url = `${wsBase}${ELEVENLABS.paths.sttRealtime}${query({ model_id: model, audio_format: `pcm_${rate}`, language_code: options.language, commit_strategy: "manual", include_timestamps: options.timestamps ? "true" : undefined })}`;
      const ws = await openSocket({ provider: ID, url, headers: await authHeaders(), ...(o.wsFactory ? { factory: o.wsFactory } : {}), ...(options.signal ? { signal: options.signal } : {}), secrets: keys.secrets });
      return new ElevenLabsAsrSession(ws, rate, model, keys.secrets, report, options.timestamps === true, options.signal);
    },

    async listModels(options = {}) {
      const all = await listAllModels(options);
      const asrModels = all.filter((m) => m.capabilities.includes("asr"));
      return asrModels.length > 0 ? asrModels : [{ id: o.defaultSttModel ?? ELEVENLABS.defaultSttModel, name: o.defaultSttModel ?? ELEVENLABS.defaultSttModel, capabilities: ["asr"] }];
    },
  };

  log.debug("elevenlabs ready", { host: hostOf(base), zeroRetention: o.zeroRetention === true });
  return { tts, asr };
}

/** Host only: a baseUrl may carry userinfo or a path that must not reach a log line. */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return "invalid-url"; }
}

function wordsOf(raw: unknown): WordTiming[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((w) => w && typeof w.text === "string" && (w.type === undefined || w.type === "word")).map((w) => ({ text: String(w.text), startMs: Math.round(Number(w.start ?? 0) * 1000), endMs: Math.round(Number(w.end ?? 0) * 1000) }));
}

class ElevenLabsAsrSession implements AsrSession {
  readonly events: AsyncIterable<AsrEvent>;
  private readonly q = new AsyncQueue<AsrEvent>();
  private readonly ws: WsLike;
  private readonly rate: number;
  private ready = false;
  private pending: string[] = [];
  private bytes = 0;
  private closed = false;
  private closing = false;
  private readonly wantTimestamps: boolean;
  private failed = false;

  constructor(ws: WsLike, rate: number, model: string, secrets: readonly string[], report: (r: UsageReport) => void, wantTimestamps: boolean, signal: AbortSignal | undefined) {
    this.ws = ws;
    this.rate = rate;
    this.events = this.q;
    this.wantTimestamps = wantTimestamps;
    ws.addEventListener("message", (ev) => {
      if (this.failed) return;
      try { this.onFrame(parseJsonFrame(ev.data, ID), secrets); } catch {
        // One protocol error, then a clean close: a hostile frame never escapes into the socket's data handler.
        this.failed = true;
        this.closing = true;
        this.q.push({ type: "error", error: upstreamProtocolError(ID) });
        try { this.ws.close(1002, "protocol error"); } catch { /* closed */ }
      }
    });
    ws.addEventListener("close", (ev) => {
      if (!this.closed) { try { report({ provider: ID, operation: "asr", model, seconds: pcm16Seconds(this.bytes, this.rate) }); } catch { /* usage sink */ } }
      this.closed = true;
      if (!this.closing && !this.failed && ev.code !== 1000 && ev.code !== 1005 && ev.code !== 1001) this.q.push({ type: "error", error: closeError(ID, ev.code) });
      this.q.push({ type: "closed" });
      this.q.end();
    });
    ws.addEventListener("error", () => this.q.push({ type: "error", error: new VoiceProviderError("network", `${ID}: socket error`, { provider: ID }) }));
    signal?.addEventListener("abort", () => { this.q.push({ type: "error", error: abortedError(ID) }); void this.close(); }, { once: true });
  }

  private onFrame(f: Record<string, unknown>, secrets: readonly string[]): void {
    const t = f["message_type"];
    if (t === "session_started") { this.ready = true; for (const p of this.pending) this.ws.send(p); this.pending = []; this.q.push({ type: "ready" }); }
    else if (t === "partial_transcript") this.q.push({ type: "partial", text: String(f["text"] ?? "") });
    else if (t === "committed_transcript" && !this.wantTimestamps) this.q.push({ type: "final", text: String(f["text"] ?? "") });
    else if (t === "committed_transcript_with_timestamps") {
      const words = wordsOf(f["words"]);
      this.q.push({ type: "final", text: String(f["text"] ?? ""), ...(typeof f["language_code"] === "string" ? { language: f["language_code"] } : {}), ...(words ? { words } : {}) });
    } else if (typeof t === "string" && /error|exceeded|limit|quota|throttl|overflow|invalid|exhausted|unaccepted/.test(t)) this.q.push({ type: "error", error: frameError(ID, f, secrets) });
  }

  private send(frame: Record<string, unknown>): void {
    if (this.closed || this.closing || this.failed) throw new VoiceProviderError("closed", `${ID}: session is closed`, { provider: ID });
    const text = JSON.stringify(frame);
    if (this.ready) this.ws.send(text);
    else this.pending.push(text);
  }
  sendAudio(pcm: Uint8Array): void {
    this.bytes += pcm.byteLength;
    this.send({ message_type: "input_audio_chunk", audio_base_64: toBase64(pcm), commit: false, sample_rate: this.rate });
  }
  commit(): void {
    this.send({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: this.rate });
  }
  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    try { this.ws.close(1000, "done"); } catch { /* already closed */ }
  }
}
