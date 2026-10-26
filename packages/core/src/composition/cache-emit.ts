// The one emitter of provider prompt-cache fields (RE-D22, plan §2.6): it rewrites the wire body an adapter produced so
// the builder's breakpoints, the TTL tier and the session's affinity key reach each provider in that provider's own
// shape. What each provider takes is data in packages/providers/schema/cache-profiles.json; this file only knows wires.

import { CACHE_PROFILE_TABLE, anthropicToolId, findCacheProfile, responsesCallId, type CacheAffinity, type CacheProfileRow, type CacheRoute } from '../../../providers/src/index.ts';
import { normalizeText } from '../prompt/canonical.ts';
import type { RenderedPrompt, Segment } from '../prompt/index.ts';

type Body = Record<string, unknown>;
type Block = Record<string, unknown>;

/** A wire position a conversation segment can be matched to: its kind, its correlation id or text, and the object to mark. */
interface Slot { kind: 'text' | 'tool_use' | 'tool_result'; role?: string; id?: string; text?: string; target: Block }

/**
 * Pairs conversation segments with wire slots in order: tool slots by id (in the wire's id alphabet), text by its
 * normalised content. A segment with no slot (an assistant turn whose text was null) leaves the cursor where it was.
 */
function align(prompt: RenderedPrompt, slots: readonly Slot[], wireId: (id: string) => string = id => id): Map<number, Slot> {
  let cursor = 0;
  const positions = new Map<number, Slot>();
  prompt.segments.forEach((s, i) => {
    if (s.zone !== 'conversation') return;
    const id = s.id === undefined ? undefined : wireId(s.id);
    const at = slots.findIndex((b, j) => j >= cursor && b.kind === (s.kind === 'tool_use' || s.kind === 'tool_result' ? s.kind : 'text')
      && (b.kind === 'text' ? typeof b.text === 'string' && normalizeText(b.text) === s.text : b.id === id));
    if (at >= 0) { positions.set(i, slots[at]!); cursor = at + 1; }
  });
  return positions;
}

const stableOf = (prompt: RenderedPrompt): Segment[] => prompt.segments.filter(s => s.zone === 'system' || s.zone === 'memory');

/** Translate precise builder breakpoints after the adapter has produced the Anthropic body. Never cache volatile recall. */
export function anthropicMarkers(body: Body, prompt: RenderedPrompt): Body {
  const tools = body.tools as Block[] | undefined;
  const system = body.system as Block[] | undefined;
  const messages = body.messages as { role: string; content: Block[] }[] | undefined;
  const blocks = messages?.flatMap(m => m.content) ?? [];
  const stable = stableOf(prompt);
  for (const a of [...(tools ?? []), ...(system ?? []), ...blocks]) delete a.cache_control;
  const slots: Slot[] = blocks.map(b => b.type === 'tool_use' ? { kind: 'tool_use', id: b.id as string, target: b }
    : b.type === 'tool_result' ? { kind: 'tool_result', id: b.tool_use_id as string, target: b }
    : { kind: 'text', ...(b.type === 'text' ? { text: b.text as string } : {}), target: b });
  const positions = align(prompt, slots, anthropicToolId);
  for (const bp of prompt.breakpoints) {
    const s = prompt.segments[bp.segment]!;
    let block: Block | undefined;
    if (s.zone === 'tools') block = tools?.at(-1);
    else if (s.zone === 'system' || s.zone === 'memory') block = system?.[stable.indexOf(s)];
    else if (s.zone === 'conversation') block = positions.get(bp.segment)?.target;
    if (block) block.cache_control = { type: 'ephemeral', ...(bp.ttl === '1h' ? { ttl: '1h' } : {}) };
  }
  return body;
}

const marker = (ttl: string) => ({ type: 'ephemeral', ...(ttl === '1h' ? { ttl: '1h' } : {}) });

