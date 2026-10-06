import type { ContextBlock } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { joinRecall, type PromptBuilder } from "./builder.ts";
import type { CacheTtl } from "./model-table.ts";
import type { ConversationItem, PromptEvent, RenderedPrompt, ToolDef } from "./types.ts";

export interface PromptSessionOptions {
  builder: PromptBuilder;
  agentId: string;
  model: string;
  tools: readonly ToolDef[];
  system: readonly string[];
  /** The frozen memory snapshot, as of session start. There is deliberately no way to replace it afterwards. */
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
 * (RULING for ADR-010 Q2, see the implementation record). Tools and system are copied at open, so a caller mutating its
 * own arrays cannot move the prefix mid-session (R4: that is an explicit new session, with its cache cost, not a side effect).
 */
export function createPromptSession(o: PromptSessionOptions): PromptSession {
  const tools = o.tools.map((t) => structuredClone(t));
  const system = [...o.system];
  const memorySnapshot = o.memorySnapshot;
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
    agentId: o.agentId,
    model: o.model,
    memorySnapshot,
    append(item) { items.push({ ...item }); },
    recall(result, opts = {}) {
      const events: PromptEvent[] = [];
      const j = joinRecall(o.agentId, o.model, { blocks: result.blocks, ...(result.capChars !== undefined ? { capChars: result.capChars } : {}), ...(opts.delivery ? { delivery: opts.delivery } : {}), ...(opts.toolUseId ? { toolUseId: opts.toolUseId } : {}) }, (e) => { events.push(e); o.emit?.(e); });
      const at = recalls.findIndex((r) => r.anchor === items.length);
      if (at >= 0) recalls.splice(at, 1); // RULING: latest recall wins at an anchor
      if (j.text.length) {
        recalls.push({ anchor: items.length, item: j.delivery === "tool_result" ? { role: "user", kind: "tool_result", id: j.toolUseId!, text: j.text } : { role: "user", kind: "context", text: j.text } });
      }
      return events;
    },
    render() {
      const live = recalls.find((r) => r.anchor === items.length);
      return o.builder.render({
        agentId: o.agentId, model: o.model, tools, system, memory: memorySnapshot,
        conversation: conversation(),
        ...(live ? { volatile: { blocks: [{ name: "recall", text: live.item.text, droppable: false, chars: live.item.text.length }], capChars: Infinity, delivery: live.item.kind === "tool_result" ? "tool_result" as const : "context" as const, ...(live.item.id ? { toolUseId: live.item.id } : {}) } } : {}),
        ...(o.cacheTtl ? { cacheTtl: o.cacheTtl } : {}),
        ...(o.zoneCaps ? { zoneCaps: o.zoneCaps } : {}),
      });
    },
  };
}
