// Public types of the Gemini adapter (Google Generative Language API, `generateContent` / `streamGenerateContent`).
// The request/result vocabulary is the chat_completions adapter's (../types.ts): callers switch providers by
// switching the factory, not the types. Only what is Gemini-specific lives here.

import type { ProviderErrorInit } from "../errors.ts";
import type { CallOptions, ChatRequest, ChatResult, ChatStreamEvent, Limits, Timeouts } from "../types.ts";

/**
 * Where the API key comes from, per call. Structurally satisfied by the core `SecretStore` bound to one ref (see
 * `secretStoreKey`), so the adapter never sees a config file or an environment variable and never keeps the key
 * beyond one call.
 */
export interface GeminiCredentials {
  apiKey(ctx: { signal: AbortSignal }): Promise<string | undefined> | string | undefined;
}

/** The read side of the secret store (`get(ref)` of `packages/core/src/auth/secret-store.ts`), as a port. */
export interface SecretReader {
  get(ref: string): Promise<string | undefined>;
}

export interface GeminiConfig {
  /** Default `https://generativelanguage.googleapis.com/v1beta`; `/models/{model}:generateContent` is appended. */
  baseUrl?: string;
  credentials: GeminiCredentials;
  /** Extra headers; may not carry the key, content or routing headers. */
  headers?: Record<string, string>;
  timeouts?: Partial<Timeouts>;
  /** Send the key over plain `http:` to a non-loopback host. Default false. */
  allowInsecureHttp?: boolean;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  limits?: Partial<Limits>;
}

export interface GeminiAdapter {
  /** `generateContent`. */
  complete(request: ChatRequest, options?: CallOptions): Promise<ChatResult>;
  /** `streamGenerateContent?alt=sse`; the last event is `done`. Stopping iteration early cancels the request. */
  stream(request: ChatRequest, options?: CallOptions): AsyncGenerator<ChatStreamEvent, void, void>;
}

export type GeminiBlockSource = "prompt" | "candidate";

export interface GeminiSafetyRating {
  category: string;
  probability: string;
  blocked?: boolean;
}

export interface GeminiSafetyInit extends ProviderErrorInit {
  source: GeminiBlockSource;
  /** `promptFeedback.blockReason` (prompt) or the candidate's `finishReason` (candidate), verbatim. */
  reason: string;
  ratings: GeminiSafetyRating[];
}
