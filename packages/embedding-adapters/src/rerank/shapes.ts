// The rerank wire-format mapping table (G4, ADR-006 Action 3). One row per provider: request field names and the one
// response shape this package accepts. Rows marked "unverified" are exactly the ones ADR-006 lists as unconfirmed;
// the optional live smoke (test/live) prints this table with the observed result so the rows can be frozen.
// There is no guessing: a response that does not match its provider's row is `bad_response` and names keys only.
import type { RerankProviderId, RerankSettings } from "../config.ts";
import { AdapterError } from "../errors.ts";
import type { RerankResult } from "../types.ts";

/** `source`: read from the server's own source code, not yet observed live. */
export type ShapeStatus = "verified" | "source" | "unverified";

export interface RerankShape {
  provider: RerankProviderId;
  status: ShapeStatus;
  /** Request field carrying the documents. TEI is the odd one out. */
  documentsField: "documents" | "texts";
  /** Request field limiting the result count, if the server has one. */
  topField: "top_n" | "top_k" | undefined;
  sendsModel: boolean;
  /** Where the result list lives: a named property of the response object, or `$` for a root array. */
  container: "results" | "$";
  indexKey: "index";
  scoreKey: "relevance_score" | "score";
  /** Extra fixed request fields. */
  extra: Readonly<Record<string, unknown>>;
  /** Source of the status, for the docs table. */
  basis: string;
}

export const RERANK_SHAPES: Readonly<Record<RerankProviderId, RerankShape>> = Object.freeze({
  cohere: { provider: "cohere", status: "verified", documentsField: "documents", topField: "top_n", sendsModel: true, container: "results", indexKey: "index", scoreKey: "relevance_score", extra: {}, basis: "ADR-006 table: confirmed" },
  voyage: { provider: "voyage", status: "verified", documentsField: "documents", topField: "top_k", sendsModel: true, container: "results", indexKey: "index", scoreKey: "relevance_score", extra: { truncation: false }, basis: "ADR-006 table: confirmed" },
  jina: { provider: "jina", status: "unverified", documentsField: "documents", topField: "top_n", sendsModel: true, container: "results", indexKey: "index", scoreKey: "relevance_score", extra: { return_documents: false }, basis: "request confirmed, response presumed Cohere-shaped" },
  tei: { provider: "tei", status: "unverified", documentsField: "texts", topField: undefined, sendsModel: false, container: "$", indexKey: "index", scoreKey: "score", extra: { raw_scores: false, truncate: false }, basis: "request confirmed (texts, not documents); response presumed root array of {index, score}" },
  vllm: { provider: "vllm", status: "unverified", documentsField: "documents", topField: "top_n", sendsModel: true, container: "results", indexKey: "index", scoreKey: "relevance_score", extra: {}, basis: "endpoint confirmed, Cohere-compatible response presumed" },
  llamacpp: { provider: "llamacpp", status: "unverified", documentsField: "documents", topField: "top_n", sendsModel: true, container: "results", indexKey: "index", scoreKey: "relevance_score", extra: {}, basis: "flag and endpoints confirmed, response presumed Cohere-compatible" },
  mtplx: { provider: "mtplx", status: "source", documentsField: "documents", topField: "top_n", sendsModel: true, container: "results", indexKey: "index", scoreKey: "relevance_score", extra: { return_documents: false }, basis: "mtplx/server/openai.py route /v1/rerank (youssofal/MTPLX 2.12.2): {query, documents, top_n, return_documents, model?, instruction?} -> {id, model, results:[{index, relevance_score}], usage}" },
  omlx: { provider: "omlx", status: "unverified", documentsField: "documents", topField: "top_n", sendsModel: true, container: "results", indexKey: "index", scoreKey: "relevance_score", extra: {}, basis: "endpoint confirmed, response presumed Cohere-compatible" },
});

export function buildRerankBody(shape: RerankShape, settings: RerankSettings, query: string, docs: readonly string[], topN: number | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (shape.sendsModel && settings.model !== undefined) body["model"] = settings.model;
  body["query"] = query;
  body[shape.documentsField] = docs;
  if (topN !== undefined && shape.topField !== undefined) body[shape.topField] = topN;
  return { ...body, ...shape.extra };
}

const bad = (provider: string, message: string): never => {
  throw new AdapterError("bad_response", message, { provider });
};

/**
 * Parses one response against the provider's row. Accepts a result count of either all documents or `topN`
 * (servers that ignore the limit return everything); indexes must be unique integers inside the request.
 */
export function parseRerankResponse(json: unknown, shape: RerankShape, docCount: number, topN: number | undefined): RerankResult[] {
  const provider = shape.provider;
  let list: unknown;
  if (shape.container === "$") list = json;
  else {
    if (typeof json !== "object" || json === null || Array.isArray(json)) return bad(provider, `expected an object with a "${shape.container}" array`);
    list = (json as Record<string, unknown>)[shape.container];
  }
  if (!Array.isArray(list)) {
    const keys = typeof json === "object" && json !== null && !Array.isArray(json) ? Object.keys(json).slice(0, 8).join(",") : typeof json;
    return bad(provider, `unrecognised rerank response shape (expected ${shape.container === "$" ? "a root array" : `"${shape.container}" array`}; got ${keys})`);
  }
  const allowed = new Set<number>([docCount]);
  if (topN !== undefined) allowed.add(Math.min(topN, docCount));
  if (!allowed.has(list.length)) return bad(provider, `expected ${[...allowed].join(" or ")} results, got ${list.length}`);
  const seen = new Set<number>();
  return list.map((item: unknown, n: number): RerankResult => {
    if (typeof item !== "object" || item === null) return bad(provider, `result ${n} is not an object`);
    const rec = item as Record<string, unknown>;
    const index = rec[shape.indexKey];
    const score = rec[shape.scoreKey];
    if (typeof index !== "number" || !Number.isInteger(index)) return bad(provider, `result ${n} has no integer "${shape.indexKey}" (shape mismatch; keys: ${Object.keys(rec).slice(0, 8).join(",")})`);
    if (typeof score !== "number" || !Number.isFinite(score)) return bad(provider, `result ${n} has no finite "${shape.scoreKey}" (shape mismatch; keys: ${Object.keys(rec).slice(0, 8).join(",")})`);
    if (index < 0 || index >= docCount) return bad(provider, `result ${n} index ${index} is out of range for ${docCount} documents`);
    if (seen.has(index)) return bad(provider, `duplicate index ${index}`);
    seen.add(index);
    return { index, score };
  });
}

/** Markdown for docs and for the live smoke report. `observed` maps provider to a one-line live result. */
export function renderRerankMappingTable(observed: Readonly<Partial<Record<RerankProviderId, string>>> = {}): string {
  const rows = Object.values(RERANK_SHAPES).map((s) => {
    const req = `\`{${s.sendsModel ? "model, " : ""}query, ${s.documentsField}[]${s.topField ? `, ${s.topField}` : ""}}\``;
    const res = s.container === "$" ? `\`[{${s.indexKey}, ${s.scoreKey}}]\`` : `\`{${s.container}:[{${s.indexKey}, ${s.scoreKey}}]}\``;
    return `| ${s.provider} | ${req} | ${res} | ${s.status} | ${observed[s.provider] ?? "not run"} |`;
  });
  return ["| Provider | Request | Response | Status | Live result |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}
