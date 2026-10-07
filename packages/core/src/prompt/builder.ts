import { stickySessionId } from "./telemetry.ts";
import { joinBlocks } from "../join.ts";
import { canonicalJson, normalizeText, sha256Hex } from "./canonical.ts";
import { lookupCacheProfile, normalizeModelId, PROVIDER_CACHE_CONFIG, type CacheProfile, type CacheTtl } from "./model-table.ts";
import {
  DEFAULT_MEMORY_CAP_CHARS, DEFAULT_VOLATILE_CAP_CHARS, STABLE_ZONES,
  type Breakpoint, type ZoneMetadata, type ConversationItem, type PromptEvent, type RenderInput, type RenderedPrompt, type Segment, type StableZone, type VolatileInput, type ZoneName,
} from "./types.ts";

/** ADR-010 R1: the second trailing breakpoint sits this many positions behind the last one, inside Anthropic's 20-position lookback.
 *  RULING: 15, the low end of the ADR's "~15–20 positions back", so it keeps hitting for a full turn of growth. */
const INTERIOR_BACK = 15;

export interface PromptBuilder {
  /** Pure apart from the per-(agent, model) prefix registry (R5): the same input renders byte-identical segments. */
  render(input: RenderInput): RenderedPrompt;
}

export interface PromptBuilderOptions {
  /** Called once per event, in order, as each render produces it (the same events are also on the result). */
  emit?: (event: PromptEvent) => void;
  /** Request-time clock in milliseconds. Generation time therefore consumes TTL. */
  now?: () => number;
  /** Overrides each provider class's expected TTL, including an explicit null for unknown/disabled. */
  cacheTtlMs?: Partial<Record<CacheProfile["provider"], number | null>>;
}

/** Same-length-or-shorter prefix of `text` that never ends on a high surrogate. */
function safeKeep(text: string, keep: number): number {
  if (keep <= 0) return 0;
  const unit = text.charCodeAt(keep - 1);
  return unit >= 0xd800 && unit <= 0xdbff ? keep - 1 : keep;
}

/** RULING: clip the frozen snapshot to `cap` chars on a line (record) boundary when that keeps at least half the cap; else hard-cut. */
function clipSnapshot(text: string, cap: number): string {
  const hard = safeKeep(text, cap);
  const nl = text.lastIndexOf("\n", hard);
  return (nl >= cap / 2 ? text.slice(0, nl) : text.slice(0, hard)).trimEnd();
}

