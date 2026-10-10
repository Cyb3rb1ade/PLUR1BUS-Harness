import type { CallBudget } from "../../budget/index.ts";
import type { ChatRequest as WireRequest, Usage } from "../../../../providers/src/index.ts";
import { mediaError } from "../errors.ts";
import { composeCaptionProvider } from "./keyframes.ts";
import type { CaptionProvider } from "./types.ts";
import type { AudioDecoderPort, FrameExtractorPort, MediaSource } from "../types.ts";

export const CAPTION_PROMPT = "Describe this image in one short factual sentence for search. No preamble.";

/** The slice of the provider layer a caption call needs; composition adapts `ProviderRouter.complete` to it. */
export interface CaptionChatPort {
  complete(request: WireRequest, o: { signal?: AbortSignal }): Promise<{ text: string; usage?: Usage; provider: string; model: string }>;
}
export interface CloudCaptionOptions {
  /** Configured provider id (`caption.provider`). */
  id: string;
  /** Vision-capable model of that provider. */
  model: string;
  chat: CaptionChatPort;
  /** Existing call budget; null when unavailable, which refuses the call (fail closed like the media surface). */
  budget: CallBudget | null;
  /** D109 policy: resolves when the capability is allowed, throws otherwise. Runs before budget and request. */
  decide: () => Promise<void>;
  /** Budget identity of the caller (system job for backfill, the user for uploads). */
  principal: string;
  agent: string;
  maxChars: () => number;
  extractor?: FrameExtractorPort;
  transcribe?: (src: MediaSource, signal?: AbortSignal) => Promise<string>;
  maxOutputTokens?: number;
  /** Rough tokens one image costs for admission. */
  estimatedImageTokens?: number;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

export function createCloudCaptionProvider(o: CloudCaptionOptions): CaptionProvider {
  const maxOut = o.maxOutputTokens ?? 120;
  const captionImage = async (image: Uint8Array, mime: string, signal?: AbortSignal): Promise<string> => {
    await o.decide();
    if (!o.budget) throw mediaError("E_MEDIA_UNAVAILABLE", "budget unavailable for cloud captions", { reason: "budget" });
    const admitted = o.budget.checkBeforeCall({ principal: o.principal, agent: o.agent, project: "media-caption", model: o.model, provider: o.id, estimatedInputTokens: o.estimatedImageTokens ?? 1500, maxOutputTokens: maxOut });
    if (admitted.kind === "refuse") throw mediaError("E_MEDIA_UNAVAILABLE", "caption budget exceeded", { reason: "budget" });
    let sent = false;
    try {
      sent = true;
      const res = await o.chat.complete({ model: o.model, maxTokens: maxOut, messages: [{ role: "user", content: [{ type: "text", text: CAPTION_PROMPT }, { type: "image_url", url: `data:${mime};base64,${b64(image)}`, detail: "low" }] }] }, { ...(signal ? { signal } : {}) });
      o.budget.settle(admitted.reservationId, { inputTokens: res.usage?.inputTokens ?? o.estimatedImageTokens ?? 1500, outputTokens: res.usage?.outputTokens ?? maxOut });
      return res.text;
    } catch (e) {
      if (signal?.aborted && sent) o.budget.settle(admitted.reservationId, { inputTokens: o.estimatedImageTokens ?? 1500, outputTokens: 0 });
      else o.budget.releaseUnused(admitted.reservationId);
      throw e;
    }
  };
  return composeCaptionProvider({ id: o.id, local: false, maxChars: o.maxChars, captionImage, ...(o.extractor ? { extractor: o.extractor } : {}), ...(o.transcribe ? { transcribe: o.transcribe } : {}) });
}
