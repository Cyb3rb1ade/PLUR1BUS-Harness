import { DisabledMediaIndex } from "./disabled.ts";
import { detectEngineMedia, EngineMediaIndex, type EngineMedia, type MediaHostPorts } from "./engine-adapter.ts";
import type { MediaIndexPort, Scope } from "./types.ts";
import type { MediaEmbeddingConfig } from "./validate.ts";

export type MediaIndexKind = "engine" | "memory" | "disabled";

/** Engine adapter when the engine exposes `media` and it is enabled; otherwise Disabled. InMemory only through `test`. */
export function selectMediaIndex(opts: { engine: unknown; config: MediaEmbeddingConfig; ports: MediaHostPorts; test?: MediaIndexPort; scopeOfMedia?: (id: string) => Promise<Scope> }): { port: MediaIndexPort; kind: MediaIndexKind } {
  if (opts.test) return { port: opts.test, kind: "memory" };
  if (opts.config.enabled === false || opts.config.provider === "off") return { port: new DisabledMediaIndex("in der Konfiguration deaktiviert"), kind: "disabled" };
  if (!detectEngineMedia(opts.engine)) return { port: new DisabledMediaIndex(), kind: "disabled" };
  const media = (opts.engine as { media: EngineMedia }).media;
  return { port: new EngineMediaIndex(media, opts.scopeOfMedia ? { scopeOfMedia: opts.scopeOfMedia } : {}), kind: "engine" };
}
