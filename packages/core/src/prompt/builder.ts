import { joinBlocks } from "../join.ts";
import { canonicalJson, normalizeText, sha256Hex } from "./canonical.ts";
import { lookupCacheProfile, normalizeModelId, type CacheProfile, type CacheTtl } from "./model-table.ts";
import {
  DEFAULT_MEMORY_CAP_CHARS, DEFAULT_VOLATILE_CAP_CHARS, STABLE_ZONES,
  type Breakpoint, type ConversationItem, type PromptEvent, type RenderInput, type RenderedPrompt, type Segment, type StableZone, type VolatileInput, type ZoneName,
} from "./types.ts";

/** ADR-010 R1: the second trailing breakpoint sits this many positions behind the last one, inside Anthropic's 20-position lookback. */
const INTERIOR_BACK = 15;

export interface PromptBuilder {
  /** Pure apart from the per-(agent, model) prefix registry (R5): the same input renders byte-identical segments. */
  render(input: RenderInput): RenderedPrompt;
}

export interface PromptBuilderOptions {
  /** Called once per event, in order, as each render produces it (the same events are also on the result). */
  emit?: (event: PromptEvent) => void;
}

/** Same-length-or-shorter prefix of `text` that never ends on a high surrogate. */
function safeKeep(text: string, keep: number): number {
  if (keep <= 0) return 0;
  const unit = text.charCodeAt(keep - 1);
  return unit >= 0xd800 && unit <= 0xdbff ? keep - 1 : keep;
}

/** Clip the frozen snapshot to `cap` chars on a line (record) boundary when that keeps at least half the cap; else hard-cut. */
function clipSnapshot(text: string, cap: number): string {
  const hard = safeKeep(text, cap);
  const nl = text.lastIndexOf("\n", hard);
  return (nl >= cap / 2 ? text.slice(0, nl) : text.slice(0, hard)).trimEnd();
}

const tokens = (chars: number): number => Math.ceil(chars / 4);

/** Collapses consecutive `tool_use` (and consecutive `tool_result`) segments into one position, as Anthropic's lookback counts them. */
function positionsOf(convo: readonly Segment[]): number[] {
  let pos = 0;
  return convo.map((s, i) => {
    const prev = convo[i - 1]?.kind;
    if (!((s.kind === "tool_use" || s.kind === "tool_result") && prev === s.kind)) pos += 1;
    return pos;
  });
}

const project = (s: Segment) => ({ kind: s.kind, role: s.role, id: s.id, text: s.text });

/**
 * Joins the engine's recall blocks under the host cap (the harness's own `joinBlocks`, spec §6.6) and reports every clip or
 * drop as a typed event (engine-spec L3). Shared by the builder (a one-shot volatile tail) and the session (a recall that
 * later folds into the conversation, joined and reported once).
 */
export function joinRecall(agentId: string, model: string, v: VolatileInput, push: (e: PromptEvent) => void): { text: string; delivery: "tool_result" | "context"; toolUseId?: string } {
  const blocks = v.blocks.map((b) => { const text = normalizeText(b.text); return { ...b, text, chars: text.length }; });
  const { text, deferrals } = joinBlocks(blocks, v.capChars ?? DEFAULT_VOLATILE_CAP_CHARS);
  for (const d of deferrals) {
    push({ type: d.kind === "clipped" ? "prompt.block-clipped" : "prompt.block-dropped", agentId, model, block: d.block, from: d.from, to: d.to, reason: d.reason });
  }
  const delivery = v.delivery ?? "context";
  if (delivery === "tool_result" && !v.toolUseId) throw new TypeError("volatile tool_result delivery needs toolUseId");
  return { text, delivery, ...(v.toolUseId ? { toolUseId: v.toolUseId } : {}) };
}

