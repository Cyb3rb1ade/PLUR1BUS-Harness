import { VoiceProviderError } from "../errors.ts";
import type { HttpClient, FetchLike, Sleep } from "../http.ts";
import { HttpClient as Http } from "../http.ts";
import { SentenceChunker } from "../realtime/chunker.ts";
import { resolveSecret } from "../secret.ts";
import type { AudioChunk, GetSecret, Logger, UsageSink } from "../types.ts";
import { noopLogger } from "../types.ts";
import type { WsFactory } from "../ws.ts";

/** Everything a cloud provider constructor takes besides its own settings. All injectable for tests. */
export interface CloudDeps {
  getSecret: GetSecret;
  fetch?: FetchLike;
  wsFactory?: WsFactory;
  sleep?: Sleep;
  now?: () => number;
  usage?: UsageSink;
  logger?: Logger;
  retries?: number;
}

/** Resolves the API key on demand from a secret reference and remembers it only to scrub it from errors. */
export class KeyHolder {
  readonly secrets: string[] = [];
  private readonly getSecret: GetSecret;
  private readonly ref: string | undefined;
  private readonly provider: string;
  constructor(getSecret: GetSecret, ref: string | undefined, provider: string) {
    this.getSecret = getSecret;
    this.ref = ref;
    this.provider = provider;
  }
  async get(): Promise<string> {
    const key = await resolveSecret(this.getSecret, this.ref, this.provider);
    if (!this.secrets.includes(key)) this.secrets.push(key);
    return key;
  }
}

export function makeHttp(provider: string, deps: CloudDeps, keys: KeyHolder): HttpClient {
  return new Http({
    provider,
    secrets: keys.secrets,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.retries !== undefined ? { retries: deps.retries } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}

export function loggerOf(deps: CloudDeps): Logger {
  return deps.logger ?? noopLogger;
}

/** Strip a trailing slash. */
export function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

export function httpToWs(url: string): string {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

/**
 * Text-input streaming for vendors that only take whole requests: sentence-chunk the incoming text and synthesize each
 * chunk in order. The flush at end of input releases the last partial sentence.
 */
export async function* chunkedSynthesis(input: AsyncIterable<string>, synth: (sentence: string) => Promise<AudioChunk[]>, maxWords?: number): AsyncGenerator<AudioChunk> {
  const chunker = new SentenceChunker(maxWords !== undefined ? { maxWords } : {});
  for await (const delta of input) {
    for (const sentence of chunker.push(delta)) for (const a of await synth(sentence)) yield a;
  }
  for (const sentence of chunker.flush()) for (const a of await synth(sentence)) yield a;
}

/** Vendor error text inside a socket frame -> unified error. Matches on well-known tokens, never echoes the frame. */
export function frameError(provider: string, frame: Record<string, unknown>, secrets: readonly string[]): VoiceProviderError {
  const raw = `${String(frame["error"] ?? "")} ${String(frame["type"] ?? "")} ${String(frame["message_type"] ?? "")} ${String(frame["code"] ?? "")} ${typeof frame["message"] === "string" ? frame["message"] : ""}`.toLowerCase();
  if (/unauthor|auth|invalid_api_key|api key|permission|forbidden/.test(raw)) return new VoiceProviderError("auth", `${provider}: authentication failed`, { provider, secrets });
  if (/rate|quota|too_many|resource_exhausted|limit/.test(raw)) return new VoiceProviderError("rate_limited", `${provider}: rate limited or quota exceeded`, { provider, secrets });
  if (/invalid|input_error|bad_request|not_found|unsupported/.test(raw)) return new VoiceProviderError("invalid_request", `${provider}: request refused by the service`, { provider, secrets });
  return new VoiceProviderError("bad_response", `${provider}: service reported an error`, { provider, secrets });
}
