import type { ContextBlock } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { joinRecall, type PromptBuilder } from "./builder.ts";
import type { CacheTtl } from "./model-table.ts";
import type { ConversationItem, PromptEvent, RenderedPrompt, ToolDef } from "./types.ts";

export interface PromptSessionOptions {
  builder: PromptBuilder;
  agentId: string;
  model: string;
  /** A host-provided session identity for sticky routing and TTL isolation. */
  sessionId?: string;
  tools: readonly ToolDef[];
  system: readonly string[];
  /** The frozen memory snapshot, as of session start. Replaced only by explicit refreshMemorySnapshot(). */
  memorySnapshot: string;
  cacheTtl?: CacheTtl;
  zoneCaps?: { memory?: number };
  /** Receives the clip events of a recall as it arrives (render-time events come back on the rendered prompt). */
  emit?: (event: PromptEvent) => void;
}

export interface RecallInput {
  blocks: readonly ContextBlock[];
  capChars?: number;
}

export interface PromptSession {
  readonly agentId: string;
  readonly model: string;
  readonly memorySnapshot: string;
  append(item: ConversationItem): void;
  /** Explicitly pay the snapshot invalidation cost; no automatic timer/recall refresh. */
  refreshMemorySnapshot(snapshot: string): void;
  /** Host performs any confirmation before calling; render reports the model-change cost. */
  setModel(model: string): void;
  /** Takes a recall result. It never touches the snapshot: it rides this request's volatile tail, then folds into the
   *  conversation at the point it arrived, so the cached prefix only grows. Returns its clip events (also `emit`ted). */
  recall(result: RecallInput, o?: { delivery?: "tool_result" | "context"; toolUseId?: string }): PromptEvent[];
  render(): RenderedPrompt;
}

interface Folded {
  /** Number of conversation items before the recall: it sits right after item `anchor - 1`. */
  anchor: number;
  item: ConversationItem;
}

/**
 * L7 (ADR-010 §1, zone 3): the snapshot is fixed for the session; a long session stays on it until the next one
 * or an explicit refresh. No automatic refresh is inferred from time or recall. Tools and system are copied at open, so a caller mutating its
 * own arrays cannot move the prefix mid-session (R4: that is an explicit new session, with its cache cost, not a side effect).
 */
export function createPromptSession(o: PromptSessionOptions): PromptSession {
  const tools = o.tools.map((t) => structuredClone(t));
  const system = [...o.system];
  let memorySnapshot = o.memorySnapshot;
  let model = o.model;
  let refreshed = false;
  // Capture scalar options too: caller mutation must not cause a silent mid-session change.
  const { agentId, sessionId, builder, cacheTtl, emit } = o;
  const zoneCaps = o.zoneCaps ? { ...o.zoneCaps } : undefined;
  const items: ConversationItem[] = [];
  const recalls: Folded[] = [];

  function conversation(): ConversationItem[] {
    // Recalls are interleaved at their anchors; the one anchored at the end is the live tail and is rendered as volatile.
    const out: ConversationItem[] = [];
    for (let i = 0; i <= items.length; i += 1) {
      for (const r of recalls) if (r.anchor === i && i < items.length) out.push(r.item);
      if (i < items.length) out.push(items[i]!);
    }
    return out;
  }

  return {
    agentId,
    get model() { return model; },
    get memorySnapshot() { return memorySnapshot; },
    refreshMemorySnapshot(snapshot) { if (snapshot !== memorySnapshot) { memorySnapshot = snapshot; refreshed = true; } },
    setModel(next) { model = next; },
    append(item) { items.push({ ...item }); },
    recall(result, opts = {}) {
      const events: PromptEvent[] = [];
      const j = joinRecall(agentId, model, { blocks: result.blocks, ...(result.capChars !== undefined ? { capChars: result.capChars } : {}), ...(opts.delivery ? { delivery: opts.delivery } : {}), ...(opts.toolUseId ? { toolUseId: opts.toolUseId } : {}) }, (e) => { events.push(e); emit?.(e); });
      const at = recalls.findIndex((r) => r.anchor === items.length);
      if (at >= 0) recalls.splice(at, 1); // RULING: latest recall wins at an anchor
      if (j.text.length) {
        recalls.push({ anchor: items.length, item: j.delivery === "tool_result" ? { role: "user", kind: "tool_result", id: j.toolUseId!, text: j.text } : { role: "user", kind: "context", text: j.text } });
      }
      return events;
    },
    render() {
      const live = recalls.find((r) => r.anchor === items.length);
      const result = builder.render({
        agentId, model, tools, system, memory: memorySnapshot,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(refreshed ? { invalidationReason: "memory-refresh" as const } : {}),
        conversation: conversation(),
        ...(live ? { volatile: { blocks: [{ name: "recall", text: live.item.text, droppable: false, chars: live.item.text.length }], capChars: Infinity, delivery: live.item.kind === "tool_result" ? "tool_result" as const : "context" as const, ...(live.item.id ? { toolUseId: live.item.id } : {}) } } : {}),
        ...(cacheTtl ? { cacheTtl } : {}),
        ...(zoneCaps ? { zoneCaps } : {}),
      });
      refreshed = false;
      return result;
    },
  };
}
