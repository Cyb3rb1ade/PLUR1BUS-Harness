import { isRecord, protocolError, ProviderError } from "../errors.ts";
import type { ChatResult, ChatStreamEvent, FinishReason, PartialChatResult, ResponseMeta, ToolArgumentRepair, ToolCall, ToolDefinition } from "../types.ts";
import { classifyAnthropicStreamError } from "./errors.ts";
import { finaliseToolCall } from "./tool-args.ts";
import type { AnthropicUsage } from "./types.ts";

function protocol(msg: string): ProviderError {
  return protocolError(`malformed Anthropic response: ${msg}`);
}

// ------------------------------------------------------------------------------------------------------------- usage

interface RawUsage { input?: number; output?: number; cacheCreation?: number; cacheRead?: number }

function count(v: Record<string, unknown>, key: string): number | undefined {
  const n = v[key];
  if (n === undefined || n === null) return undefined;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw protocol(`usage.${key} must be a non-negative integer`);
  return n;
}

/** One `usage` object (message_start, message_delta or a non-stream body); a count the object lacks stays absent. */
function readUsage(v: unknown): RawUsage {
  if (!isRecord(v)) throw protocol("usage is not an object");
  const u: RawUsage = {};
  const input = count(v, "input_tokens"), output = count(v, "output_tokens"), read = count(v, "cache_read_input_tokens");
  let creation = count(v, "cache_creation_input_tokens");
  const tiers = v["cache_creation"];
  if (creation === undefined && isRecord(tiers)) {
    const t5 = count(tiers, "ephemeral_5m_input_tokens"), t1 = count(tiers, "ephemeral_1h_input_tokens");
    if (t5 !== undefined || t1 !== undefined) creation = (t5 ?? 0) + (t1 ?? 0);
  }
  if (input !== undefined) u.input = input;
  if (output !== undefined) u.output = output;
  if (creation !== undefined) u.cacheCreation = creation;
  if (read !== undefined) u.cacheRead = read;
  return u;
}

/**
 * RULING: Anthropic's `input_tokens` counts only the part of the prompt that was neither read from nor written to the
 * cache. The neutral `inputTokens` is the whole prompt (as for chat_completions, where cached tokens are a subset), so
 * it is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (the sum of those present);
 * `cachedInputTokens` is the cache-read part and `cacheCreationInputTokens` (an `AnthropicUsage` extra) the written
 * part. `totalTokens` is input + output when BOTH are known. A count the wire did not report stays absent, never 0; a
 * reported 0 is kept.
 */
function normaliseUsage(r: RawUsage): AnthropicUsage | undefined {
  const parts = [r.input, r.cacheCreation, r.cacheRead].filter((x): x is number => x !== undefined);
  const input = parts.length === 0 ? undefined : parts.reduce((a, b) => a + b, 0);
  const u: AnthropicUsage = {};
  if (input !== undefined) u.inputTokens = input;
  if (r.output !== undefined) u.outputTokens = r.output;
  if (input !== undefined && r.output !== undefined) u.totalTokens = input + r.output;
  if (r.cacheRead !== undefined) u.cachedInputTokens = r.cacheRead;
  if (r.cacheCreation !== undefined) u.cacheCreationInputTokens = r.cacheCreation;
  return Object.keys(u).length === 0 ? undefined : u;
}

// ------------------------------------------------------------------------------------------------------ stop reasons

/**
 * `stop_reason` -> outcome, ONE table. `end_turn` and `stop_sequence` are a normal stop; `max_tokens` and
 * `model_context_window_exceeded` ran out of room (`length`); `tool_use` hands the turn to the caller; `refusal` is the
 * model declining on safety grounds: as for chat_completions' `content_filter` it is a RESULT, not an error. `pause_turn`
 * (a server-tool turn the model wants to continue) and anything unrecognised are `other`; the raw value is kept.
 */
const STOP_REASONS: Readonly<Record<string, FinishReason>> = {
  end_turn: "stop", stop_sequence: "stop", max_tokens: "length", model_context_window_exceeded: "length",
  tool_use: "tool_calls", refusal: "content_filter", pause_turn: "other",
};

