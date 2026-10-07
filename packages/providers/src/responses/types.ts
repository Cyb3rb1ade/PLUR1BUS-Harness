// Public types of the codex_responses adapter (OpenAI Responses API, `POST {base}/responses`). The request/result
// vocabulary is the chat_completions adapter's (../types.ts); only what is Responses-specific lives here, and none of it
// touches the core `ChatRequest`.

import type { CallOptions, ChatRequest, ChatResult, ChatStreamEvent, Limits, ProviderCredentials, Timeouts, ToolArgumentRepair, Usage } from "../types.ts";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";
export type ReasoningSummary = "auto" | "concise" | "detailed";

/**
 * Which backend dialect the adapter speaks.
 * - `openai`: the OpenAI API (`https://api.openai.com/v1`), API-key auth.
 * - `chatgpt_plan`: the ChatGPT-plan (Codex) backend. It only takes stateless streaming calls: the adapter FORCES
 *   `store:false` and `stream:true` (a `complete()` call streams on the wire and collects), requires `instructions`, and
 *   REFUSES the fields that backend does not accept (`maxTokens`, `temperature`, `topP`, `store:true`). This is a switch
 *   only: no OAuth, no account headers (callers pass those through `credentials` and `headers`).
 */
export type ResponsesProfile = "openai" | "chatgpt_plan";

export interface ResponsesRequestOptions {
  reasoningEffort?: ReasoningEffort;
  /** Ask for reasoning summaries (they arrive as `reasoning_delta`s). Without it a reasoning model streams no reasoning text. */
  reasoningSummary?: ReasoningSummary;
  /** Let the provider keep the response (default false: stateless). Refused by the `chatgpt_plan` profile. */
  store?: boolean;
}

/**
 * A `ChatRequest` plus the Responses-only knobs the neutral request has no place for. Other adapters ignore
 * `providerOptions`, so one request can travel through a mixed fallback chain. Wire options live here, not in core.
 */
export interface ResponsesRequest extends ChatRequest {
  providerOptions?: { responses?: ResponsesRequestOptions };
}

export interface ResponsesConfig {
  /** Includes the version segment; default `https://api.openai.com/v1`. `/responses` is appended. */
  baseUrl?: string;
  /** A ready-made `Authorization` header value ("Bearer …"), per call: the adapter has no auth logic. */
  credentials: ProviderCredentials;
  /** Default `openai`. */
  profile?: ResponsesProfile;
  /** Defaults for requests that carry no `providerOptions.responses` value of their own. */
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: ReasoningSummary;
  /** Default false. Refused (`true`) with the `chatgpt_plan` profile. */
  store?: boolean;
  /** Extra headers; may not carry authorization, content or routing headers. */
  headers?: Record<string, string>;
  timeouts?: Partial<Timeouts>;
  repair?: ToolArgumentRepair;
  /** Send the Authorization header over plain `http:` to a non-loopback host. Default false. */
  allowInsecureHttp?: boolean;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  limits?: Partial<Limits>;
}

export interface ResponsesAdapter {
  /** Non-stream path (`stream:false`; with the `chatgpt_plan` profile it streams on the wire and collects); the same `ChatResult` as the stream path. */
  complete(request: ResponsesRequest, options?: CallOptions): Promise<ChatResult>;
  /** Stream path; the last event is `done`. Stopping iteration early cancels the request. */
  stream(request: ResponsesRequest, options?: CallOptions): AsyncGenerator<ChatStreamEvent, void, void>;
}

/** The usage of a Responses call is plain `Usage`: cached and reasoning tokens have their own fields. */
export type ResponsesUsage = Usage;
