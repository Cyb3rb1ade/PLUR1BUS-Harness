import { isRecord, protocolError, ProviderError } from "../errors.ts";
import type { ChatResult, ChatStreamEvent, FinishReason, PartialChatResult, ResponseMeta, ToolArgumentRepair, ToolCall, ToolDefinition, Usage } from "../types.ts";
import { finaliseToolCall } from "../anthropic/tool-args.ts";
import { classifyResponsesStreamError } from "./errors.ts";

function protocol(msg: string): ProviderError {
  return protocolError(`malformed Responses response: ${msg}`);
}

// ------------------------------------------------------------------------------------------------------------- usage

function count(v: Record<string, unknown>, key: string): number | undefined {
  const n = v[key];
  if (n === undefined || n === null) return undefined;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw protocol(`usage.${key} must be a non-negative integer`);
  return n;
}

/**
 * RULING: `input_tokens` is the whole prompt and `cached_tokens` a subset of it (as for chat_completions), so the neutral
 * fields map one to one. `totalTokens` is the reported `total_tokens`, else input + output when BOTH are known. A count
 * the wire did not report stays absent, never 0; a reported 0 is kept.
 */
function readUsage(v: unknown): Usage | undefined {
  if (!isRecord(v)) throw protocol("usage is not an object");
  const input = count(v, "input_tokens"), output = count(v, "output_tokens"), total = count(v, "total_tokens");
  const inDetails = v["input_tokens_details"], outDetails = v["output_tokens_details"];
  const cached = isRecord(inDetails) ? count(inDetails, "cached_tokens") : undefined;
  const reasoning = isRecord(outDetails) ? count(outDetails, "reasoning_tokens") : undefined;
  const u: Usage = {};
  if (input !== undefined) u.inputTokens = input;
  if (output !== undefined) u.outputTokens = output;
  if (total !== undefined) u.totalTokens = total;
  else if (input !== undefined && output !== undefined) u.totalTokens = input + output;
  if (cached !== undefined) u.cachedInputTokens = cached;
  if (reasoning !== undefined) u.reasoningTokens = reasoning;
  return Object.keys(u).length === 0 ? undefined : u;
}

// ------------------------------------------------------------------------------------------------------ accumulator

type ItemKind = "message" | "reasoning" | "tool" | "ignored";
interface ItemState { kind: ItemKind; open: boolean }
interface RawCall { id: string; name: string; args: string; ordinal: number }

function index(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 4095) throw protocol("output_index is not a non-negative integer");
  return v;
}

const KNOWN: ReadonlySet<string> = new Set([
  "response.output_item.added", "response.output_item.done", "response.output_text.delta", "response.refusal.delta",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.reasoning_summary_text.delta", "response.reasoning_text.delta",
  "response.completed", "response.incomplete", "response.failed",
]);

/**
 * Folds the Responses API stream events (the parsed `data:` of each SSE event; the `type` field is authoritative, the
 * `event:` line is not read) into `ChatStreamEvent`s and, at the end, one `ChatResult`. Fail closed: a shape it does not
 * understand, an event out of order, an item that is not closed or a stream that never reaches a terminal event
 * (`response.completed` / `response.incomplete`) is a `protocol` error. Forward compatibility is the documented
 * exception: an unknown event type is ignored, and so is an unknown output item (web search, file search…) with its
 * events, which this adapter never asks for. Reasoning summary text is `reasoning_delta`, never text.
 *
 * `finish` is emitted at the terminal event, so every content event precedes it, as the streaming contract wants.
 */
export class ResponsesAccumulator {
  readonly #redact: (s: string) => string;
  readonly #maxArgs: number;
  readonly #meta: ResponseMeta = {};
  readonly #items = new Map<number, ItemState>();
  readonly #calls: RawCall[] = [];
  readonly #toolOf = new Map<number, RawCall>();
  #usage: Usage | undefined;
  #text = "";
  #reasoning = "";
  #refused = false;
  #created = false;
  #finish: { reason: FinishReason; raw: string } | undefined;

