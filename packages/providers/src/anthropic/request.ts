import { isRecord, ProviderError } from "../errors.ts";
import { validateRequest } from "../request.ts";
import type { ChatMessage, ContentPart, JsonObject, ToolChoice } from "../types.ts";
import type { AnthropicCacheOptions, AnthropicRequest } from "./types.ts";

export interface AnthropicBuildOptions {
  stream: boolean;
  /** `max_tokens` is mandatory on the wire: the request's `maxTokens` wins, this fills the gap. */
  defaultMaxTokens: number;
  /** Adapter-level cache default; a request's own `providerOptions.anthropic.cache` replaces it. */
  cache?: AnthropicCacheOptions | undefined;
}

type Block = { type: string; [key: string]: unknown };
interface Turn { role: "user" | "assistant"; blocks: Block[] }

const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const TOOL_ID_OK = /^[a-zA-Z0-9_-]+$/;

function bad(msg: string): ProviderError {
  return new ProviderError("invalid_request", `invalid request: ${msg}`);
}

const blank = (s: string): boolean => s.trim() === "";

/**
 * Tool-call ids must match `^[a-zA-Z0-9_-]+$` on this wire; ids minted by other adapters in the same session (Gemini's
 * carry `~` and base64 characters) are rewritten deterministically, and a collision after rewriting is refused.
 */
class ToolIds {
  readonly #forward = new Map<string, string>();
  readonly #taken = new Map<string, string>();

  wire(id: string): string {
    const known = this.#forward.get(id);
    if (known !== undefined) return known;
    const safe = TOOL_ID_OK.test(id) ? id : id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const owner = this.#taken.get(safe);
    if (owner !== undefined && owner !== id) throw bad("two tool call ids collide once rewritten to the Anthropic id alphabet");
    this.#forward.set(id, safe);
    this.#taken.set(safe, id);
    return safe;
  }
}

function imageBlock(p: Extract<ContentPart, { type: "image_url" }>, at: string): Block {
  const data = IMAGE_DATA_URL.exec(p.url);
  if (data !== null) return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  let u: URL | undefined;
  try { u = new URL(p.url); } catch { /* refused below */ }
  if (u !== undefined && (u.protocol === "https:" || u.protocol === "http:")) return { type: "image", source: { type: "url", url: p.url } };
  throw bad(`${at} has an image that is neither an http(s) URL nor a base64 data URL of jpeg, png, gif or webp`);
}

function userBlocks(content: string | ContentPart[], at: string): Block[] {
  if (typeof content === "string") {
    if (blank(content)) throw bad(`${at} is empty (the Messages API refuses blank text)`);
    return [{ type: "text", text: content }];
  }
  const out: Block[] = [];
  for (const p of content) {
    if (p.type === "text") { if (!blank(p.text)) out.push({ type: "text", text: p.text }); }
    else out.push(imageBlock(p, at));
  }
  if (out.length === 0) throw bad(`${at} is empty (the Messages API refuses blank text)`);
  return out;
}

function parseCallInput(args: string, at: string): JsonObject {
  let v: unknown;
  try { v = JSON.parse(args); } catch { throw bad(`${at} has tool call arguments that are not valid JSON`); }
  if (!isRecord(v)) throw bad(`${at} has tool call arguments that are not a JSON object`);
  return v as JsonObject;
}

function assistantBlocks(m: Extract<ChatMessage, { role: "assistant" }>, at: string, ids: ToolIds): Block[] {
  const out: Block[] = [];
  if (typeof m.content === "string" && !blank(m.content)) out.push({ type: "text", text: m.content });
  for (const c of m.toolCalls ?? []) out.push({ type: "tool_use", id: ids.wire(c.id), name: c.name, input: parseCallInput(c.arguments, at) });
  if (out.length === 0) throw bad(`${at} is empty: an assistant message needs text or tool calls`);
  return out;
}

function wireToolChoice(choice: ToolChoice | undefined, parallel: boolean | undefined): Record<string, unknown> | undefined {
  let tc: Record<string, unknown> | undefined;
  if (choice === "auto") tc = { type: "auto" };
  else if (choice === "required") tc = { type: "any" };
  else if (choice === "none") return { type: "none" };
  else if (choice !== undefined) tc = { type: "tool", name: choice.name };
  if (parallel === false) tc = { ...(tc ?? { type: "auto" }), disable_parallel_tool_use: true };
  return tc;
}

