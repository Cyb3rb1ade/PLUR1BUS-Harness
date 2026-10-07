// Live-smoke support. This is the only place that reads process.env: adapters get secrets through getSecret, so the
// tests hand them a function over this snapshot. Nothing here runs unless PLUR1BUS_LIVE_EMBED=1.
import type { EmbeddingConfig, RerankConfig, RerankProviderId } from "../../src/config.ts";

export const LIVE = process.env["PLUR1BUS_LIVE_EMBED"] === "1";
const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : undefined;
};

export const liveGetSecret = (name: string): string | undefined => env(name);

/** What to skip with, or undefined when the target is configured. The reason names the variables, never values. */
export function skipReason(...needs: string[]): string | undefined {
  if (!LIVE) return "PLUR1BUS_LIVE_EMBED=1 not set";
  const missing = needs.filter((n) => env(n) === undefined);
  return missing.length > 0 ? `${missing.join(", ")} not set` : undefined;
}

export interface LiveEmbedTarget { name: string; needs: string[]; config: () => EmbeddingConfig }
export interface LiveRerankTarget { name: RerankProviderId; needs: string[]; config: () => RerankConfig }

const num = (name: string, fallback: number): number => Number(env(name) ?? fallback);
const str = (name: string, fallback: string): string => env(name) ?? fallback;

export const EMBED_TARGETS: LiveEmbedTarget[] = [
  { name: "openai", needs: ["OPENAI_API_KEY"], config: () => ({ provider: "openai", model: str("PLUR1BUS_LIVE_OPENAI_MODEL", "text-embedding-3-small"), dimensions: num("PLUR1BUS_LIVE_OPENAI_DIMS", 256), secretName: "OPENAI_API_KEY" }) },
  { name: "google", needs: ["GEMINI_API_KEY"], config: () => ({ provider: "google", model: str("PLUR1BUS_LIVE_GOOGLE_MODEL", "gemini-embedding-001"), dimensions: num("PLUR1BUS_LIVE_GOOGLE_DIMS", 768), secretName: "GEMINI_API_KEY" }) },
  { name: "cohere", needs: ["COHERE_API_KEY"], config: () => ({ provider: "cohere", model: str("PLUR1BUS_LIVE_COHERE_MODEL", "embed-v4.0"), dimensions: num("PLUR1BUS_LIVE_COHERE_DIMS", 1536), secretName: "COHERE_API_KEY" }) },
  { name: "jina", needs: ["JINA_API_KEY"], config: () => ({ provider: "jina", model: str("PLUR1BUS_LIVE_JINA_MODEL", "jina-embeddings-v3"), dimensions: num("PLUR1BUS_LIVE_JINA_DIMS", 1024), secretName: "JINA_API_KEY" }) },
  { name: "voyage", needs: ["VOYAGE_API_KEY"], config: () => ({ provider: "voyage", model: str("PLUR1BUS_LIVE_VOYAGE_MODEL", "voyage-3"), dimensions: num("PLUR1BUS_LIVE_VOYAGE_DIMS", 1024), secretName: "VOYAGE_API_KEY" }) },
  { name: "openrouter", needs: ["OPENROUTER_API_KEY", "PLUR1BUS_LIVE_OPENROUTER_MODEL", "PLUR1BUS_LIVE_OPENROUTER_UPSTREAM", "PLUR1BUS_LIVE_OPENROUTER_DIMS"], config: () => ({ provider: "openrouter", model: str("PLUR1BUS_LIVE_OPENROUTER_MODEL", ""), dimensions: num("PLUR1BUS_LIVE_OPENROUTER_DIMS", 0), secretName: "OPENROUTER_API_KEY", pinnedUpstream: str("PLUR1BUS_LIVE_OPENROUTER_UPSTREAM", "") }) },
  { name: "ollama", needs: ["PLUR1BUS_LIVE_OLLAMA_URL"], config: () => ({ provider: "ollama", baseURL: str("PLUR1BUS_LIVE_OLLAMA_URL", ""), model: str("PLUR1BUS_LIVE_OLLAMA_MODEL", "nomic-embed-text"), dimensions: num("PLUR1BUS_LIVE_OLLAMA_DIMS", 768) }) },
  { name: "tei", needs: ["PLUR1BUS_LIVE_TEI_URL", "PLUR1BUS_LIVE_TEI_DIMS"], config: () => ({ provider: "tei", baseURL: str("PLUR1BUS_LIVE_TEI_URL", ""), model: str("PLUR1BUS_LIVE_TEI_MODEL", "tei"), dimensions: num("PLUR1BUS_LIVE_TEI_DIMS", 0) }) },
  { name: "vllm", needs: ["PLUR1BUS_LIVE_VLLM_URL", "PLUR1BUS_LIVE_VLLM_MODEL", "PLUR1BUS_LIVE_VLLM_DIMS"], config: () => ({ provider: "vllm", baseURL: str("PLUR1BUS_LIVE_VLLM_URL", ""), model: str("PLUR1BUS_LIVE_VLLM_MODEL", ""), dimensions: num("PLUR1BUS_LIVE_VLLM_DIMS", 0) }) },
  { name: "llamacpp", needs: ["PLUR1BUS_LIVE_LLAMACPP_URL", "PLUR1BUS_LIVE_LLAMACPP_DIMS"], config: () => ({ provider: "llamacpp", baseURL: str("PLUR1BUS_LIVE_LLAMACPP_URL", ""), model: str("PLUR1BUS_LIVE_LLAMACPP_MODEL", "default"), dimensions: num("PLUR1BUS_LIVE_LLAMACPP_DIMS", 0) }) },
  { name: "mtplx", needs: ["PLUR1BUS_LIVE_MTPLX_URL", "PLUR1BUS_LIVE_MTPLX_MODEL", "PLUR1BUS_LIVE_MTPLX_DIMS"], config: () => ({ provider: "mtplx", baseURL: str("PLUR1BUS_LIVE_MTPLX_URL", ""), model: str("PLUR1BUS_LIVE_MTPLX_MODEL", ""), dimensions: num("PLUR1BUS_LIVE_MTPLX_DIMS", 0) }) },
  { name: "omlx", needs: ["PLUR1BUS_LIVE_OMLX_URL", "PLUR1BUS_LIVE_OMLX_MODEL", "PLUR1BUS_LIVE_OMLX_DIMS"], config: () => ({ provider: "omlx", baseURL: str("PLUR1BUS_LIVE_OMLX_URL", ""), model: str("PLUR1BUS_LIVE_OMLX_MODEL", ""), dimensions: num("PLUR1BUS_LIVE_OMLX_DIMS", 0) }) },
];

