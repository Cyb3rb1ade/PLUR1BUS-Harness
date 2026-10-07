// The public contracts (G1). Everything the rest of the harness will depend on is in this file.

/** `query` for the text a search is about, `document` for the text being stored; providers embed them asymmetrically. */
export type InputType = "query" | "document";

/**
 * What defines the vector space an adapter produces (ADR-006 "Embedding identity"). `maxBatch` is operational and is
 * not part of the identity hash (see identity.ts); it is here because callers size their work with it.
 */
export interface EmbeddingIdentity {
  provider: string;
  model: string;
  /** Pinned revision, or for aggregators the pinned upstream (`upstream:<name>`). */
  revision?: string;
  dimensions: number;
  /** Whether this adapter returns L2-normalised vectors. */
  normalize: boolean;
  maxBatch: number;
  maxInputTokens: number;
  /** Client-side prefix scheme for models that need one (e5 style); part of the vector space. */
  queryPrefix?: string;
  passagePrefix?: string;
}

export interface EmbedOptions {
  inputType: InputType;
  signal?: AbortSignal;
}

export interface EmbeddingAdapter {
  readonly id: string;
  /** Deterministic: the same configuration always reports the same identity. */
  identity(): EmbeddingIdentity;
  /** One vector per input, in input order. Throws AdapterError only. */
  embed(texts: readonly string[], opts: EmbedOptions): Promise<Float32Array[]>;
}

export interface RerankOptions {
  /** Defaults to all documents. */
  topN?: number;
  signal?: AbortSignal;
}

export interface RerankResult {
  /** Index into the documents that were passed in. */
  index: number;
  score: number;
}

export interface RerankAdapter {
  readonly id: string;
  /** Best first. Scores are only comparable within one reranker and one call. Throws AdapterError only. */
  rerank(query: string, docs: readonly string[], opts?: RerankOptions): Promise<RerankResult[]>;
}

/** Secrets are resolved through this injected function only; an adapter never reads process.env. */
export type GetSecret = (name: string) => string | undefined | Promise<string | undefined>;

export interface AdapterDeps {
  getSecret: GetSecret;
  /** Defaults to global fetch. Tests inject a fixture fetch. */
  fetch?: typeof fetch;
  /** Defaults to a timer that honours the abort signal. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Uniform in [0, 1). Defaults to Math.random. */
  random?: () => number;
  /** Defaults to Date.now. */
  now?: () => number;
}

export interface ResolvedDeps {
  getSecret: GetSecret;
  fetch: typeof fetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  now: () => number;
}