function normaliseStop(raw: string): FinishReason {
  return Object.hasOwn(STOP_REASONS, raw) ? STOP_REASONS[raw]! : "other";
}

// ------------------------------------------------------------------------------------------------------ accumulator

type BlockKind = "text" | "thinking" | "tool" | "ignored";
interface BlockState { kind: BlockKind; open: boolean }
interface RawCall { id: string; name: string; args: string }

function index(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 4095) throw protocol(`${what} index is not a non-negative integer`);
  return v;
}

/**
 * Folds the Messages API stream events (the parsed `data:` of each SSE event) into `ChatStreamEvent`s and, at the end,
 * one `ChatResult`. Fail closed: a shape it does not understand, an event out of order, a block that is not closed or
 * a stream that never reaches `message_stop` is a `protocol` error, never a half-understood turn. Forward
 * compatibility is the documented exception: an unknown event type is ignored, and so is an unknown content block with
 * its deltas (server-tool blocks, which this adapter never asks for): nothing of them is ever printed as text.
 *
 * `finish` is emitted at `message_stop`, not at `message_delta`: a stream cut between the two stays a failure, and
 * every content event precedes it, as the streaming contract wants.
 */
export class AnthropicAccumulator {
  readonly #redact: (s: string) => string;
  readonly #maxArgs: number;
  readonly #meta: ResponseMeta = {};
  readonly #blocks = new Map<number, BlockState>();
  readonly #calls: RawCall[] = [];
  readonly #toolOf = new Map<number, RawCall>();
  readonly #usage: RawUsage = {};
  #text = "";
  #reasoning = "";
  #started = false;
  #raw: string | undefined;
  #stopped = false;

  constructor(redact: (s: string) => string, maxToolArgumentBytes: number) {
    this.#redact = redact;
    this.#maxArgs = maxToolArgumentBytes;
  }

