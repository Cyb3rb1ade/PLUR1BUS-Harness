import { pathToFileURL } from "node:url";
import { guardedMediaIndex } from "../../packages/core/src/media-search/admission.ts";
import { InMemoryMediaIndex } from "../../packages/core/src/media-search/in-memory.ts";
import { mediaError } from "../../packages/core/src/media-search/errors.ts";
import type { MediaKind, Scope } from "../../packages/core/src/media-search/types.ts";
import { exporterMain } from "./lib.mjs";

async function one(name: string) {
  const events: unknown[] = [];
  let pinned = name === "pinned";
  const scoped = { agentId: "a", workspace: "w", user: "u", trust: "local" } as Scope;
  const port = new InMemoryMediaIndex({
    provider: "test", model: "m", dim: 1, fingerprint: "test",
    async embedText() { events.push("text"); return [1]; },
    async embedMedia() { events.push("encode"); return { vectors: [[1]], segments: [] }; },
  });
  const guarded = guardedMediaIndex({
    ...port,
    search: request => port.search(request),
    async index(request) {
      if (name === "failed") {
        events.push("encode");
        throw mediaError("E_MEDIA_UNAVAILABLE", "fixture failure");
      }
      return port.index(request);
    },
    remove: id => port.remove(id),
    setCaption: (id, text, source) => port.setCaption(id, text, source),
    status: () => port.status(),
  }, {
    policy: () => ({ local: name.startsWith("local"), model: "m", pinned }),
    ...(name === "no budget" ? {} : {
      budget: { async reserve(units) {
        events.push(units);
        if (name === "pin changes") pinned = true;
        return {
          settle: async () => { events.push("settle"); },
          release: async () => { events.push("release"); },
        };
      } },
    }),
  });
  let outcome: unknown = "ok";
  let kind: MediaKind = "image";
  if (["video", "no duration", "negative duration", "infinite duration"].includes(name)) kind = "video";
  if (name === "audio") kind = "audio";
  const encodingVideoSeconds = name === "video" ? 1.25 : name === "negative duration" ? -1
    : name === "infinite duration" ? Infinity : undefined;
  try {
    if (name.endsWith("search")) await guarded.search({ text: "x", limit: 1, scope: scoped });
    else if (name.endsWith("backfill")) await guarded.backfill.start({ reason: "manual" });
    else await guarded.index({ mediaId: "m", scope: scoped, kind, mime: "image/png",
      source: { bytes: new Uint8Array([1]) }, ...(encodingVideoSeconds === undefined ? {} : { encodingVideoSeconds }) });
  } catch (error) {
    if (!(error instanceof Error) || !("error" in error)) throw error;
    outcome = error.error;
  }
  return { name, events, outcome };
}

export async function buildMediaAdmissionVectors() {
  return { admission: await Promise.all(["local", "image", "video", "no duration", "negative duration", "infinite duration",
    "pinned", "pin changes", "audio", "no budget", "failed", "local search", "cloud search",
    "local backfill", "cloud backfill"].map(one)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "media", build: buildMediaAdmissionVectors });
}
