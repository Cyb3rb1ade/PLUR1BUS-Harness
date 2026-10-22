// Factories (G5). Config in, adapter out; every config problem surfaces as a ConfigError with paths before any I/O.
import { ConfigError, resolveEmbeddingSettings, resolveRerankSettings, type EmbeddingConfig, type EmbeddingProviderId, type EmbeddingSettings, type RerankConfig } from "./config.ts";
import { resolveDeps } from "./deps.ts";
import { AdapterError } from "./errors.ts";
import { localOnlyDenial } from "./local-only.ts";
import { makeEmbeddingAdapter, type EmbeddingWire } from "./embedding/base.ts";
import { cohereWire } from "./embedding/cohere.ts";
import { googleWire } from "./embedding/google.ts";
import { jinaWire } from "./embedding/jina.ts";
import { ollamaWire } from "./embedding/ollama.ts";
import { openAiWire } from "./embedding/openai.ts";
import { teiWire } from "./embedding/tei.ts";
import { voyageWire } from "./embedding/voyage.ts";
import { makeRerankAdapter } from "./rerank/base.ts";
import type { AdapterDeps, EmbeddingAdapter, LocalOnlyPolicy, RerankAdapter } from "./types.ts";

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
  mtplx: openAiWire,
};

/** Refuses at construction; the returned adapter checks again before every call (the switch is live). */
function refuseAtBuild(policy: LocalOnlyPolicy | undefined, baseURL: string, path: string): void {
  const denial = localOnlyDenial(policy, baseURL);
  if (denial !== undefined) throw new ConfigError([{ path: `${path}.baseURL`, message: denial }]);
}

function refuseAtCall(policy: LocalOnlyPolicy | undefined, baseURL: string, provider: string): void {
  const denial = localOnlyDenial(policy, baseURL);
  if (denial !== undefined) throw new AdapterError("invalid_request", `refused: ${denial}`, { provider });
}

export function createEmbeddingAdapter(config: EmbeddingConfig, deps: AdapterDeps, path = "embedding"): EmbeddingAdapter {
  const settings: EmbeddingSettings = resolveEmbeddingSettings(config, path);
  const policy = deps.policy;
  refuseAtBuild(policy, settings.baseURL, path);
  const adapter = makeEmbeddingAdapter(settings, EMBEDDING_WIRES[settings.provider], resolveDeps(deps));
  if (policy === undefined) return adapter;
  return {
    id: adapter.id,
    identity: () => adapter.identity(),
    embed: async (texts, opts) => {
      refuseAtCall(policy, settings.baseURL, settings.provider);
      return adapter.embed(texts, opts);
    },
  };
}

export function createRerankAdapter(config: RerankConfig, deps: AdapterDeps, path = "rerank"): RerankAdapter {
  const settings = resolveRerankSettings(config, path);
  const policy = deps.policy;
  refuseAtBuild(policy, settings.baseURL, path);
  const adapter = makeRerankAdapter(settings, resolveDeps(deps));
  if (policy === undefined) return adapter;
  return {
    id: adapter.id,
    rerank: async (query, docs, opts) => {
      refuseAtCall(policy, settings.baseURL, settings.provider);
      return adapter.rerank(query, docs, opts);
    },
  };
}
