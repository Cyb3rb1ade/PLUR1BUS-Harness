// Amazon Polly TTS through the AWS SDK v3 default credential chain (profile, SSO, env, instance role). No plaintext
// key ever goes through config: the options carry a profile NAME at most. The SDK packages are optional peer
// dependencies loaded lazily; tests (and hosts that bundle their own client) inject `clientFactory`.
import { POLLY } from "../constants.ts";
import { VoiceProviderError, abortedError } from "../errors.ts";
import type { AudioChunk, AudioFormat, ModelInfo, TtsOptions, TtsProvider, UsageReport, VoiceInfo } from "../types.ts";
import { concatBytes } from "../util.ts";
import { chunkedSynthesis } from "./common.ts";
import type { CloudDeps } from "./common.ts";
import { textChunks } from "../util.ts";

/** The slice of the Polly client this provider needs, so a fake can stand in for the SDK. */
export interface PollyClientLike {
  synthesize(input: { Text: string; VoiceId: string; Engine?: string; OutputFormat: "pcm" | "mp3"; SampleRate: string; LanguageCode?: string; TextType?: "text" | "ssml" }, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array> | Uint8Array>;
  describeVoices(input: { Engine?: string; LanguageCode?: string; NextToken?: string }, signal?: AbortSignal): Promise<{ Voices?: Array<{ Id?: string; Name?: string; Gender?: string; LanguageCode?: string; AdditionalLanguageCodes?: string[]; SupportedEngines?: string[] }>; NextToken?: string }>;
}

export interface PollyOptions extends Pick<CloudDeps, "usage" | "logger"> {
  region?: string;
  /** AWS shared-config profile name (not a secret). Absent: the default chain. */
  profile?: string;
  defaultVoice?: string;
  /** Polly engine: standard | neural | long-form | generative. */
  defaultModel?: string;
  /** Test seam or host-provided client. */
  clientFactory?: () => Promise<PollyClientLike>;
  /** Cap words per request when text arrives as a stream. */
  maxWords?: number;
}
const ID = "polly";

export function createPolly(o: PollyOptions): TtsProvider {
  let clientP: Promise<PollyClientLike> | undefined;
  const client = (): Promise<PollyClientLike> => (clientP ??= (o.clientFactory ?? (() => loadSdkClient(o)))().catch((e) => { clientP = undefined; throw e; }));

  function resolve(options: TtsOptions): { format: "pcm" | "mp3"; out: AudioFormat; rate: number; voice: string; engine: string } {
    const out = options.format ?? "pcm16";
    if (out === "opus") throw new VoiceProviderError("unsupported", `${ID}: Polly has no Opus output (formats: pcm16, mp3)`, { provider: ID });
    const rate = options.sampleRate ?? POLLY.defaultSampleRate;
    const allowed = out === "pcm16" ? POLLY.pcmRates : POLLY.mp3Rates;
    if (!allowed.includes(rate)) throw new VoiceProviderError("unsupported", `${ID}: ${out} supports ${allowed.join(", ")} Hz`, { provider: ID });
    const voice = options.voice ?? o.defaultVoice;
    if (!voice) throw new VoiceProviderError("invalid_request", `${ID}: no voice given and no defaultVoice configured`, { provider: ID });
    return { format: out === "pcm16" ? "pcm" : "mp3", out, rate, voice, engine: options.model ?? o.defaultModel ?? POLLY.defaultEngine };
  }

  async function bytes(r: AsyncIterable<Uint8Array> | Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    if (r instanceof Uint8Array) return r;
    const parts: Uint8Array[] = [];
    for await (const p of r) {
      if (signal?.aborted) throw abortedError(ID);
      parts.push(p);
    }
    return concatBytes(parts);
  }

  async function one(text: string, options: TtsOptions) {
    if (options.signal?.aborted) throw abortedError(ID);
    if (text.length > POLLY.maxTextChars) throw new VoiceProviderError("invalid_request", `${ID}: text over ${POLLY.maxTextChars} characters; stream it as chunks`, { provider: ID });
    const r = resolve(options);
    let audio: Uint8Array;
    try {
      audio = await bytes(await (await client()).synthesize({ Text: text, VoiceId: r.voice, Engine: r.engine, OutputFormat: r.format, SampleRate: String(r.rate), ...(options.language ? { LanguageCode: options.language } : {}) }, options.signal), options.signal);
    } catch (e) {
      throw mapAwsError(e, options.signal);
    }
    const usage: UsageReport = { provider: ID, operation: "tts", model: r.engine, chars: text.length };
    o.usage?.(usage);
    return { audio: { data: audio, format: r.out, sampleRate: r.rate } as AudioChunk, usage };
  }

  return {
    id: ID,
    kind: "tts",
    textInputStreaming: false,
    formats: ["pcm16", "mp3"],
    async synthesize(text, options = {}) {
      const { audio, usage } = await one(text, options);
      return { ...audio, usage };
    },
    async *synthesizeStream(input, options = {}) {
      // Polly takes whole requests, so text is sentence-chunked and each sentence is one call.
      yield* chunkedSynthesis(textChunks(input), async (sentence) => [(await one(sentence, options)).audio], o.maxWords);
    },
    async listVoices(options = {}) {
      const c = await client();
      const out: VoiceInfo[] = [];
      let token: string | undefined;
      try {
        for (let page = 0; page < 20; page++) {
          const r = await c.describeVoices({ ...(token ? { NextToken: token } : {}) }, options.signal);
          for (const v of r.Voices ?? []) {
            if (!v.Id) continue;
            const langs = [v.LanguageCode, ...(v.AdditionalLanguageCodes ?? [])].filter((x): x is string => !!x);
            out.push({ id: v.Id, name: v.Name ?? v.Id, ...(langs.length ? { languages: langs } : {}), ...(v.Gender ? { gender: v.Gender } : {}), ...(v.SupportedEngines?.length ? { engines: v.SupportedEngines } : {}) });
          }
          if (!r.NextToken) break;
          token = r.NextToken;
        }
      } catch (e) {
        throw mapAwsError(e, options.signal);
      }
      return out;
    },
    /** Polly's "models" are its engines; they come from the voices' SupportedEngines. */
    async listModels(options = {}): Promise<ModelInfo[]> {
      const engines = new Set<string>();
      for (const v of await this.listVoices(options)) for (const e of v.engines ?? []) engines.add(e);
      return [...engines].sort().map((id) => ({ id, name: id, capabilities: ["tts"] }));
    },
  };
}

/** Map AWS SDK errors (by name and HTTP status) onto the unified codes. The SDK message may name resources; it is not echoed. */
export function mapAwsError(e: unknown, signal?: AbortSignal): VoiceProviderError {
  if (e instanceof VoiceProviderError) return e;
  if (signal?.aborted) return abortedError(ID);
  const name = (e as { name?: string })?.name ?? "";
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const init = { provider: ID, ...(status !== undefined ? { status } : {}) };
  if (/AbortError/.test(name)) return abortedError(ID);
  if (/CredentialsProviderError|ExpiredToken|UnrecognizedClient|InvalidSignature|AccessDenied|SignatureDoesNotMatch|UnauthorizedException|NotAuthorized/.test(name) || status === 401 || status === 403) return new VoiceProviderError("auth", `${ID}: AWS credentials missing, expired or not allowed (${name || status})`, init);
  if (/Throttl|TooManyRequests|LimitExceeded/.test(name) || status === 429) return new VoiceProviderError("rate_limited", `${ID}: throttled by AWS`, init);
  if (/ServiceFailure|ServiceUnavailable|InternalFailure/.test(name) || (status !== undefined && status >= 500)) return new VoiceProviderError("overloaded", `${ID}: AWS service error`, init);
  if (/Validation|InvalidSsml|InvalidSampleRate|TextLengthExceeded|VoiceNotFound|LanguageNotSupported|EngineNotSupported|SsmlMarksNotSupported|InvalidParameter/.test(name) || status === 400) return new VoiceProviderError("invalid_request", `${ID}: request refused (${name || status})`, init);
  if (/Timeout/.test(name)) return new VoiceProviderError("timeout", `${ID}: AWS request timed out`, init);
  return new VoiceProviderError("network", `${ID}: AWS request failed (${name || "error"})`, init);
}

async function loadSdkClient(o: PollyOptions): Promise<PollyClientLike> {
  let sdk: any;
  try {
    // Optional peers: resolved at call time so the package works (and typechecks) without them installed.
    const spec = "@aws-sdk/client-polly";
    sdk = await import(/* @vite-ignore */ spec);
  } catch {
    throw new VoiceProviderError("unavailable", `${ID}: @aws-sdk/client-polly is not installed (optional peer dependency)`, { provider: ID });
  }
  let credentials: unknown;
  if (o.profile) {
    try {
      const spec = "@aws-sdk/credential-providers";
      const cp: any = await import(/* @vite-ignore */ spec);
      credentials = cp.fromIni({ profile: o.profile });
    } catch {
      throw new VoiceProviderError("unavailable", `${ID}: @aws-sdk/credential-providers is needed to use a named profile`, { provider: ID });
    }
  }
  const raw = new sdk.PollyClient({ ...(o.region ? { region: o.region } : {}), ...(credentials ? { credentials } : {}) });
  return {
    async synthesize(input, signal) {
      const r = await raw.send(new sdk.SynthesizeSpeechCommand(input), signal ? { abortSignal: signal } : undefined);
      if (!r.AudioStream) throw new VoiceProviderError("bad_response", `${ID}: no audio stream`, { provider: ID });
      return r.AudioStream as AsyncIterable<Uint8Array>;
    },
    describeVoices: (input, signal) => raw.send(new sdk.DescribeVoicesCommand(input), signal ? { abortSignal: signal } : undefined),
  };
}