export function createPromptBuilder(options: PromptBuilderOptions = {}): PromptBuilder {
  const known = new Map<string, Record<StableZone, string>>();

  function render(input: RenderInput): RenderedPrompt {
    const { agentId, model } = input;
    const events: PromptEvent[] = [];
    const push = (e: PromptEvent) => { events.push(e); options.emit?.(e); };
    const profile: CacheProfile = lookupCacheProfile(model);
    if (!profile.known) push({ type: "prompt.unknown-model", agentId, model });

    // Zone 1: tools, one segment each, sorted by name so registration order never reaches the prefix.
    const names = new Set<string>();
    const toolSegs: Segment[] = [...input.tools]
      .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
      .map((t) => {
        if (names.has(t.name)) throw new TypeError(`duplicate tool name: ${t.name}`);
        names.add(t.name);
        return { zone: "tools", kind: "tool_def", text: canonicalJson(t) } as Segment;
      });

    // Zone 2: system parts, in the caller's order (order is meaning here).
    const systemSegs: Segment[] = input.system.map(normalizeText).filter((t) => t.length).map((text) => ({ zone: "system", kind: "system", text }));

    // Zone 3: the frozen snapshot, capped (L3: a clip is an event).
    const memCap = input.zoneCaps?.memory ?? DEFAULT_MEMORY_CAP_CHARS;
    let memText = normalizeText(input.memory);
    if (memText.length > memCap) {
      const from = memText.length;
      memText = clipSnapshot(memText, memCap);
      push({ type: "prompt.zone-clipped", agentId, model, zone: "memory", from, to: memText.length, cap: memCap, reason: "zone-cap" });
    }
    const memSegs: Segment[] = memText.length ? [{ zone: "memory", kind: "memory", text: memText }] : [];

    // Zone 4: the conversation, append-only.
    const convSegs: Segment[] = input.conversation.map((item: ConversationItem) => {
      const kind = item.kind ?? "text";
      if ((kind === "tool_use" || kind === "tool_result") && !item.id) throw new TypeError(`conversation ${kind} needs an id`);
      return { zone: "conversation", kind, role: item.role, text: normalizeText(item.text), ...(item.id ? { id: item.id } : {}) } as Segment;
    });

    // The volatile tail: engine blocks joined under the host cap, after the last breakpoint, never cached.
    const volSegs: Segment[] = [];
    if (input.volatile) {
      const j = joinRecall(agentId, model, input.volatile, push);
      if (j.text.length) volSegs.push(j.delivery === "tool_result" ? { zone: "volatile", kind: "tool_result", role: "user", text: j.text, id: j.toolUseId } : { zone: "volatile", kind: "context", role: "user", text: j.text });
    }

    const segments: Segment[] = [...toolSegs, ...systemSegs, ...memSegs, ...convSegs, ...volSegs];
    const indexOf = (zone: ZoneName) => segments.reduce((last, s, i) => (s.zone === zone ? i : last), -1);

    // R2: warn, never pad, when the stable prefix cannot clear the model's floor.
    const stableChars = [...toolSegs, ...systemSegs, ...memSegs].reduce((n, s) => n + s.text.length, 0);
    const stableTokensEstimate = tokens(stableChars);
    if (profile.known && stableChars > 0 && stableTokensEstimate < profile.minTokens) {
      push({ type: "prompt.below-minimum", agentId, model, tokensEstimate: stableTokensEstimate, minTokens: profile.minTokens });
    }

    // R1: breakpoint placement from the model table.
    const breakpoints: Breakpoint[] = [];
    if (profile.mechanism === "explicit" && profile.maxBreakpoints > 0) {
      const wanted: CacheTtl = input.cacheTtl ?? "5m";
      const stableTtl = profile.ttls.includes(wanted) ? wanted : profile.ttls[0]!;
      const trailingTtl: CacheTtl = profile.ttls.includes("5m") ? "5m" : profile.ttls[0]!;
      const hasTrailing = convSegs.length > 0;
      // Lowest priority first: tools, system, memory. The trailing breakpoint is kept before any zone breakpoint.
      let zones = (STABLE_ZONES as readonly ZoneName[]).filter((z) => indexOf(z) >= 0);
      const room = profile.maxBreakpoints - (hasTrailing ? 1 : 0);
      if (zones.length > room) zones = zones.slice(zones.length - Math.max(room, 0));
      for (const z of zones) breakpoints.push({ segment: indexOf(z), zone: z, ttl: stableTtl, kind: "zone" });
      if (hasTrailing) {
        const first = toolSegs.length + systemSegs.length + memSegs.length;
        const pos = positionsOf(convSegs);
        const total = pos[pos.length - 1]!;
        const free = profile.maxBreakpoints - zones.length - 1;
        if (total > INTERIOR_BACK && free > 0) {
          const target = total - INTERIOR_BACK;
          let at = -1;
          pos.forEach((p, i) => { if (p === target) at = i; });
          breakpoints.push({ segment: first + at, zone: "conversation", ttl: trailingTtl, kind: "interior" });
        } else if (total > profile.lookbackPositions) {
          push({ type: "prompt.lookback-risk", agentId, model, positions: total, lookback: profile.lookbackPositions });
        }
        breakpoints.push({ segment: first + convSegs.length - 1, zone: "conversation", ttl: trailingTtl, kind: "trailing" });
      }
      for (const bp of breakpoints) segments[bp.segment]!.cache = { ttl: bp.ttl };
    }

    // R3/R8: per-zone hashes and cumulative prefix hashes.
    const zoneHash = (zone: ZoneName) => sha256Hex(canonicalJson({ v: "plur1bus.prompt.zone/1", zone, segments: segments.filter((s) => s.zone === zone).map(project) }));
    const zoneHashes = Object.fromEntries((["tools", "system", "memory", "conversation", "volatile"] as const).map((z) => [z, zoneHash(z)])) as RenderedPrompt["zoneHashes"];
    const prefixHashes = {} as RenderedPrompt["prefixHashes"];
    STABLE_ZONES.forEach((z, i) => {
      prefixHashes[z] = sha256Hex(canonicalJson({ v: "plur1bus.prompt.prefix/1", zones: STABLE_ZONES.slice(0, i + 1).map((s) => zoneHashes[s]) }));
    });

    // R5: one prefix per (agent, model); a change is reported so the host can warn before it costs a full re-read (R4).
    const prefixKey = sha256Hex(canonicalJson({ agentId, model: normalizeModelId(model) }));
    const before = known.get(prefixKey);
    let prefix: RenderedPrompt["prefix"] = { status: "cold" };
    if (before) {
      const changedFrom = STABLE_ZONES.find((z) => before[z] !== prefixHashes[z]);
      prefix = changedFrom ? { status: "invalidated", changedFrom } : { status: "warm" };
      if (changedFrom) push({ type: "prompt.prefix-invalidated", agentId, model, from: changedFrom });
    }
    known.set(prefixKey, { ...prefixHashes });

    return { agentId, model, prefixKey, segments, breakpoints, zoneHashes, prefixHashes, prefix, stableTokensEstimate, events };
  }

  return { render };
}
