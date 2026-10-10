// Every vendor endpoint, path, protocol constant and default model name lives here and nowhere else. Each is
// overridable through config (baseUrl, defaultModel, defaultVoice) and, for model ids, discoverable at runtime
// (listModels / listVoices, the D42 scan). Items marked VERIFY were written from knowledge of the vendor API as of
// 2026-10 and have not been exercised against the live service: they are listed in docs/voice-providers.md under
// "verify at integration".

export const ELEVENLABS = {
  /** VERIFY: data-residency hosts. `default` is the global host. */
  hosts: {
    default: "api.elevenlabs.io",
    us: "api.us.elevenlabs.io",
    eu: "api.eu.residency.elevenlabs.io",
    in: "api.in.residency.elevenlabs.io",
    sg: "api.sg.residency.elevenlabs.io",
  } as Record<string, string>,
  paths: {
    ttsHttp: (voiceId: string) => `/v1/text-to-speech/${encodeURIComponent(voiceId)}`, // VERIFY
    ttsStreamInput: (voiceId: string) => `/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input`, // VERIFY
    voices: "/v2/voices", // VERIFY
    models: "/v1/models", // VERIFY
    sttHttp: "/v1/speech-to-text", // VERIFY
    sttRealtime: "/v1/speech-to-text/realtime", // VERIFY
  },
  headerKey: "xi-api-key",
  /** VERIFY: defaults only; config and discovery override. */
  defaultTtsModel: "eleven_flash_v2_5",
  defaultSttModel: "scribe_v2", // scribe_v1 is deprecated (docs, 2026-10)
  defaultRealtimeSttModel: "scribe_v2_realtime",
  /** VERIFY: output_format query values per (format, rate). */
  outputFormat: (format: "pcm16" | "mp3" | "opus", rate: number): string | undefined => {
    if (format === "pcm16") return [8000, 16000, 22050, 24000, 44100].includes(rate) ? `pcm_${rate}` : undefined;
    // The docs list exactly these mp3 variants: 22050 only at 32 kbit/s, 24000 only at 48, 44100 from 32 up to 192.
    if (format === "mp3") return rate === 22050 ? "mp3_22050_32" : rate === 24000 ? "mp3_24000_48" : rate === 44100 ? "mp3_44100_128" : undefined;
    if (format === "opus") return rate === 48000 ? "opus_48000_64" : undefined;
    return undefined;
  },
  /** VERIFY: query flag that disables vendor-side logging/retention. */
  zeroRetentionParam: ["enable_logging", "false"] as const,
  /** VERIFY: first-message chunk schedule for text-input streaming. */
  chunkLengthSchedule: [120, 160, 250, 290],
  defaultSampleRate: 24000,
} as const;

export const XAI = {
  baseUrl: "https://api.x.ai", // VERIFY
  realtimePath: "/v1/realtime", // VERIFY: OpenAI-realtime-shaped protocol
  modelsPath: "/v1/models", // VERIFY
  /** VERIFY: no model id is assumed; when config and discovery give none the connect call fails with a clear error. */
  defaultModel: undefined as string | undefined,
  /** Heuristic used on the /v1/models listing to pick realtime-capable entries. */
  realtimeModelPattern: /(voice|realtime|live)/i,
  inputSampleRate: 24000,
  outputSampleRate: 24000,
} as const;

export const GEMINI = {
  baseUrl: "https://generativelanguage.googleapis.com", // VERIFY
  wsHost: "wss://generativelanguage.googleapis.com", // VERIFY
  liveWsPath: "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent", // VERIFY
  modelsPath: "/v1beta/models", // VERIFY
  /** VERIFY: header for the API key on the Live WebSocket handshake and on REST calls (the query form `?key=` is the fallback). */
  headerKey: "x-goog-api-key",
  /** VERIFY: Live API model methods marker used to filter the models list. */
  liveMethod: "bidiGenerateContent",
  /** VERIFY: only a fallback; discovery picks native-audio models first. */
  defaultModel: "models/gemini-3.8-live",
  nativeAudioPattern: /native-audio|live/i,
  inputMime: "audio/pcm;rate=16000",
  outputSampleRate: 24000,
  inputSampleRate: 16000,
} as const;

export const POLLY = {
  /** Polly output rates for pcm. VERIFY against the SDK docs: pcm supports 8000 and 16000. */
  pcmRates: [8000, 16000] as readonly number[],
  mp3Rates: [8000, 16000, 22050, 24000, 44100, 48000] as readonly number[],
  defaultSampleRate: 16000,
  defaultEngine: "neural",
  /** Polly has no Opus output; ogg_vorbis is a different codec and is not offered as "opus". */
  /** 3000 billed characters per request (6000 including SSML tags, docs 2026-10); the lower figure is enforced. */
  maxTextChars: 3000,
} as const;
