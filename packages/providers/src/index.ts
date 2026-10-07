/**
 * Public surface of `@plur1bus/providers`. Everything not listed here is internal.
 *
 * - Errors: one taxonomy (`ProviderErrorKind`) for every adapter; `ProviderError` is the only error adapters throw.
 * - Adapters: `createChatCompletionsAdapter` (OpenAI-compatible wire, also used for Ollama / LM Studio through
 *   `createLocalChatAdapter`) and `createGeminiAdapter`. All implement the streaming contract in `types.ts`.
 * - Router: `ProviderRouter` (profiles → ordered candidates, fail-closed fallback, per provider+model circuit breaker,
 *   jittered backoff), and `profiles/` which resolves the config's `modelProfiles` into a router.
 * - Local models: discovery, availability, a non-blocking monitor and a guard that fails fast on a dead endpoint.
 */

// Errors
export { ProviderError, classifyHttpError, parseRetryAfter } from "./errors.ts";
export type { ProviderErrorKind, ProviderErrorInit } from "./errors.ts";

// Provider-neutral request/response/stream types (Usage fields are optional: unreported means undefined, never 0)
export type * from "./types.ts";

// chat_completions adapter and its building blocks (request validation, SSE parsing)
export { createChatCompletionsAdapter } from "./client.ts";
export { buildRequestBody, validateRequest } from "./request.ts";
export type { BuildOptions } from "./request.ts";
export { SseParser } from "./sse.ts";
export type { SseEvent } from "./sse.ts";

// Gemini adapter
export * from "./gemini/index.ts";

// Anthropic Messages adapter
export * from "./anthropic/index.ts";

// OpenAI Responses adapter (codex_responses)
export * from "./responses/index.ts";

// Router (fallback, breaker, retry)
export * from "./router/index.ts";

// modelProfiles → router
export * from "./profiles/index.ts";

// Local models (Ollama, LM Studio)
export * from "./local/index.ts";