  constructor(redact: (s: string) => string, maxToolArgumentBytes: number) {
    this.#redact = redact;
    this.#maxArgs = maxToolArgumentBytes;
  }

  /** A terminal event was seen. */
  get finished(): boolean { return this.#finish !== undefined; }
  /** The usage known so far. */
  get usage(): Usage | undefined { return this.#usage; }

  push(event: unknown): ChatStreamEvent[] {
    if (!isRecord(event)) throw protocol("event is not an object");
    const type = event["type"];
    if (typeof type !== "string") throw protocol("event has no type");
    if (type === "error") throw classifyResponsesStreamError(event, this.#redact);
    if (this.#finish !== undefined) {
      if (type === "response.created" || KNOWN.has(type)) throw protocol(`${type} after the terminal event`);
      return [];
    }
    if (type === "response.created") return this.#createdEvent(event);
    if (!KNOWN.has(type)) return []; // RULING: an event type this adapter does not know is ignored.
    if (!this.#created) throw protocol(`${type} before response.created`);
    switch (type) {
      case "response.output_item.added": return this.#itemAdded(event);
      case "response.output_item.done": return this.#itemDone(event);
      case "response.output_text.delta": return this.#textDelta(event, false);
      case "response.refusal.delta": return this.#textDelta(event, true);
      case "response.function_call_arguments.delta": return this.#argsDelta(event);
      case "response.function_call_arguments.done": return this.#argsDone(event);
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": return this.#reasoningDelta(event);
      default: return this.#terminal(type, event);
    }
  }

  #createdEvent(e: Record<string, unknown>): ChatStreamEvent[] {
    if (this.#created) throw protocol("response.created twice");
    this.#readResponse("response.created", e);
    this.#created = true;
    return [];
  }

  #readResponse(type: string, e: Record<string, unknown>): Record<string, unknown> {
    const r = e["response"];
    if (!isRecord(r)) throw protocol(`${type} has no response`);
    if (this.#meta.id === undefined && typeof r["id"] === "string") this.#meta.id = r["id"];
    if (this.#meta.model === undefined && typeof r["model"] === "string") this.#meta.model = r["model"];
    return r;
  }

  #open(e: Record<string, unknown>, what: string): { i: number; item: ItemState } {
    const i = index(e["output_index"]);
    const item = this.#items.get(i);
    if (item === undefined || !item.open) throw protocol(`${what} for item ${i} which is not open`);
    return { i, item };
  }

  #itemAdded(e: Record<string, unknown>): ChatStreamEvent[] {
    const i = index(e["output_index"]);
    const it = e["item"];
    if (!isRecord(it)) throw protocol("item is not an object");
    if (this.#items.has(i)) throw protocol(`item ${i} already added`);
    const t = it["type"];
    if (typeof t !== "string") throw protocol("item has no type");
    if (t === "message") { this.#items.set(i, { kind: "message", open: true }); return []; }
    if (t === "reasoning") { this.#items.set(i, { kind: "reasoning", open: true }); return []; }
    if (t !== "function_call") { this.#items.set(i, { kind: "ignored", open: true }); return []; }
    const callId = it["call_id"], name = it["name"];
    if (typeof callId !== "string" || callId === "") throw protocol("function_call item lacks a call_id");
    if (typeof name !== "string" || name === "") throw protocol("function_call item lacks a name");
    if (this.#calls.some((c) => c.id === callId)) throw protocol("duplicate tool call id");
    if (this.#calls.length > 1023) throw protocol("too many tool calls");
    const call: RawCall = { id: callId, name, args: "", ordinal: this.#calls.length };
    this.#calls.push(call);
    this.#toolOf.set(i, call);
    this.#items.set(i, { kind: "tool", open: true });
    const events: ChatStreamEvent[] = [{ type: "tool_call_start", index: call.ordinal, id: callId, name }];
    if (typeof it["arguments"] === "string") events.push(...this.#settle(call, it["arguments"]));
    return events;
  }

  /** Arguments that arrive whole (`…arguments.done`, the item in `output_item.done`) must agree with the deltas; with no deltas they ARE the arguments. */
  #settle(call: RawCall, full: string): ChatStreamEvent[] {
    if (call.args === "") {
      if (full === "") return [];
      if (full.length > this.#maxArgs) throw protocol(`tool call arguments exceed ${this.#maxArgs} bytes`);
      call.args = full;
      return [{ type: "tool_call_delta", index: call.ordinal, argumentsDelta: full }];
    }
    if (full !== "" && full !== call.args) throw protocol("function_call arguments.done disagrees with the streamed deltas");
    return [];
  }

  #itemDone(e: Record<string, unknown>): ChatStreamEvent[] {
    const { i, item } = this.#open(e, "output_item.done");
    item.open = false;
    const it = e["item"];
    if (item.kind === "tool" && isRecord(it) && typeof it["arguments"] === "string") return this.#settle(this.#toolOf.get(i)!, it["arguments"]);
    return [];
  }

  #textDelta(e: Record<string, unknown>, refusal: boolean): ChatStreamEvent[] {
    const { item } = this.#open(e, refusal ? "refusal.delta" : "output_text.delta");
    const d = e["delta"];
    if (typeof d !== "string") throw protocol("delta is not a string");
    if (item.kind === "tool") throw protocol("text on a function_call item");
    if (item.kind !== "message" || d === "") return [];
    if (refusal) this.#refused = true;
    this.#text += d;
    return [{ type: "text_delta", text: d }];
  }

  #reasoningDelta(e: Record<string, unknown>): ChatStreamEvent[] {
    this.#open(e, "reasoning delta");
    const d = e["delta"];
    if (typeof d !== "string") throw protocol("delta is not a string");
    if (d === "") return [];
    this.#reasoning += d;
    return [{ type: "reasoning_delta", text: d }];
  }

  #argsDelta(e: Record<string, unknown>): ChatStreamEvent[] {
    const { i, item } = this.#open(e, "function_call_arguments.delta");
    const d = e["delta"];
    if (typeof d !== "string") throw protocol("delta is not a string");
    if (item.kind !== "tool") throw protocol("arguments on a message or reasoning item");
    const call = this.#toolOf.get(i)!;
    if (call.args.length + d.length > this.#maxArgs) throw protocol(`tool call arguments exceed ${this.#maxArgs} bytes`);
    call.args += d;
    return d === "" ? [] : [{ type: "tool_call_delta", index: call.ordinal, argumentsDelta: d }];
  }

  #argsDone(e: Record<string, unknown>): ChatStreamEvent[] {
    const { i, item } = this.#open(e, "function_call_arguments.done");
    const a = e["arguments"];
    if (typeof a !== "string") throw protocol("arguments is not a string");
    if (item.kind !== "tool") throw protocol("arguments on a message or reasoning item");
    return this.#settle(this.#toolOf.get(i)!, a);
  }

  #terminal(type: string, e: Record<string, unknown>): ChatStreamEvent[] {
    const r = this.#readResponse(type, e);
    if (type === "response.failed") throw classifyResponsesStreamError(isRecord(r["error"]) ? { error: r["error"] } : {}, this.#redact);
    for (const [i, it] of this.#items) if (it.open) throw protocol(`item ${i} is still open at ${type} (not closed)`);
    if (r["usage"] !== undefined && r["usage"] !== null) this.#usage = readUsage(r["usage"]);
    if (type === "response.completed") {
      const reason: FinishReason = this.#calls.length > 0 ? "tool_calls" : this.#refused ? "content_filter" : "stop";
      this.#finish = { reason, raw: "completed" };
    } else {
      const d = r["incomplete_details"];
      const raw = isRecord(d) && typeof d["reason"] === "string" ? d["reason"] : "incomplete";
      this.#finish = { reason: raw === "max_output_tokens" ? "length" : raw === "content_filter" ? "content_filter" : "other", raw };
    }
    return [{ type: "finish", finishReason: this.#finish.reason, rawFinishReason: this.#finish.raw }];
  }

  /** What had arrived when the stream failed. Tool arguments are unparsed. */
  snapshot(): PartialChatResult {
    const p: PartialChatResult = {
      text: this.#text,
      toolCalls: this.#calls.map((c) => ({ index: c.ordinal, id: c.id, name: c.name, argumentsRaw: c.args })),
    };
    if (this.#reasoning) p.reasoning = this.#reasoning;
    if (this.#usage !== undefined) p.usage = this.#usage;
    return p;
  }

  /** The end of a stream that reached its terminal event. */
  async finish(repair: ToolArgumentRepair | undefined, tools: ToolDefinition[] | undefined, signal: AbortSignal): Promise<ChatResult> {
    if (this.#finish === undefined) throw protocol("stream ended without response.completed");
    const toolCalls: ToolCall[] = [];
    for (const c of this.#calls) toolCalls.push(await finaliseToolCall(c.id, c.name, c.args, repair, tools, signal));
    const r: ChatResult = { text: this.#text, toolCalls, finishReason: this.#finish.reason, rawFinishReason: this.#finish.raw, meta: this.#meta };
    if (this.#reasoning) r.reasoning = this.#reasoning;
    if (this.#usage !== undefined) r.usage = this.#usage;
    return r;
  }
}

// ----------------------------------------------------------------------------------------------------- non-stream body

/**
 * The non-stream response body (`object: "response"`) replayed as the stream events it would have been, so the stream
 * and the non-stream path share one parser and give the same `ChatResult` for the same turn. An error body is passed
 * through as an `error` event, a `failed` response as `response.failed`; both are classified by the accumulator.
 */
export function* responseToEvents(body: unknown): Generator<unknown, void, void> {
  if (!isRecord(body)) throw protocol("body is not an object");
  const status = body["status"];
  if (status === undefined && isRecord(body["error"])) { yield { type: "error", error: body["error"] }; return; }
  const output = body["output"];
  if (status === "failed") { yield { type: "response.created", response: body }; yield { type: "response.failed", response: body }; return; }
  if (status !== "completed" && status !== "incomplete") throw protocol(`status ${typeof status === "string" ? `"${status.slice(0, 40)}"` : "(none)"} is not a final status`);
  if (!Array.isArray(output)) throw protocol("output is not an array");
  yield { type: "response.created", response: { id: body["id"], model: body["model"] } };
  for (const [i, it] of output.entries()) {
    if (!isRecord(it) || typeof it["type"] !== "string") throw protocol("output item is not an object with a type");
    if (it["type"] === "function_call") {
      yield { type: "response.output_item.added", output_index: i, item: { type: "function_call", call_id: it["call_id"], name: it["name"] } };
      if (it["arguments"] !== undefined) yield { type: "response.function_call_arguments.delta", output_index: i, delta: it["arguments"] };
    } else {
      yield { type: "response.output_item.added", output_index: i, item: { type: it["type"] } };
      if (it["type"] === "message" && Array.isArray(it["content"])) {
        for (const c of it["content"]) {
          if (!isRecord(c)) continue;
          if (c["type"] === "output_text") yield { type: "response.output_text.delta", output_index: i, delta: c["text"] };
          else if (c["type"] === "refusal") yield { type: "response.refusal.delta", output_index: i, delta: c["refusal"] };
        }
      } else if (it["type"] === "reasoning" && Array.isArray(it["summary"])) {
        for (const s of it["summary"]) if (isRecord(s) && s["type"] === "summary_text") yield { type: "response.reasoning_summary_text.delta", output_index: i, delta: s["text"] };
      }
    }
    yield { type: "response.output_item.done", output_index: i, item: {} };
  }
  yield { type: status === "completed" ? "response.completed" : "response.incomplete", response: body };
}
