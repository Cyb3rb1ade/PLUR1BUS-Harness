import type { MediaKind, MediaSource } from "../types.ts";

export type CaptionOrder = "prompt-then-user-then-auto" | "user-only" | "off";
export type CaptionOrigin = "prompt" | "user" | "auto";

/** The slice of `memory.mediaEmbedding.caption.*` the caption layer reads. */
export interface CaptionConfig {
  source: CaptionOrder;
  /** "local", "off", or the id of a configured cloud provider; unset until setup asks (cloud embedding). */
  provider?: string;
  maxChars: number;
  perSegment?: boolean;
}
export interface CaptionResult { text: string; source: CaptionOrigin }

export interface CaptionInput { kind: MediaKind; mime: string; source: MediaSource; signal?: AbortSignal }
export interface CaptionProvider {
  readonly id: string;
  /** true: nothing leaves the machine (the privacy pin allows it). */
  readonly local: boolean;
  caption(input: CaptionInput): Promise<string>;
}

/** What is known about a medium when it enters the store. */
export interface CaptionRequest extends CaptionInput {
  /** Generation or edit prompt (ADR-017 OutputStore manifest `prompt`). */
  prompt?: string;
  /** User-written caption or alt text. */
  userCaption?: string;
}
