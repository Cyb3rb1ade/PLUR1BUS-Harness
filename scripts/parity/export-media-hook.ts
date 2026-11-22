import { pathToFileURL } from "node:url";
import { createMediaIndexHook } from "../../packages/core/src/media-search/hook.ts";
import { InMemoryMediaIndex } from "../../packages/core/src/media-search/in-memory.ts";
import { createCaptionService } from "../../packages/core/src/media-search/caption/service.ts";
import type { MediaIndexPort, Scope } from "../../packages/core/src/media-search/types.ts";
import { exporterMain } from "./lib.mjs";

async function one(name: string) {
  const scope = { agentId: "a", workspace: "w", user: "u", trust: "local" } as Scope;
  const requested: unknown[] = [], failed: string[] = [], removed: string[] = [];
  const backing = new InMemoryMediaIndex({ provider: "local", model: "test", dim: 1, fingerprint: "local",
    async embedMedia() { return { vectors: [[1]], segments: [] }; }, async embedText() { return [1]; } });
  const port: MediaIndexPort = {
    async index(req) {
      requested.push({ id: req.mediaId, caption: req.caption ?? null, source: req.captionSource ?? null });
      if (name === "failed") return { segments: 0, state: "failed" };
      return backing.index(req);
    },
    async remove(id) { removed.push(id); return backing.remove(id); },
    search: req => backing.search(req), setCaption: (id, text, source) => backing.setCaption(id, text, source),
    status: () => backing.status(), backfill: backing.backfill,
  };
  const hook = createMediaIndexHook({
    port: () => port, config: () => ({ enabled: name !== "disabled", provider: name === "off" ? "off" : "local" }),
    captions: createCaptionService({ config: () => ({ source: "prompt-then-user-then-auto", maxChars: 80 }),
      provider: () => ({ id: "local", local: true, async caption() {
        if (name === "caption error") throw new Error("fixture error");
        return "auto caption";
      } }) }),
    scopeOf: () => scope, events: { emit() {} }, logger: { warn() {} },
    counters: { indexFailed: stage => failed.push(stage) },
    timeoutMs: 0,
  });
  const record = { mediaId: "id", kind: "image" as const, mime: "image/png", source: { bytes: Uint8Array.of(1) } };
  if (name === "stored") hook.onStored({ ...record, prompt: " prompt caption ", userCaption: "manual caption" });
  else if (name === "uploaded") hook.onUploaded({ ...record, prompt: "unused caption", userCaption: " manual caption " });
  else if (name === "remove") hook.onDeleted("id");
  else hook.onUploaded(record);
  await hook.idle();
  return { name, requested, failed, removed };
}

export async function buildMediaHookVectors() {
  return { hook: await Promise.all(["stored", "uploaded", "caption error", "automatic", "disabled", "off", "remove", "failed"].map(one)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "media", build: buildMediaHookVectors });
}
