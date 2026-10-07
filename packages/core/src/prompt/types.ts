import type { ContextBlock } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { CacheTtl } from "./model-table.ts";

/** ADR-010 §1, in the only order they are ever rendered. `volatile` rides after the last breakpoint and is never cached. */
export type ZoneName = "tools" | "system" | "memory" | "conversation" | "volatile";
export const STABLE_ZONES = ["tools", "system", "memory"] as const;
export type StableZone = (typeof STABLE_ZONES)[number];

export interface ToolDef {
  name: string;
  [field: string]: unknown;
}

/** One conversation entry. `tool_use`/`tool_result` carry the correlation `id`; `context` is a folded recall (L7). */
export interface ConversationItem {
  role: "user" | "assistant";
  kind?: "text" | "tool_use" | "tool_result" | "context";
  text: string;
  id?: string;
}

/** Provider-neutral output unit. `cache` marks a breakpoint: the prefix up to and including this segment is cacheable.
 *  Wire formats (packages/providers) map segments to their request shape; nothing here is provider-specific. */
export interface Segment {
  zone: ZoneName;
  kind: "tool_def" | "system" | "memory" | "text" | "tool_use" | "tool_result" | "context";
  role?: "user" | "assistant";
  text: string;
  id?: string;
  cache?: { ttl: CacheTtl };
}

export interface Breakpoint {
  /** Index into `RenderedPrompt.segments`. */
  segment: number;
  zone: ZoneName;
  ttl: CacheTtl;
  kind: "zone" | "trailing" | "interior";
}

export interface VolatileInput {
  /** The engine's recall blocks (`RecallResult.blocks`), in engine order. */
  blocks: readonly ContextBlock[];
  /** The host's cap (`RecallResult.capChars`); `Infinity` for an uncapped join. Default {@link DEFAULT_VOLATILE_CAP_CHARS}. */
  capChars?: number;
  /** ADR-010 §1: a `tool_result` when recall was tool-invoked, else a trailing user-context block. */
  delivery?: "tool_result" | "context";
  /** Required for `tool_result` delivery. */
  toolUseId?: string;
}

export interface RenderInput {
  agentId: string;
  model: string;
  tools: readonly ToolDef[];
  /** System parts in order (soul, static supplement, safety preamble, instructions). Never time-varying. */
  system: readonly string[];
  /** The frozen memory snapshot (zone 3), as of session start. */
  memory: string;
  conversation: readonly ConversationItem[];
  volatile?: VolatileInput;
  /** Stable-zone breakpoint TTL (default `"5m"`); the trailing breakpoint is always the shortest the model supports. */
  cacheTtl?: CacheTtl;
  /** Zone caps in chars. Tools and system are never clipped. */
  zoneCaps?: { memory?: number };
}

export const DEFAULT_MEMORY_CAP_CHARS = 17_000;
export const DEFAULT_VOLATILE_CAP_CHARS = 17_000;

/** Typed events (engine-spec L3: nothing is clipped, dropped or left uncached silently). */
export type PromptEvent =
  | { type: "prompt.zone-clipped"; agentId: string; model: string; zone: "memory"; from: number; to: number; cap: number; reason: "zone-cap" }
  | { type: "prompt.block-clipped"; agentId: string; model: string; block: string; from: number; to: number; reason: string }
  | { type: "prompt.block-dropped"; agentId: string; model: string; block: string; from: number; to: number; reason: string }
  | { type: "prompt.below-minimum"; agentId: string; model: string; tokensEstimate: number; minTokens: number }
  | { type: "prompt.unknown-model"; agentId: string; model: string }
  | { type: "prompt.lookback-risk"; agentId: string; model: string; positions: number; lookback: number }
  | { type: "prompt.prefix-invalidated"; agentId: string; model: string; from: StableZone };

export type ZoneHashes = Record<ZoneName, string>;

export interface RenderedPrompt {
  agentId: string;
  /** The model id as given. */
  model: string;
  /** sha256 of `{agentId, normalised model}`: the identity of this (agent, model) prefix (R5). */
  prefixKey: string;
  segments: Segment[];
  breakpoints: Breakpoint[];
  /** Per-zone content hashes (R3/R8). */
  zoneHashes: ZoneHashes;
  /** Cumulative: `tools`, `tools+system`, `tools+system+memory`. This is what a provider's cache keys on. */
  prefixHashes: Record<StableZone, string>;
  /** `cold` first render of this (agent, model); `warm` stable zones unchanged since its last render; `invalidated` otherwise. */
  prefix: { status: "cold" | "warm" | "invalidated"; changedFrom?: StableZone };
  /** Rough token estimate of zones 1-3 (chars / 4, deliberately low), used for R2 only. */
  stableTokensEstimate: number;
  events: PromptEvent[];
}
