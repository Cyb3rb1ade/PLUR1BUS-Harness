/** F1 first-party memory tools reuse the admitted turn's memory port, identity and channel policy. */
import type { ChatRequest } from "../session/provider.ts";
import type { TurnMemory } from "../session/memory-port.ts";
import type { ToolDef, ToolRunContext } from "./registry.ts";

const MAX_MEMORY_TEXT_CHARS = 32_000;

/** Stable memory-tool refusal codes preserved by the dispatcher as typed source codes. */
export type MemoryToolErrorCode =
  | "memory-unavailable" | "memory-scope-mismatch" | "memory-incognito" | "memory-read-only";

/** A bounded, model-safe refusal; no caller identity, path or user text enters its message. */
export class MemoryToolError extends Error {
  readonly code: MemoryToolErrorCode;

  constructor(code: MemoryToolErrorCode, message: string) {
    super(message);
    this.name = "MemoryToolError";
    this.code = code;
  }
}

const schema = (field: string) => ({
  type: "object",
  additionalProperties: false,
  required: [field],
  properties: { [field]: { type: "string", minLength: 1, maxLength: MAX_MEMORY_TEXT_CHARS } },
});

/**
 * Creates scoped tools without executing memory work. The schema exposes only text, never identity or scope selectors.
 * Capture has a distinct run id so it cannot consume the engine's automatic post-turn capture idempotency key.
 */
export function createMemoryTools(memory: TurnMemory, req: ChatRequest): ToolDef[] {
  const { agentId, sessionId, turnId, authenticatedPerson, turnProfile, incognito, readOnlyWorktree } = req;
  const caller = req.caller ? { ...req.caller } : undefined;
  const requestSignal = req.signal;
  let captures = 0;
  const admitted = (ctx: ToolRunContext) => {
    requestSignal.throwIfAborted();
    ctx.signal.throwIfAborted();
    if (!caller || turnProfile?.privacyPin) {
      throw new MemoryToolError("memory-unavailable", "Memory requires an admitted caller and an unpinned turn.");
    }
    if (ctx.agentId !== agentId || ctx.sessionId !== sessionId) {
      throw new MemoryToolError("memory-scope-mismatch", "Memory access is limited to this agent and session.");
    }
    return {
      agentId, caller,
      ...(authenticatedPerson ? { authenticatedPerson } : {}),
      ...(turnProfile ? { turnProfile } : {}),
    };
  };
  const classify = () => ({ flags: { outsideRoots: false, denyListHit: false } });
  return [
    {
      name: "memory.recall",
      description: "Recall relevant memory available to the current caller and agent.",
      inputSchema: schema("query"),
      capability: "memory.read", effect: "read", risk: "low", trust: "first-party", classify,
      execute: async (args, ctx) => {
        const identity = admitted(ctx);
        const signal = requestSignal === ctx.signal ? requestSignal : AbortSignal.any([requestSignal, ctx.signal]);
        return memory.recall({ ...identity, query: (args as { query: string }).query, signal });
      },
    },
    {
      name: "memory.capture",
      description: "Submit assistant-authored facts to this caller's memory under the current channel policy.",
      inputSchema: schema("text"),
      capability: "memory.write", effect: "local-write", risk: "low", trust: "first-party", classify,
      execute: async (args, ctx) => {
        const identity = admitted(ctx);
        if (incognito) throw new MemoryToolError("memory-incognito", "Memory capture is unavailable in incognito.");
        if (readOnlyWorktree) {
          throw new MemoryToolError("memory-read-only", "Memory capture is unavailable in a read-only review.");
        }
        // TurnMemory owns the shutdown capture signal and channel content/provenance rules (R19, ADR-003).
        await memory.capture({
          ...identity, sessionId, turnId: `${turnId ?? sessionId}:memory:${++captures}`, incognito: false,
          messages: [{ role: "assistant", content: (args as { text: string }).text }],
        });
        requestSignal.throwIfAborted();
        ctx.signal.throwIfAborted();
        return { submitted: true };
      },
    },
  ];
}
