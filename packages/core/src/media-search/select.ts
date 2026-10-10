import { DisabledMediaIndex } from "./disabled.ts";
import { detectEngineMedia, EngineMediaIndex, type EngineMedia, type MediaHostPorts } from "./engine-adapter.ts";
import type { MediaIndexPort } from "./types.ts";
import type { MediaEmbeddingConfig } from "./validate.ts";

export type MediaIndexKind = "engine" | "memory" | "disabled";

/** Engine adapter when the engine exposes `media` and it is enabled; otherwise Disabled. InMemory only through `test`. */
export function selectMediaIndex(opts: { engine: unknown; config: MediaEmbeddingConfig; ports: MediaHostPorts; test?: MediaIndexPort }): { port: MediaIndexPort; kind: MediaIndexKind } {
  if (opts.test) return { port: opts.test, kind: "memory" };
  if (opts.config.enabled === false || opts.config.provider === "off") return { port: new DisabledMediaIndex("in der Konfiguration deaktiviert"), kind: "disabled" };
  if (!detectEngineMedia(opts.engine)) return { port: new DisabledMediaIndex(), kind: "disabled" };
  const media = (opts.engine as { media: EngineMedia }).media;
  // Assumption: the engine takes frames/audio/budget through an optional attachHost hook.
  void media.attachHost?.({ frames: opts.ports.frames, audio: opts.ports.audio, ...(opts.ports.budget ? { budget: opts.ports.budget } : {}) });
  return { port: new EngineMediaIndex(media), kind: "engine" };
}
