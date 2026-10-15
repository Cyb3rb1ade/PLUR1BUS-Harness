import { privacyAcknowledgmentError } from "@plur1bus/config-schema";
import { mediaError } from "../errors.ts";
import type { CaptionConfig, CaptionProvider, CaptionRequest, CaptionResult } from "./types.ts";

/** Trim, collapse whitespace, and cut to `maxChars` at a word boundary; the ellipsis counts towards the limit. */
export function normaliseCaption(raw: string, maxChars: number): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  const room = Math.max(1, maxChars - 1);
  let cut = text.slice(0, room);
  if (!/\s/.test(text[room] ?? "")) {
    const space = cut.lastIndexOf(" ");
    if (space > 0) cut = cut.slice(0, space);
  }
  return `${cut.trimEnd().replace(/[,;:\-–]+$/, "").trimEnd()}…`;
}

export interface CaptionService {
  /** The caption for a medium by `caption.source`, or null when none applies (off, nothing known, no provider). */
  resolve(req: CaptionRequest): Promise<CaptionResult | null>;
}
export interface CaptionServiceOptions {
  config: () => CaptionConfig;
  /** The provider for auto captions; undefined when none is configured or allowed. */
  provider: () => CaptionProvider | undefined;
  /** Runtime privacy pin, read on every call: a provider that is not local is refused while it is set, even if it was chosen earlier. */
  pinned?: () => boolean;
}

export function createCaptionService(o: CaptionServiceOptions): CaptionService {
  return {
    async resolve(req) {
      const cfg = o.config();
      if (cfg.source === "off") return null;
      const pick = (text: string | undefined, source: CaptionResult["source"]): CaptionResult | null => {
        const t = text === undefined ? "" : normaliseCaption(text, cfg.maxChars);
        return t ? { text: t, source } : null;
      };
      if (cfg.source === "prompt-then-user-then-auto") {
        const p = pick(req.prompt, "prompt");
        if (p) return p;
      }
      const u = pick(req.userCaption, "user");
      if (u || cfg.source === "user-only") return u;
      const provider = o.provider();
      if (!provider) return null;
      if (!provider.local && o.pinned?.()) throw mediaError("E_MEDIA_PRIVACY", "privacy pin is set: cloud captioning is not allowed", { reason: "privacy-pin" });
      req.signal?.throwIfAborted();
      return pick(await provider.caption({ kind: req.kind, mime: req.mime, source: req.source, ...(req.signal ? { signal: req.signal } : {}) }), "auto");
    },
  };
}

/** Local captioning follows local embedding; with cloud embedding nothing is preselected and setup asks. */
export function defaultCaptionProvider(embeddingLocal: boolean): "local" | undefined {
  return embeddingLocal ? "local" : undefined;
}

export interface CaptionProviders {
  local?: CaptionProvider;
  /** Cloud providers by configured id. Looked up only after the privacy check. */
  cloud?: (id: string) => CaptionProvider | undefined;
}
/**
 * Choose the caption provider. With the privacy pin set, a configured cloud provider is refused here, before anything
 * could be sent; an unset provider falls back to local.
 */
export function resolveCaptionProvider(o: { config: Pick<CaptionConfig, "provider" | "privacyAck">; pinned: boolean; providers: CaptionProviders; embeddingLocal?: boolean }): CaptionProvider | undefined {
  const id = o.config.provider;
  if (id === "off") return undefined;
  const cloud = id !== undefined && id !== "local";
  if (cloud && o.pinned) throw mediaError("E_MEDIA_PRIVACY", "privacy pin is set: cloud captioning is not allowed");
  if (cloud) {
    const failure = privacyAcknowledgmentError({ function: "caption", provider: id, local: false, ack: o.config.privacyAck });
    if (failure) throw mediaError("E_MEDIA_PRIVACY", "Captioning privacy acknowledgment required", { reason: failure.reason });
    return o.providers.cloud?.(id);
  }
  if (id === "local" || o.pinned) return o.providers.local;
  return defaultCaptionProvider(o.embeddingLocal ?? false) ? o.providers.local : undefined;
}
