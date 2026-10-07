// Factories (G5). Config in, adapter out; every config problem surfaces as a ConfigError with paths before any I/O.
import { resolveEmbeddingSettings, resolveRerankSettings, type EmbeddingConfig, type EmbeddingProviderId, type EmbeddingSettings, type RerankConfig } from "./config.ts";
import { resolveDeps } from "./deps.ts";
import { makeEmbeddingAdapter, type EmbeddingWire } from "./embedding/base.ts";
import { cohereWire } from "./embedding/cohere.ts";
import { googleWire } from "./embedding/google.ts";
import { jinaWire } from "./embedding/jina.ts";
import { ollamaWire } from "./embedding/ollama.ts";
import { openAiWire } from "./embedding/openai.ts";
import { teiWire } from "./embedding/tei.ts";
import { voyageWire } from "./embedding/voyage.ts";
import { makeRerankAdapter } from "./rerank/base.ts";
import type { AdapterDeps, EmbeddingAdapter, RerankAdapter } from "./types.ts";

const EMBEDDING_WIRES: Record<EmbeddingProviderId, EmbeddingWire> = {
  openai: openAiWire,
  "openai-compatible": openAiWire,
  vllm: openAiWire,
  llamacpp: openAiWire,
  omlx: openAiWire,
  openrouter: openAiWire,
  google: googleWire,
  cohere: cohereWire,
  jina: jinaWire,
  voyage: voyageWire,
  ollama: ollamaWire,
  tei: teiWire,
};

export function createEmbeddingAdapter(config: EmbeddingConfig, deps: AdapterDeps, path = "embedding"): EmbeddingAdapter {
  const settings: EmbeddingSettings = resolveEmbeddingSettings(config, path);
  return makeEmbeddingAdapter(settings, EMBEDDING_WIRES[settings.provider], resolveDeps(deps));
}

export function createRerankAdapter(config: RerankConfig, deps: AdapterDeps, path = "rerank"): RerankAdapter {
  return makeRerankAdapter(resolveRerankSettings(config, path), resolveDeps(deps));
}