/** RULING: chars / 4 is a deliberately low token estimate (CJK is denser), so R2 warns early rather than late. */
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
  const lastRender = new Map<string, { at: number; hash: string; ttlMs: number | null; eligible: boolean }>();
  const activeModels = new Map<string, string>();
  const now = options.now ?? Date.now;
  const ttlConfig = { ...PROVIDER_CACHE_CONFIG };
  const ttlOverrides = { ...options.cacheTtlMs };
  for (const ttl of Object.values(ttlOverrides)) {
    if (ttl !== null && ttl !== undefined && (!Number.isFinite(ttl) || ttl < 0)) throw new TypeError("cache TTL must be finite and nonnegative or null");
  }

  function render(input: RenderInput): RenderedPrompt {
    const { agentId, model } = input;
    const at = now();
    if (!Number.isFinite(at)) throw new TypeError("prompt clock must be finite");
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

    // Zone 3: the frozen snapshot, capped (L3: a clip is an event). RULING: default cap is the engine's 17 000-char inject budget.
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
      if (j.text.length) volSegs.push(j.delivery === "tool_result" ? { zone: "volatile", kind: "tool_result", role: "user", text: j.text, id: j.toolUseId! } : { zone: "volatile", kind: "context", role: "user", text: j.text });
    }

    const segments: Segment[] = [...toolSegs, ...systemSegs, ...memSegs, ...convSegs, ...volSegs];
    const indexOf = (zone: ZoneName) => segments.reduce((last, s, i) => (s.zone === zone ? i : last), -1);

    // R2: warn, never pad, when the stable prefix cannot clear the model's floor.
    const stableChars = [...toolSegs, ...systemSegs, ...memSegs].reduce((n, s) => n + s.text.length, 0);
    const stableTokensEstimate = tokens(stableChars);
    const eligible = profile.known && stableChars > 0 && stableTokensEstimate >= profile.minTokens;
    if (profile.known && stableTokensEstimate < profile.minTokens) {
      push({ type: "prompt.below-minimum", agentId, model, tokensEstimate: stableTokensEstimate, minTokens: profile.minTokens });
    }

    // R1: breakpoint placement from the model table.
    const breakpoints: Breakpoint[] = [];
    const wanted: CacheTtl = input.cacheTtl ?? "5m";
    const stableTtl = profile.ttls.includes(wanted) ? wanted : (profile.ttls[0] ?? "5m");
    const metadataAt = (segment: number): ZoneMetadata => {
      const text = segments.slice(0, segment + 1).map((s) => s.text).join("");
      return { zone: segments[segment]!.zone, byteOffset: Buffer.byteLength(text), tokenEstimate: tokens(text.length), hash: sha256Hex(text) };
    };
    const addBreakpoint = (segment: number, ttl: CacheTtl, kind: Breakpoint["kind"]) => {
      const metadata = metadataAt(segment);
      if (metadata.tokenEstimate >= profile.minTokens) breakpoints.push({ ...metadata, segment, ttl, kind });
    };
    if (eligible && profile.mechanism === "explicit" && profile.maxBreakpoints > 0) {
      // RULING: the trailing breakpoint always takes the shortest TTL (its content changes every turn); 1h entries therefore precede 5m ones.
      const trailingTtl: CacheTtl = profile.ttls.includes("5m") ? "5m" : profile.ttls[0]!;
      const hasTrailing = convSegs.length > 0;
      // RULING: if the model allows fewer breakpoints than wanted, drop tools first, then system, then memory; the trailing one is kept before any zone.
      let zones = (STABLE_ZONES as readonly ZoneName[]).filter((z) => indexOf(z) >= 0 && metadataAt(indexOf(z)).tokenEstimate >= profile.minTokens);
      const needsInterior = hasTrailing && profile.lookbackPositions > 0 && positionsOf(convSegs).at(-1)! > INTERIOR_BACK;
      const room = profile.maxBreakpoints - (hasTrailing ? 1 : 0) - (needsInterior ? 1 : 0);
      if (zones.length > room) zones = zones.slice(zones.length - Math.max(room, 0));
      for (const z of zones) addBreakpoint(indexOf(z), stableTtl, "zone");
      if (hasTrailing) {
        const first = toolSegs.length + systemSegs.length + memSegs.length;
        const pos = positionsOf(convSegs);
        const total = pos[pos.length - 1]!;
        const free = profile.maxBreakpoints - zones.length - 1;
        if (needsInterior && free > 0) {
          const target = total - INTERIOR_BACK;
          let at = -1;
          pos.forEach((p, i) => { if (p === target) at = i; });
          addBreakpoint(first + at, trailingTtl, "interior");
        } else if (profile.lookbackPositions > 0 && total > profile.lookbackPositions) {
          push({ type: "prompt.lookback-risk", agentId, model, positions: total, lookback: profile.lookbackPositions });
        }
        addBreakpoint(first + convSegs.length - 1, trailingTtl, "trailing");
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
      if (changedFrom) push({ type: "prompt.prefix-invalidated", agentId, model, from: changedFrom, reason: input.invalidationReason ?? "prefix-changed" });
    }
    known.set(prefixKey, { ...prefixHashes });

    // Session identity is metadata only; model switches do not erase other models' entries.
    const session_id = stickySessionId(agentId, input.sessionId);
    const previousModel = activeModels.get(session_id);
    if (previousModel !== undefined && normalizeModelId(previousModel) !== normalizeModelId(model)) {
      push({ type: "prompt.prefix-invalidated", agentId, model, previousModel, reason: "model-changed" });
    }
    activeModels.set(session_id, model);

    const configuredTtl = ttlOverrides[profile.provider];
    const ttlMs = configuredTtl !== undefined ? configuredTtl
      : profile.provider === "anthropic" && stableTtl === "1h" ? 3_600_000 : ttlConfig[profile.provider].ttlMs;
    const renderKey = canonicalJson({ prefixKey, session_id });
    const last = lastRender.get(renderKey);
    const ageMs = last ? at - last.at : null;
    const warm = eligible && last?.eligible === true && last.hash === prefixHashes.memory
      && ageMs !== null && ageMs >= 0 && last.ttlMs !== null && ageMs < last.ttlMs;
    lastRender.set(renderKey, { at, hash: prefixHashes.memory, ttlMs, eligible });
    let byteOffset = 0;
    const zones: ZoneMetadata[] = (["tools", "system", "memory", "conversation", "volatile"] as const).map((zone) => {
      const parts = segments.filter((s) => s.zone === zone);
      byteOffset += parts.reduce((n, s) => n + Buffer.byteLength(s.text), 0);
      return { zone, byteOffset, tokenEstimate: tokens(parts.reduce((n, s) => n + s.text.length, 0)), hash: zoneHashes[zone] };
    });
    const reason: RenderedPrompt["cache"]["reason"] = !profile.known ? "unknown-model" : stableChars === 0 ? "empty-prefix"
      : !eligible ? "below-minimum" : profile.mechanism === "implicit" ? "implicit-provider" : "eligible";
    return { agentId, model, prefixKey, segments, breakpoints, zoneHashes, prefixHashes, prefix, stableTokensEstimate,
      zones, session_id, cache: { provider: profile.provider, mechanism: profile.mechanism, minimumTokens: profile.minTokens,
        eligible, reason, expected: warm ? "warm" : "cold", ageMs, ttlMs }, events };
  }

  return { render };
}
