export type LocalDialect = "ollama" | "openai";

export type ProbeState =
  /** Reachable, at least one model listed. */
  | "ok"
  /** Reachable and well-formed, no models installed/loaded. */
  | "empty"
  /** Connection refused / host down / DNS failure. */
  | "unreachable"
  /** No answer within the time budget. */
  | "timeout"
  /** We did not talk to it: not loopback, or not allowed by the egress policy. */
  | "refused"
  /** It answered, but not like a model server (HTTP error, redirect, bad JSON, wrong shape, too large). */
  | "protocol";

export interface LocalModel {
  id: string;
}

export interface ProbeResult {
  state: ProbeState;
  /** The base URL the chat_completions adapter should use (always the OpenAI-compatible `/v1`). */
  baseUrl: string;
  /** The dialect that produced `models`; absent when nothing answered. */
  dialect?: LocalDialect;
  models: LocalModel[];
  /** Short, credential-free reason for every state but `ok`/`empty`. */
  detail?: string;
  httpStatus?: number;
}

export interface LocalCandidate {
  /** Origin, e.g. `http://127.0.0.1:11434`. A path, query or credentials are not allowed. */
  origin: string;
  /** Which model-list endpoints to try, in order. */
  dialects: LocalDialect[];
  label?: string;
}

/** Egress policy port (B4). Return true to allow a connection to `url`. */
export interface EgressPolicy {
  allow(url: string): boolean | Promise<boolean>;
}

export interface ProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Explicit opt-in for a non-loopback origin; it still needs `egress`. */
  allowNonLoopback?: boolean;
  egress?: EgressPolicy;
}
