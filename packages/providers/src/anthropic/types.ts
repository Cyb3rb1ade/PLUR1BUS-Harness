// Public types of the anthropic_messages adapter (Anthropic Messages API, `POST {base}/messages`). The request/result
// vocabulary is the chat_completions adapter's (../types.ts): callers switch providers by switching the factory, not
// the types. Only what is Anthropic-specific lives here, and none of it touches the core `ChatRequest`.

import type { CallOptions, ChatRequest, ChatResult, ChatStreamEvent, Limits, Timeouts, ToolArgumentRepair, Usage } from "../types.ts";

/**
 * Where the API key comes from, per call. Structurally the same port as `GeminiCredentials`, so `secretStoreKey(store, ref)`
 * satisfies it too: the key is read on every call and never kept by the adapter. The key goes out as `x-api-key` only.
 */
export interface AnthropicCredentials {
  apiKey(ctx: { signal: AbortSignal }): Promise<string | undefined> | string | undefined;
}

/**
 * Prompt caching: where `cache_control` markers go. Anthropic caches the prefix `tools` -> `system` -> `messages`; one
 * marker closes one cache prefix. Each flag places one marker on the LAST element of that part (at most three of the
 * four allowed breakpoints). A flag whose part is absent from the request is a no-op.
 */
export interface AnthropicCacheOptions {
  tools?: boolean;
  system?: boolean;
  /** The last content block of the last message. */
  messages?: boolean;
  /** Cache lifetime; default `"5m"` (the API default, sent as a bare `ephemeral` marker). */
  ttl?: "5m" | "1h";
}

export interface AnthropicRequestOptions {
  /** Replaces the adapter's `cache` default for this request; `{}` switches caching off for it. */
  cache?: AnthropicCacheOptions;
}

/**
 * A `ChatRequest` plus the one field Anthropic needs that the neutral request has no place for. Other adapters ignore
 * `providerOptions`, so one request can travel through a mixed fallback chain. Wire options live here, not in core.
 */
export interface AnthropicRequest extends ChatRequest {
  providerOptions?: { anthropic?: AnthropicRequestOptions };
}

export interface AnthropicConfig {
  /** Includes the version segment; default `https://api.anthropic.com/v1`. `/messages` is appended. */
  baseUrl?: string;
  credentials: AnthropicCredentials;
  /** The `anthropic-version` header. Default `2023-06-01`. */
  version?: string;
  /** `max_tokens` is mandatory on the wire; used when neither the request nor its profile sets `maxTokens`. Default 4096. */
  defaultMaxTokens?: number;
  /** Default cache markers for every request that carries no `providerOptions.anthropic.cache`. Default: none. */
  cache?: AnthropicCacheOptions;
  /** Extra headers (e.g. `anthropic-beta`); may not carry the key, the version, content or routing headers. */
  headers?: Record<string, string>;
  timeouts?: Partial<Timeouts>;
  repair?: ToolArgumentRepair;
  /** Send the key over plain `http:` to a non-loopback host. Default false. */
  allowInsecureHttp?: boolean;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  limits?: Partial<Limits>;
}

/**
 * `Usage` plus the one Anthropic count the neutral `Usage` has no field for. `inputTokens` already INCLUDES cache
 * creation and cache reads (it is the whole prompt, as for the other adapters); `cachedInputTokens` is the cache-read
 * part; `cacheCreationInputTokens` is the part written to the cache (billed at a premium).
 */
export interface AnthropicUsage extends Usage {
  cacheCreationInputTokens?: number;
}

export interface AnthropicAdapter {
  /** Non-stream path (`stream:false`); the same `ChatResult` as the stream path. */
  complete(request: AnthropicRequest, options?: CallOptions): Promise<ChatResult>;
  /** Stream path; the last event is `done`. Stopping iteration early cancels the request. */
  stream(request: AnthropicRequest, options?: CallOptions): AsyncGenerator<ChatStreamEvent, void, void>;
}