export const RERANK_TARGETS: LiveRerankTarget[] = [
  { name: "cohere", needs: ["COHERE_API_KEY"], config: () => ({ provider: "cohere", model: str("PLUR1BUS_LIVE_COHERE_RERANK_MODEL", "rerank-v3.5"), secretName: "COHERE_API_KEY" }) },
  { name: "voyage", needs: ["VOYAGE_API_KEY"], config: () => ({ provider: "voyage", model: str("PLUR1BUS_LIVE_VOYAGE_RERANK_MODEL", "rerank-2"), secretName: "VOYAGE_API_KEY" }) },
  { name: "jina", needs: ["JINA_API_KEY"], config: () => ({ provider: "jina", model: str("PLUR1BUS_LIVE_JINA_RERANK_MODEL", "jina-reranker-v2-base-multilingual"), secretName: "JINA_API_KEY" }) },
  { name: "tei", needs: ["PLUR1BUS_LIVE_TEI_RERANK_URL"], config: () => ({ provider: "tei", baseURL: str("PLUR1BUS_LIVE_TEI_RERANK_URL", "") }) },
  { name: "vllm", needs: ["PLUR1BUS_LIVE_VLLM_RERANK_URL", "PLUR1BUS_LIVE_VLLM_RERANK_MODEL"], config: () => ({ provider: "vllm", baseURL: str("PLUR1BUS_LIVE_VLLM_RERANK_URL", ""), model: str("PLUR1BUS_LIVE_VLLM_RERANK_MODEL", "") }) },
  { name: "llamacpp", needs: ["PLUR1BUS_LIVE_LLAMACPP_RERANK_URL"], config: () => ({ provider: "llamacpp", baseURL: str("PLUR1BUS_LIVE_LLAMACPP_RERANK_URL", "") }) },
  { name: "mtplx", needs: ["PLUR1BUS_LIVE_MTPLX_RERANK_URL"], config: () => ({ provider: "mtplx", baseURL: str("PLUR1BUS_LIVE_MTPLX_RERANK_URL", ""), ...(env("PLUR1BUS_LIVE_MTPLX_RERANK_MODEL") ? { model: str("PLUR1BUS_LIVE_MTPLX_RERANK_MODEL", "") } : {}) }) },
  { name: "omlx", needs: ["PLUR1BUS_LIVE_OMLX_RERANK_URL", "PLUR1BUS_LIVE_OMLX_RERANK_MODEL"], config: () => ({ provider: "omlx", baseURL: str("PLUR1BUS_LIVE_OMLX_RERANK_URL", ""), model: str("PLUR1BUS_LIVE_OMLX_RERANK_MODEL", "") }) },
];

/**
 * Wraps fetch so a live run can report the structure of what a server actually returned. Only key names and JSON types
 * are recorded, never values, so the report is safe to paste into a PR.
 */
export function recordingFetch(base: typeof fetch = globalThis.fetch): { fetch: typeof fetch; signatures: string[] } {
  const signatures: string[] = [];
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await base(input, init);
    try {
      const text = await res.clone().text();
      signatures.push(`${res.status} ${shapeOf(JSON.parse(text))}`);
    } catch {
      signatures.push(`${res.status} <non-json>`);
    }
    return res;
  }) as typeof fetch;
  return { fetch: wrapped, signatures };
}

export function shapeOf(v: unknown, depth = 0): string {
  if (Array.isArray(v)) return `[${v.length > 0 ? shapeOf(v[0], depth + 1) : ""}]`;
  if (v === null) return "null";
  if (typeof v === "object") {
    if (depth > 3) return "{…}";
    return `{${Object.entries(v as Record<string, unknown>).slice(0, 12).map(([k, x]) => `${k}:${shapeOf(x, depth + 1)}`).join(",")}}`;
  }
  return typeof v;
}