/** A string content becomes one text part carrying the mark; a part list marks its last text part. */
function markChatContent(m: Block, mark: Block): boolean {
  if (typeof m.content === 'string') { m.content = [{ type: 'text', text: m.content, ...mark }]; return true; }
  const parts = Array.isArray(m.content) ? (m.content as Block[]).filter(p => p.type === 'text') : [];
  const last = parts.at(-1);
  if (!last) return false;
  Object.assign(last, mark);
  return true;
}

/**
 * OpenRouter Chat Completions to an upstream that takes explicit markers: `cache_control` on text parts (system, user and
 * tool messages) and on the last tool. Assistant turns and tool calls are never marked; a breakpoint there is dropped.
 */
export function chatCompletionsMarkers(body: Body, prompt: RenderedPrompt): Body {
  const messages = (body.messages as Block[] | undefined) ?? [];
  const system = messages.filter(m => m.role === 'system' || m.role === 'developer');
  const stable = stableOf(prompt);
  const slots: Slot[] = messages.filter(m => m.role !== 'system' && m.role !== 'developer').flatMap((m): Slot[] => {
    if (m.role === 'tool') return [{ kind: 'tool_result', id: m.tool_call_id as string, target: m }];
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? (m.content as Block[]).filter(p => p.type === 'text').map(p => p.text).join('') : undefined;
    const calls = m.role === 'assistant' ? ((m.tool_calls as Block[] | undefined) ?? []).map((c): Slot => ({ kind: 'tool_use', id: c.id as string, target: m })) : [];
    return [...(text ? [{ kind: 'text' as const, role: m.role as string, text, target: m }] : []), ...calls];
  });
  const positions = align(prompt, slots);
  for (const bp of prompt.breakpoints) {
    const s = prompt.segments[bp.segment]!;
    const mark = { cache_control: marker(bp.ttl) };
    if (s.zone === 'tools') { const last = (body.tools as Block[] | undefined)?.at(-1); if (last) Object.assign(last, mark); continue; }
    if (s.zone === 'system' || s.zone === 'memory') { const m = system[stable.indexOf(s)]; if (m) markChatContent(m, mark); continue; }
    const slot = positions.get(bp.segment);
    if (slot && slot.kind !== 'tool_use' && slot.target.role !== 'assistant') markChatContent(slot.target, mark);
  }
  return body;
}

/**
 * OpenAI Responses, GPT-5.6+ on the OpenAI API: explicit breakpoints as `prompt_cache_breakpoint` on `input_text` parts.
 * Top-level `instructions` cannot hold one, so the stable zones move into a leading developer message, one part per
 * segment. A tool result's output becomes an `input_text` part when it carries a breakpoint. With no breakpoint the
 * request is sent in explicit mode, which neither reads nor writes the cache (no paid write for a prompt with no reuse);
 * when breakpoints were placed but none could land, the request keeps the provider's implicit mode.
 */
export function responsesMarkers(body: Body, prompt: RenderedPrompt): Body {
  const input = (body.input as Block[] | undefined) ?? [];
  const stable = stableOf(prompt);
  const bp = { prompt_cache_breakpoint: { mode: 'explicit' } };
  let landed = 0;
  const stableMarks = new Set(prompt.breakpoints.map(b => prompt.segments[b.segment]!).filter(s => s.zone === 'system' || s.zone === 'memory'));
  if (stableMarks.size > 0 && typeof body.instructions === 'string' && body.instructions === stable.map(s => s.text).join('\n\n')) {
    input.unshift({ type: 'message', role: 'developer', content: stable.map(s => ({ type: 'input_text', text: s.text, ...(stableMarks.has(s) ? bp : {}) })) });
    delete body.instructions;
    landed += stableMarks.size;
  }
  const slots: Slot[] = input.flatMap((it): Slot[] => {
    if (it.type === 'function_call') return [{ kind: 'tool_use', id: it.call_id as string, target: it }];
    if (it.type === 'function_call_output') return [{ kind: 'tool_result', id: it.call_id as string, target: it }];
    if (it.type !== 'message' || it.role === 'developer' || it.role === 'system') return [];
    const parts = (it.content as Block[] | undefined) ?? [];
    return [{ kind: 'text', role: it.role as string, text: parts.filter(p => p.type === 'input_text' || p.type === 'output_text').map(p => p.text).join(''), target: it }];
  });
  const positions = align(prompt, slots, responsesCallId);
  for (const b of prompt.breakpoints) {
    if (prompt.segments[b.segment]!.zone !== 'conversation') continue;
    const slot = positions.get(b.segment);
    if (!slot) continue;
    if (slot.kind === 'tool_result' && typeof slot.target.output === 'string') { slot.target.output = [{ type: 'input_text', text: slot.target.output, ...bp }]; landed++; continue; }
    if (slot.kind === 'text' && slot.role === 'user') {
      const last = ((slot.target.content as Block[] | undefined) ?? []).filter(p => p.type === 'input_text').at(-1);
      if (last) { Object.assign(last, bp); landed++; }
    }
  }
  if (landed > 0 || prompt.breakpoints.length === 0) body.prompt_cache_options = { mode: 'explicit' };
  return body;
}

