// Public types of the Gemini adapter (Google Generative Language API, `generateContent` / `streamGenerateContent`).
// Requests, results, events and errors are the provider-neutral types of the other adapters.
import type { CallOptions, ChatRequest, ChatResult, ChatStreamEvent, Limits, Timeouts } from "../types.ts";

/**
 * The only way the adapter learns the API key. The core's secret store implements it (a lease or a read per call);
 * tests use a fake. The adapter asks on every call, never caches the value, and sends it only in `x-goog-api-key`.
 */
export interface GeminiCredentials {
  apiKey(ctx: { signal: AbortSignal }): Promise<string | undefined> | string | undefined;
}

export interface GeminiConfig {
  /** Default `https://generativelanguage.googleapis.com/v1beta`. No query, fragment or user info (a key never travels in a URL). */
  baseUrl?: string;
  credentials: GeminiCredentials;
  /** Extra headers; may not carry authorization, API-key, content or routing headers. */
  headers?: Record<string, string>;
  timeouts?: Partial<Timeouts>;
  /** Send the key over plain `http:` to a non-loopback host. Default false. */
  allowInsecureHttp?: boolean;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  limits?: Partial<Limits>;
}

export interface GeminiAdapter {
  complete(request: ChatRequest, options?: CallOptions): Promise<ChatResult>;
  /** The last event is `done`. Stopping iteration early cancels the request. */
  stream(request: ChatRequest, options?: CallOptions): AsyncGenerator<ChatStreamEvent, void, void>;
}
