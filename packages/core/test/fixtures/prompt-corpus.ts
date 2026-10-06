// A deterministic synthetic corpus for the prompt-builder tests and the B6 gate: no clock, no randomness, no I/O.
import type { ConversationItem, RenderInput, ToolDef } from "../../src/prompt/types.ts";

const lines = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${String(i).padStart(4, "0")}: the quick brown fox jumps over the lazy dog, éè 日本語.`).join("\n");

export const tools: ToolDef[] = [
  { name: "memory_recall", description: "Recall memories.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } } } },
  { name: "file_read", description: "Read a file.", inputSchema: { properties: { path: { type: "string" } }, type: "object", required: ["path"] } },
  { name: "shell", description: "Run a command.", inputSchema: { type: "object", properties: { cmd: { type: "string" }, timeoutMs: { type: "number" } } } },
];

export const system: string[] = [`You are bernd.\n${lines("Rule", 60)}`, "Safety preamble. Operating instructions."];
export const memory: string = lines("Fact", 120);

export function conversation(turns: number): ConversationItem[] {
  const out: ConversationItem[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push({ role: "user", text: `Question ${i}?` });
    out.push({ role: "assistant", text: `Answer ${i}.` });
  }
  return out;
}

export function corpusInput(turns: number, over: Partial<RenderInput> = {}): RenderInput {
  return { agentId: "bernd", model: "claude-sonnet-5-5", tools, system, memory, conversation: conversation(turns), ...over };
}
