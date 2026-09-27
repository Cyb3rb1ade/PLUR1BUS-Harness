// The pinned local-model catalog the importer compares against, mirrored from the pinned engine's
// `lib/providers/local-model-artifacts.js` (revision, dtype, artefact list) and ADR-006's model table (licences the
// engine does not declare itself). test/import/identity.test.ts fails when this drifts from the engine the harness
// pins, so an engine repin that changes a model shows up here, not as a silent wrong verdict.
import { createHash } from "node:crypto";

export type LicenceClass = "permissive" | "non-commercial" | "remote-service-terms" | "unknown";

export interface CatalogEntry {
  role: "embedding" | "reranker";
  revision: string;
  /** "q8" for the quantized ONNX export, "fp32" for the full-precision one. */
  quantization: "q8" | "fp32";
  nativeDimensions?: number;
  queryPrefix?: string;
  passagePrefix?: string;
  licence: string;
  licenceClass: LicenceClass;
  /** artefactDigest() over the profile's artefacts. */
  artefactDigest: string;
}

export const CATALOG: Readonly<Record<string, CatalogEntry>> = Object.freeze({
  "intfloat/multilingual-e5-small": {
    role: "embedding", revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3", quantization: "fp32", nativeDimensions: 384,
    queryPrefix: "query: ", passagePrefix: "passage: ", licence: "MIT", licenceClass: "permissive",
    artefactDigest: "sha256:e4e31b935c7e8f9136a601e063dbfa3e4057d1cb62dd16c443123aec934b9673",
  },
  "jinaai/jina-embeddings-v3": {
    role: "embedding", revision: "68ed94909d564380f954be27ae2e133214c1adc9", quantization: "q8", nativeDimensions: 1024,
    queryPrefix: "", passagePrefix: "", licence: "CC-BY-NC-4.0", licenceClass: "non-commercial",
    artefactDigest: "sha256:4456f3e56df520f0200557894c9938e7629dd0d9fcc65f46bbe3242a6e04d8b3",
  },
  "jinaai/jina-embeddings-v5-text-nano-retrieval": {
    role: "embedding", revision: "ac5d898c8d382b17167c33e5c8af644a3519b47d", quantization: "q8", nativeDimensions: 768,
    queryPrefix: "Query: ", passagePrefix: "Document: ", licence: "CC-BY-NC-4.0", licenceClass: "non-commercial",
    artefactDigest: "sha256:ffdcf9e07ab46d3935fc7c27f2616c5cb7d3ee03b5c25c9a7819322b881d3ec8",
  },
  "jinaai/jina-reranker-v2-base-multilingual": {
    role: "reranker", revision: "9cfeff2df7d40d1b78e75e5e9cebec92a99813c9", quantization: "q8",
    licence: "CC-BY-NC-4.0", licenceClass: "non-commercial",
    artefactDigest: "sha256:8b61a55f4a9308d8913d268bf4805266718d856a729512a9be9d673d1a727680",
  },
  "woxpas-ai/bge-reranker-v2-m3-onnx": {
    role: "reranker", revision: "c44ebc43de724ae8816668bb44d2e728e17faa18", quantization: "q8",
    licence: "Apache-2.0", licenceClass: "permissive",
    artefactDigest: "sha256:fc97a2f5e08cd6cbba2575264d751e879b67cfceee0b33f3481ca6f458469ff0",
  },
});

/** The engine's own defaults (`lib/providers/dimensions.js`). */
export const ENGINE_DEFAULTS = Object.freeze({
  localReranker: "woxpas-ai/bge-reranker-v2-m3-onnx",
  cohereReranker: "rerank-v3.5",
  localTokenCap: 512,
});

/** SHA-256 over the sorted `{path, sha256}` artefact list, the way the engine's fingerprint canonicalises it. */
export function artefactDigest(artifacts: readonly { path: string; sha256: string }[]): string {
  const sorted = artifacts.map(({ path, sha256 }) => ({ path, sha256: sha256.toLowerCase() })).sort((a, b) => a.path.localeCompare(b.path));
  return `sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`;
}
