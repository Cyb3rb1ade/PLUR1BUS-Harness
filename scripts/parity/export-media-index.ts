import { pathToFileURL } from "node:url";
import { InMemoryMediaIndex } from "../../packages/core/src/media-search/in-memory.ts";
import { mediaError } from "../../packages/core/src/media-search/errors.ts";
import type { MediaKind, MediaSearchRequest, Scope, Segment } from "../../packages/core/src/media-search/types.ts";
import { exporterMain } from "./lib.mjs";

const viewer = { workspace: "w", agentId: "a", user: "u", trust: "local" } as Scope;
const rows: Array<{ id: string; kind: MediaKind; scope: Scope; vectors: number[][]; segments?: Segment[]; caption?: string }> = [
  { id: "image", kind: "image", scope: viewer, vectors: [[1, 0]], caption: "fixture text" },
  { id: "video", kind: "video", scope: viewer, vectors: [[0, 1], [1, 1]], segments: [
    { idx: 0, startMs: 0, endMs: 9_000 }, { idx: 1, startMs: 9_000, endMs: 18_000 },
  ] },
  { id: "shared", kind: "image", scope: { ...viewer, agentId: "second" }, vectors: [[0, 1]] },
  { id: "different-user", kind: "image", scope: { ...viewer, user: "stranger" }, vectors: [[1, -1]] },
  { id: "other-workspace", kind: "image", scope: { ...viewer, workspace: "other" }, vectors: [[1, 0]] },
  { id: "other-user-and-agent", kind: "image", scope: { ...viewer, agentId: "second", user: "stranger" }, vectors: [[1, 0]] },
  { id: "zero", kind: "image", scope: viewer, vectors: [[0, 0]] },
  { id: "audio", kind: "audio", scope: viewer, vectors: [] },
  { id: "bad", kind: "image", scope: viewer, vectors: [[1]] },
  { id: "failed", kind: "image", scope: viewer, vectors: [] },
];
const cap = [
  { mediaId: "video", captionMemoryId: "video-caption" },
  { mediaId: "other-workspace", captionMemoryId: "private-caption" },
  { mediaId: "video", captionMemoryId: "duplicate" },
  { mediaId: "shared", captionMemoryId: "shared-caption" },
  { mediaId: "audio", captionMemoryId: "audio-caption" },
  { mediaId: "absent", captionMemoryId: "absent-caption" },
];
async function capture(operation: () => Promise<unknown>) {
  try { return await operation(); } catch (error) {
    if (!(error instanceof Error) || !("error" in error)) throw error;
    return { error: error.error };
  }
}
export async function buildMediaIndexVectors() {
  const port = new InMemoryMediaIndex({
    provider: "fixture", model: "two-d", fingerprint: "two-d", dim: 2, modalities: ["image", "video"],
    async embedMedia(request) {
      if (request.mediaId === "failed") throw mediaError("E_MEDIA_UNAVAILABLE", "isolated fixture");
      const row = rows.find(row => row.id === request.mediaId)!;
      return { vectors: row.vectors, segments: row.segments ?? [] };
    },
    async embedText(text) { return text === "bad" ? [1] : [1, 0]; },
    captions: { async search() { return cap; } },
    now: () => "2026-01-01T00:00:00Z",
  });
  const indexed: unknown[] = [];
  for (const row of rows) {
    indexed.push(await capture(() => port.index({ mediaId: row.id, kind: row.kind, scope: row.scope,
      mime: row.kind + "/fixture", source: { bytes: new Uint8Array([1]) }, ...(row.caption ? { caption: row.caption } : {}) })));
  }
  const common = { scope: viewer, limit: 3 };
  const searches: Array<{ name: string; request: MediaSearchRequest }> = [
    { name: "text", request: { ...common, text: "fixture" } },
    { name: "by id", request: { ...common, likeMediaId: "image" } },
    { name: "private id", request: { ...common, likeMediaId: "other-workspace" } },
    { name: "fused", request: { ...common, text: "fixture", fuseCaptions: true, limit: 8 } },
    { name: "fused id", request: { ...common, likeMediaId: "image", fuseCaptions: true } },
    { name: "kind", request: { ...common, text: "fixture", kinds: ["video"] } },
    { name: "floor", request: { ...common, text: "fixture", minScore: 0.9 } },
    { name: "zero kinds", request: { ...common, text: "fixture", kinds: [] } },
    { name: "blank", request: { ...common, text: "\ufeff " } },
    { name: "both", request: { ...common, text: "fixture", likeMediaId: "image" } },
    { name: "neither", request: common },
    { name: "limit", request: { ...common, text: "fixture", limit: 201 } },
    { name: "too long", request: { ...common, text: "x".repeat(4097) } },
    { name: "dimension", request: { ...common, text: "bad" } },
  ];
  const results = [];
  for (const { name, request } of searches) {
    results.push({ name, request, outcome: await capture(() => port.search(request)) });
  }
  const status = await port.status();
  await port.remove("image");
  const afterRemoval = await capture(() => port.search({ ...common, likeMediaId: "image" }));
  return { index: { viewer, rows, indexed, cap, searches: results, counts: status.counts, afterRemoval } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "media", build: buildMediaIndexVectors });
}
