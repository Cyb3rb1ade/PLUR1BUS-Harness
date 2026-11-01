/** Catalog and configuration checks; model support never proves encoder installation. */
import {
  MEDIA_MODEL_CATALOG, privacyAcknowledgmentError, validate, type HarnessConfig, type PrivacyAcknowledgment,
} from "@plur1bus/config-schema";
import { localOnlyShared } from "../privacy/local-only.ts";
import { RpcError } from "../rpc/errors.ts";
import { mediaError } from "./errors.ts";
import type { MediaKind } from "./types.ts";

/** The `memory.mediaEmbedding` config block (subset used for validation). */
export interface MediaEmbeddingConfig {
  enabled?: boolean; provider?: string; privacyAck?: PrivacyAcknowledgment; model?: string; dimensions?: number; modalities?: MediaKind[];
  video?: { segmentSec?: number; maxFrames?: number; sceneDetect?: boolean };
  audio?: { segmentSec?: number; maxSeconds?: number };
  /** `model` is not a schema key; it lets the caller pass the resolved caption model for catalogue lookup. */
  caption?: { source?: "prompt-then-user-then-auto" | "user-only" | "off"; provider?: string; privacyAck?: PrivacyAcknowledgment; model?: string; maxChars?: number; perSegment?: boolean };
  backfill?: "auto" | "manual";
}

export interface MediaModelInfo {
  local: boolean;
  capabilities: { text: boolean; image: boolean; video: boolean; audio: boolean };
  licence: { id: string; nonCommercial: boolean };
  dimensions: number[];
}
/** Adapter over the existing provider/embedding catalogue. */
export interface MediaProviderCatalog { lookup(provider: string, model: string): MediaModelInfo | undefined }

/** MM-3a fixed local entry until MM-1 supplies the Rust encoder catalog. No download or runtime probe. */
export const productionMediaProviderCatalog: MediaProviderCatalog = {
  lookup(provider, model) {
    if (!MEDIA_MODEL_CATALOG.providers.includes(provider)) return undefined;
    const info = Object.hasOwn(MEDIA_MODEL_CATALOG.models, model)
      ? MEDIA_MODEL_CATALOG.models[model as keyof typeof MEDIA_MODEL_CATALOG.models] : undefined;
    return info ? structuredClone(info) : undefined;
  },
};

export interface MediaValidationContext {
  catalog: MediaProviderCatalog;
  privacyPinned: boolean;
  licenceAccepted(modelId: string): boolean;
  available(provider: string, model: string): Promise<boolean> | boolean;
}

const ALL_KINDS: MediaKind[] = ["image", "video", "audio"];

/**
 * Validate a whole pending config.set result, including inherited agent media settings, before any write.
 * MM-3a checks that a local model can be configured; optional encoder downloads are not a prerequisite for setup.
 * An injected availability probe is awaited. Unrelated changes leave existing media settings alone.
 */
export async function validateMediaChanges(current: HarnessConfig, changes: readonly { key: string; value: unknown }[],
  context: Partial<MediaValidationContext> = {}): Promise<void> {
  if (!changes.some(({ key }) =>
    /^(memory|agents|privacy)$/.test(key)
      || /^memory\.mediaEmbedding(\.|$)/.test(key)
      || /^privacy\.localOnly(\.|$)/.test(key)
      || /^agents\.[^.]+$/.test(key)
      || /^agents\.[^.]+\.(memory|privacy)$/.test(key)
      || /^agents\.[^.]+\.(memory\.mediaEmbedding|privacy\.localOnly)(\.|$)/.test(key))) return;
  const next = structuredClone(current);
  for (const { key, value } of changes) {
    const parts = key.split(".");
    if (parts.some(part => ["__proto__", "constructor", "prototype"].includes(part))) {
      throw mediaError("E_MEDIA_UNAVAILABLE", "Invalid configuration path", { reason: "invalid-key" });
    }
    let node = next as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      const child = node[part];
      node[part] = child && typeof child === "object" && !Array.isArray(child) ? child : {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts.at(-1)!] = structuredClone(value);
  }
  const result = validate(next);
  if (!result.ok) throw new RpcError("E_CONFIG_INVALID", result.errors.join("; "));
  const base = result.config.memory.mediaEmbedding;
  const layers = [base, ...Object.values(result.config.agents).map(agent => {
    const override = agent.memory?.mediaEmbedding;
    return { ...base, ...override,
      modalities: (override?.modalities ?? base.modalities).filter((kind): kind is MediaKind => kind !== undefined),
      caption: { ...base.caption, ...override?.caption },
    };
  })];
  const ctx: MediaValidationContext = {
    catalog: productionMediaProviderCatalog, privacyPinned: localOnlyShared(result.config), licenceAccepted: () => false,
    available: (provider, model) => productionMediaProviderCatalog.lookup(provider, model) !== undefined, ...context,
  };
  for (const media of layers) await validateMediaEmbedding(media, ctx);
}