const marker = (cache: AnthropicCacheOptions): Record<string, unknown> =>
  (cache.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" });

function checkPairing(turns: Turn[]): void {
  turns.forEach((turn, t) => {
    const ids = (blocks: Block[] | undefined, type: string, key: string): string[] =>
      (blocks ?? []).filter((b) => b.type === type).map((b) => b[key] as string);
    if (turn.role === "assistant") {
      const next = turns[t + 1];
      const answered = next?.role === "user" ? ids(next.blocks, "tool_result", "tool_use_id") : [];
      for (const id of ids(turn.blocks, "tool_use", "id")) if (!answered.includes(id)) throw bad(`tool call ${id} has no tool result right after it`);
    } else {
      const prev = turns[t - 1];
      const asked = prev?.role === "assistant" ? ids(prev.blocks, "tool_use", "id") : [];
      for (const id of ids(turn.blocks, "tool_result", "tool_use_id")) if (!asked.includes(id)) throw bad(`tool result for ${id} does not answer a tool call of the assistant message right before it`);
    }
  });
}

/**
 * The Messages API request body, as a plain object with a fixed key order (`model`, `max_tokens`, `system`,
 * `messages`, `tools`, `tool_choice`, `temperature`, `top_p`, `stop_sequences`, `stream`): the same request gives the
 * same bytes, which is what prompt caching keys on. Fail closed: whatever the wire cannot express (a leading assistant
 * turn, a tool result without its call, blank text, `responseFormat`, temperature above 1) is refused before any I/O.
 */
export function buildAnthropicBody(req: AnthropicRequest, opts: AnthropicBuildOptions): Record<string, unknown> {
  validateRequest(req);
  if (req.temperature !== undefined && req.temperature > 1) throw bad("temperature must be within 0..1 for the Messages API");
  if (req.responseFormat !== undefined && req.responseFormat.type !== "text") throw bad(`responseFormat "${req.responseFormat.type}" is not supported by the Messages API`);

  const ids = new ToolIds();
  const system: Block[] = [];
  const turns: Turn[] = [];
  const push = (role: Turn["role"], blocks: Block[]): void => {
    const last = turns[turns.length - 1];
    if (last?.role === role) last.blocks.push(...blocks);
    else turns.push({ role, blocks });
  };
  req.messages.forEach((m, i) => {
    const at = `messages[${i}]`;
    switch (m.role) {
      case "system":
      case "developer":
        // RULING: system messages anywhere in the list are hoisted, in order, into the one top-level `system`.
        if (!blank(m.content)) system.push({ type: "text", text: m.content });
        return;
      case "user": push("user", userBlocks(m.content, at)); return;
      case "assistant": push("assistant", assistantBlocks(m, at, ids)); return;
      case "tool": {
        const result: Block = { type: "tool_result", tool_use_id: ids.wire(m.toolCallId) };
        if (m.content !== "") result["content"] = m.content;
        push("user", [result]);
        return;
      }
    }
  });
  if (turns[0]?.role !== "user") throw bad("the first non-system message must be a user message");
  // The API wants a user turn's tool results before any other block in it.
  for (const t of turns) if (t.role === "user") t.blocks = [...t.blocks.filter((b) => b.type === "tool_result"), ...t.blocks.filter((b) => b.type !== "tool_result")];
  checkPairing(turns);

  const tools = (req.tools ?? []).map((t) => {
    const o: Record<string, unknown> = { name: t.name };
    if (t.description !== undefined) o["description"] = t.description;
    o["input_schema"] = t.parameters ?? { type: "object" };
    if (t.strict !== undefined) o["strict"] = t.strict;
    return o;
  });

  const cache = req.providerOptions?.anthropic?.cache ?? opts.cache;
  if (cache !== undefined) {
    const mark = marker(cache);
    if (cache.tools === true && tools.length > 0) tools[tools.length - 1]!["cache_control"] = mark;
    if (cache.system === true && system.length > 0) system[system.length - 1]!["cache_control"] = mark;
    const lastTurn = turns[turns.length - 1]!;
    if (cache.messages === true) lastTurn.blocks[lastTurn.blocks.length - 1]!["cache_control"] = mark;
  }

  const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens ?? opts.defaultMaxTokens };
  if (system.length > 0) body["system"] = system;
  body["messages"] = turns.map((t) => ({ role: t.role, content: t.blocks }));
  if (tools.length > 0) body["tools"] = tools;
  const toolChoice = wireToolChoice(req.toolChoice, req.parallelToolCalls);
  if (toolChoice !== undefined) body["tool_choice"] = toolChoice;
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.topP !== undefined) body["top_p"] = req.topP;
  if (req.stop !== undefined) body["stop_sequences"] = req.stop;
  body["stream"] = opts.stream;
  return body;
}