/** Where the emitter adds request headers; `has` sees the caller's headers too. */
export interface HeaderSink { has(name: string): boolean; set(name: string, value: string): void }

/** Sets a dotted body path or a header, never overwriting a value the adapter or the caller already set. */
function applyAffinity(a: CacheAffinity, value: string, body: Body, headers: HeaderSink): void {
  const v = a.maxLength === null ? value : value.slice(0, a.maxLength);
  if (a.in === 'header') { if (!headers.has(a.field)) headers.set(a.field, v); return; }
  const path = a.field.split('.');
  let at: Body = body;
  for (const key of path.slice(0, -1)) {
    const next = at[key];
    if (next !== undefined && (typeof next !== 'object' || next === null || Array.isArray(next))) return;
    at = (at[key] ??= {}) as Body;
  }
  const leaf = path.at(-1)!;
  if (at[leaf] === undefined) at[leaf] = v;
}

const forWire = (a: { wires?: readonly string[] }, format: string) => a.wires === undefined || a.wires.includes(format);

/**
 * Applies the cache fields for one request. `route` says where the provider fetch goes (from its base URL): a provider's
 * own body fields (affinity keys, TTL tiers, explicit OpenAI breakpoints) are sent only to that provider's own API, an
 * OpenRouter route gets OpenRouter's fields, and the Anthropic wire always gets the builder's markers.
 */
export function emitProviderCache(format: string, body: Body, headers: HeaderSink, route: CacheRoute, prompt: RenderedPrompt): Body {
  if (format === 'anthropic_messages') anthropicMarkers(body, prompt);
  const model = typeof body.model === 'string' ? body.model : prompt.model;
  const row: CacheProfileRow | undefined = findCacheProfile(model, route).row;
  if (route.gateway === 'openrouter') {
    const gateway = CACHE_PROFILE_TABLE.gateways.openrouter;
    for (const a of gateway.affinity) if (forWire(a, format)) applyAffinity(a, prompt.session_id, body, headers);
    if (format === 'chat_completions' && row?.mechanism === 'explicit' && gateway.markerProviders?.includes(row.provider)) chatCompletionsMarkers(body, prompt);
    return body;
  }
  if (!row || route.vendor !== row.provider) return body;
  for (const a of row.affinity) if (forWire(a, format)) applyAffinity(a, prompt.session_id, body, headers);
  if (row.class === 'implicit-ttl-tier' && (format === 'chat_completions' || format === 'codex_responses') && body.prompt_cache_options === undefined) {
    const offered = row.ttls.filter(t => forWire(t, format)).map(t => t.ttl);
    const ttl = prompt.cache.ttl !== null && offered.includes(prompt.cache.ttl) ? prompt.cache.ttl : offered[0];
    if (ttl) body.prompt_cache_options = { mode: 'implicit', ttl };
  }
  if (format === 'codex_responses' && row.provider === 'openai' && row.class === 'explicit-breakpoints' && (route.platform ?? 'first-party') === 'first-party') responsesMarkers(body, prompt);
  return body;
}