async function checkModel(provider: string, model: string, ctx: MediaValidationContext, extra?: (info: MediaModelInfo) => void): Promise<void> {
  const info = ctx.catalog.lookup(provider, model);
  if (!info) throw mediaError("E_MEDIA_UNAVAILABLE", `Unknown media provider/model: ${provider}/${model}`, { reason: "unknown-provider" });
  if (ctx.privacyPinned && !info.local) throw mediaError("E_MEDIA_PRIVACY", `“Only local models” is on; provider ${provider} is not local`, { reason: "privacy-pin" });
  extra?.(info);
  if (info.licence.nonCommercial && !ctx.licenceAccepted(model)) throw mediaError("E_MEDIA_LICENSE", `Licence ${info.licence.id} of ${model} is not accepted`, { reason: info.licence.id });
  if (!(await ctx.available(provider, model))) throw mediaError("E_MEDIA_UNAVAILABLE", `${provider}/${model} is not installed or not configured`, { reason: "not-available" });
}

/** Pure config validation: capability, licence, privacy pin, availability. No provider-combination rules. */
export async function validateMediaEmbedding(cfg: MediaEmbeddingConfig, ctx: MediaValidationContext): Promise<void> {
  if (cfg.enabled === false || cfg.provider === undefined || cfg.provider === "off") return;
  const model = cfg.model ?? "";
  await checkModel(cfg.provider, model, ctx, (info) => {
    const failure = privacyAcknowledgmentError({ function: "media", provider: cfg.provider!, local: info.local, ack: cfg.privacyAck });
    if (failure) throw mediaError("E_MEDIA_PRIVACY", "Media embedding privacy acknowledgment required", { reason: failure.reason });
    for (const k of ["text", ...(cfg.modalities ?? ALL_KINDS)] as const) {
      if (!info.capabilities[k]) throw mediaError("E_MEDIA_CAPABILITY", `${cfg.provider}/${model} does not support ${k}`, { reason: k });
    }
    if (cfg.dimensions !== undefined && !info.dimensions.includes(cfg.dimensions)) {
      throw mediaError("E_MEDIA_DIMENSION", `${model} does not support ${cfg.dimensions} dimensions (${info.dimensions.join(", ")})`, { reason: String(cfg.dimensions) });
    }
  });
}

/** Captioner check: unknown/unavailable provider, privacy pin and licence. Unset, "off" or caption.source "off" is valid. */
export async function validateCaptionProvider(cfg: MediaEmbeddingConfig, ctx: MediaValidationContext): Promise<void> {
  const c = cfg.caption;
  if (cfg.enabled === false || !c || c.source === "off" || c.provider === undefined || c.provider === "off") return;
  await checkModel(c.provider, c.model ?? "", ctx, (info) => {
    const failure = privacyAcknowledgmentError({ function: "caption", provider: c.provider!, local: info.local, ack: c.privacyAck });
    if (failure) throw mediaError("E_MEDIA_PRIVACY", "Captioning privacy acknowledgment required", { reason: failure.reason });
  });
}