  /** `message_stop` was seen. */
  get finished(): boolean { return this.#stopped; }
  /** The usage known so far, normalised. */
  get usage(): AnthropicUsage | undefined { return normaliseUsage(this.#usage); }

  push(event: unknown): ChatStreamEvent[] {
    if (!isRecord(event)) throw protocol("event is not an object");
    const type = event["type"];
    if (typeof type !== "string") throw protocol("event has no type");
    if (type === "ping") return [];
    if (type === "error") throw classifyAnthropicStreamError(event, this.#redact);
    if (this.#stopped) {
      if (KNOWN.has(type)) throw protocol(`${type} after message_stop`);
      return [];
    }
    if (type === "message_start") return this.#messageStart(event);
    if (!KNOWN.has(type)) return []; // RULING: an event type this adapter does not know is ignored (the docs ask clients to).
    if (!this.#started) throw protocol(`${type} before message_start`);
    switch (type) {
      case "content_block_start": return this.#blockStart(event);
      case "content_block_delta": return this.#blockDelta(event);
      case "content_block_stop": this.#blockStop(event); return [];
      case "message_delta": this.#messageDelta(event); return [];
      default: return this.#messageStop();
    }
  }

  #messageStart(e: Record<string, unknown>): ChatStreamEvent[] {
    if (this.#started) throw protocol("message_start twice");
    const m = e["message"];
    if (!isRecord(m)) throw protocol("message_start has no message");
    this.#started = true;
    if (typeof m["id"] === "string") this.#meta.id = m["id"];
    if (typeof m["model"] === "string") this.#meta.model = m["model"];
    if (m["usage"] !== undefined && m["usage"] !== null) this.#mergeUsage(m["usage"]);
    return [];
  }

  #mergeUsage(v: unknown): void {
    const u = readUsage(v);
    for (const k of ["input", "output", "cacheCreation", "cacheRead"] as const) if (u[k] !== undefined) this.#usage[k] = u[k];
  }

  #noContentAfterStopReason(what: string): void {
    if (this.#raw !== undefined) throw protocol(`${what} after message_delta carried the stop_reason`);
  }

  #blockStart(e: Record<string, unknown>): ChatStreamEvent[] {
    this.#noContentAfterStopReason("content block");
    const i = index(e["index"], "content block");
    const b = e["content_block"];
    if (!isRecord(b)) throw protocol("content_block is not an object");
    if (this.#blocks.has(i)) throw protocol(`block ${i} already started`);
    const t = b["type"];
    if (typeof t !== "string") throw protocol("content_block has no type");
    const events: ChatStreamEvent[] = [];
    if (t === "text") {
      this.#blocks.set(i, { kind: "text", open: true });
      if (typeof b["text"] === "string" && b["text"] !== "") { this.#text += b["text"]; events.push({ type: "text_delta", text: b["text"] }); }
    } else if (t === "thinking") {
      this.#blocks.set(i, { kind: "thinking", open: true });
      if (typeof b["thinking"] === "string" && b["thinking"] !== "") { this.#reasoning += b["thinking"]; events.push({ type: "reasoning_delta", text: b["thinking"] }); }
    } else if (t === "tool_use") {
      const id = b["id"], name = b["name"];
      if (typeof id !== "string" || id === "") throw protocol("tool_use block lacks an id");
      if (typeof name !== "string" || name === "") throw protocol("tool_use block lacks a name");
      if (this.#calls.some((c) => c.id === id)) throw protocol("duplicate tool call id");
      const toolIndex = this.#calls.length;
      if (toolIndex > 1023) throw protocol("too many tool calls");
      const call: RawCall = { id, name, args: "" };
      this.#calls.push(call);
      this.#toolOf.set(i, call);
      this.#blocks.set(i, { kind: "tool", open: true });
      events.push({ type: "tool_call_start", index: toolIndex, id, name });
    } else {
      // thinking is passed through as reasoning; redacted_thinking and server-tool blocks carry nothing to show.
      this.#blocks.set(i, { kind: "ignored", open: true });
    }
    return events;
  }

  #blockDelta(e: Record<string, unknown>): ChatStreamEvent[] {
    this.#noContentAfterStopReason("content");
    const i = index(e["index"], "content block");
    const block = this.#blocks.get(i);
    if (block === undefined || !block.open) throw protocol(`delta for block ${i} which is not open`);
    const d = e["delta"];
    if (!isRecord(d) || typeof d["type"] !== "string") throw protocol("delta has no type");
    const dt = d["type"];
    if (block.kind === "ignored") return [];
    if (block.kind === "thinking") {
      if (dt === "thinking_delta") {
        const t = d["thinking"];
        if (typeof t !== "string") throw protocol("thinking_delta.thinking is not a string");
        if (t === "") return [];
        this.#reasoning += t;
        return [{ type: "reasoning_delta", text: t }];
      }
      return []; // signature_delta and whatever follows it: opaque bookkeeping, never shown
    }
    if (block.kind === "text") {
      if (dt === "citations_delta") return [];
      if (dt !== "text_delta") throw protocol(dt === "input_json_delta" ? "input_json_delta on a text block" : `unsupported delta type "${dt.slice(0, 40)}" on a text block`);
      const t = d["text"];
      if (typeof t !== "string") throw protocol("text_delta.text is not a string");
      if (t === "") return [];
      this.#text += t;
      return [{ type: "text_delta", text: t }];
    }
    if (dt !== "input_json_delta") throw protocol(dt === "text_delta" ? "text_delta on a tool_use block" : `unsupported delta type "${dt.slice(0, 40)}" on a tool_use block`);
    const frag = d["partial_json"];
    if (typeof frag !== "string") throw protocol("input_json_delta.partial_json is not a string");
    const call = this.#toolOf.get(i)!;
    if (call.args.length + frag.length > this.#maxArgs) throw protocol(`tool call arguments exceed ${this.#maxArgs} bytes`);
    call.args += frag;
    if (frag === "") return [];
    return [{ type: "tool_call_delta", index: this.#calls.indexOf(call), argumentsDelta: frag }];
  }

  #blockStop(e: Record<string, unknown>): void {
    const i = index(e["index"], "content block");
    const block = this.#blocks.get(i);
    if (block === undefined || !block.open) throw protocol(`content_block_stop for block ${i} which is not open`);
    block.open = false;
  }

  #messageDelta(e: Record<string, unknown>): void {
    const d = e["delta"];
    if (d !== undefined && d !== null) {
      if (!isRecord(d)) throw protocol("message_delta.delta is not an object");
      const sr = d["stop_reason"];
      if (sr !== undefined && sr !== null) {
        if (typeof sr !== "string") throw protocol("message_delta.stop_reason is not a string");
        if (this.#raw !== undefined && this.#raw !== sr) throw protocol("conflicting stop_reason");
        this.#raw = sr;
      }
    }
    if (e["usage"] !== undefined && e["usage"] !== null) this.#mergeUsage(e["usage"]);
  }

  #messageStop(): ChatStreamEvent[] {
    if (this.#raw === undefined) throw protocol("message_stop without a stop_reason");
    for (const [i, b] of this.#blocks) if (b.open) throw protocol(`block ${i} was not closed before message_stop`);
    this.#stopped = true;
    return [{ type: "finish", finishReason: normaliseStop(this.#raw), rawFinishReason: this.#raw }];
  }

  /** What had arrived when the stream failed. Tool arguments are unparsed. */
  snapshot(): PartialChatResult {
    const p: PartialChatResult = {
      text: this.#text,
      toolCalls: this.#calls.map((c, index2) => ({ index: index2, id: c.id, name: c.name, argumentsRaw: c.args })),
    };
    if (this.#reasoning) p.reasoning = this.#reasoning;
    const u = this.usage;
    if (u !== undefined) p.usage = u;
    return p;
  }

  /** The end of a stream that reached `message_stop`. */
  async finish(repair: ToolArgumentRepair | undefined, tools: ToolDefinition[] | undefined, signal: AbortSignal): Promise<ChatResult> {
    if (!this.#stopped || this.#raw === undefined) throw protocol("stream ended without message_stop");
    const toolCalls: ToolCall[] = [];
    for (const c of this.#calls) toolCalls.push(await finaliseToolCall(c.id, c.name, c.args, repair, tools, signal));
    const r: ChatResult = { text: this.#text, toolCalls, finishReason: normaliseStop(this.#raw), rawFinishReason: this.#raw, meta: this.#meta };
    if (this.#reasoning) r.reasoning = this.#reasoning;
    const u = this.usage;
    if (u !== undefined) r.usage = u;
    return r;
  }
}

const KNOWN: ReadonlySet<string> = new Set(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);

// ----------------------------------------------------------------------------------------------------- non-stream body

/**
 * The non-stream response body (`type: "message"`) replayed as the stream events it would have been: the stream and
 * the non-stream path then share one parser and give the same `ChatResult` for the same turn. (A non-stream body
 * carries the tool input already parsed, so `argumentsRaw` is its compact re-serialisation, not the model's own text.)
 * An error body is passed through as an `error` event, which the accumulator classifies.
 */
export function* messageToEvents(body: unknown): Generator<unknown, void, void> {
  if (!isRecord(body)) throw protocol("body is not an object");
  if (body["type"] === "error") { yield body; return; }
  if (body["type"] !== "message") throw protocol("body is not a message");
  const content = body["content"];
  if (!Array.isArray(content)) throw protocol("content is not an array");
  yield { type: "message_start", message: { id: body["id"], model: body["model"], usage: body["usage"] } };
  for (const [i, b] of content.entries()) {
    if (!isRecord(b) || typeof b["type"] !== "string") throw protocol("content block is not an object with a type");
    if (b["type"] === "text") {
      yield { type: "content_block_start", index: i, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b["text"] } };
    } else if (b["type"] === "thinking") {
      yield { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } };
      yield { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b["thinking"] } };
    } else if (b["type"] === "tool_use") {
      const input = b["input"] === undefined ? {} : b["input"];
      if (!isRecord(input)) throw protocol("tool_use input is not an object");
      yield { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b["id"], name: b["name"], input: {} } };
      yield { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } };
    } else {
      yield { type: "content_block_start", index: i, content_block: { type: b["type"] } };
    }
    yield { type: "content_block_stop", index: i };
  }
  yield { type: "message_delta", delta: { stop_reason: body["stop_reason"] } };
  yield { type: "message_stop" };
}
