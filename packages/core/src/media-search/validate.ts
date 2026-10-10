import { mediaError } from "./errors.ts";
import type { MediaKind } from "./types.ts";

/** The `memory.mediaEmbedding` config block (subset used for validation). */
export interface MediaEmbeddingConfig {
  enabled?: boolean; provider?: string; model?: string; dimensions?: number; modalities?: MediaKind[];
  video?: { segmentSec?: number; maxFrames?: number; sceneDetect?: boolean };
  audio?: { segmentSec?: number; maxSeconds?: number };
  /** `model` is not a schema key; it lets the caller pass the resolved caption model for catalogue lookup. */
  caption?: { source?: "prompt-then-user-then-auto" | "user-only" | "off"; provider?: string; model?: string; maxChars?: number; perSegment?: boolean };
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

export interface MediaValidationContext {
  catalog: MediaProviderCatalog;
  privacyPinned: boolean;
  licenceAccepted(modelId: string): boolean;
  available(provider: string, model: string): Promise<boolean> | boolean;
}

const ALL_KINDS: MediaKind[] = ["image", "video", "audio"];

async function checkModel(provider: string, model: string, ctx: MediaValidationContext, extra?: (info: MediaModelInfo) => void): Promise<void> {
  const info = ctx.catalog.lookup(provider, model);
  if (!info) throw mediaError("E_MEDIA_UNAVAILABLE", `Unknown media provider/model: ${provider}/${model}`, { reason: "unknown-provider" });
  if (ctx.privacyPinned && !info.local) throw mediaError("E_MEDIA_PRIVACY", `Privacy pin is set; provider ${provider} is not local`, { reason: "privacy-pin" });
  extra?.(info);
  if (info.licence.nonCommercial && !ctx.licenceAccepted(model)) throw mediaError("E_MEDIA_LICENSE", `Licence ${info.licence.id} of ${model} is not accepted`, { reason: info.licence.id });
  if (!(await ctx.available(provider, model))) throw mediaError("E_MEDIA_UNAVAILABLE", `${provider}/${model} is not installed or not configured`, { reason: "not-available" });
}

/** Pure config validation: capability, licence, privacy pin, availability. No provider-combination rules. */
export async function validateMediaEmbedding(cfg: MediaEmbeddingConfig, ctx: MediaValidationContext): Promise<void> {
  if (cfg.enabled === false || cfg.provider === undefined || cfg.provider === "off") return;
  const model = cfg.model ?? "";
  await checkModel(cfg.provider, model, ctx, (info) => {
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
  await checkModel(c.provider, c.model ?? "", ctx);
}
