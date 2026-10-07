import { classifyStreamError, isRecord, protocolError, ProviderError } from "./errors.ts";
import type {
  ChatResult, ChatStreamEvent, FinishReason, JsonObject, PartialChatResult, ResponseMeta, ToolArgumentRepair, ToolCall,
  ToolDefinition, Usage,
} from "./types.ts";

function protocol(msg: string): ProviderError {
  return protocolError(`malformed chat_completions response: ${msg}`);
}

function nonNegInt(v: unknown, what: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw protocol(`${what} must be a non-negative integer`);
  return v;
}

/**
 * `usage` → normalised, or `undefined` when the object carries no count at all. Strict on the numbers (a present
 * value that is not a non-negative integer is a protocol error), tolerant of absent counts and detail objects.
 * RULING: OpenAI fields win; Ollama's native `prompt_eval_count` / `eval_count` are only a fallback for shims that
 * forward them. `totalTokens` is the provider's own total, else input+output when BOTH are known, else absent.
 */
export function parseUsage(v: unknown): Usage | undefined {
  if (!isRecord(v)) throw protocol("usage is not an object");
  const input = nonNegInt(v["prompt_tokens"], "usage.prompt_tokens") ?? nonNegInt(v["prompt_eval_count"], "usage.prompt_eval_count");
  const output = nonNegInt(v["completion_tokens"], "usage.completion_tokens") ?? nonNegInt(v["eval_count"], "usage.eval_count");
  const total = nonNegInt(v["total_tokens"], "usage.total_tokens") ?? (input !== undefined && output !== undefined ? input + output : undefined);
  const pd = v["prompt_tokens_details"], cd = v["completion_tokens_details"];
  const cached = isRecord(pd) ? nonNegInt(pd["cached_tokens"], "usage.prompt_tokens_details.cached_tokens") : undefined;
  const reasoning = isRecord(cd) ? nonNegInt(cd["reasoning_tokens"], "usage.completion_tokens_details.reasoning_tokens") : undefined;
  const u: Usage = {};
  if (input !== undefined) u.inputTokens = input;
  if (output !== undefined) u.outputTokens = output;
  if (total !== undefined) u.totalTokens = total;
  if (cached !== undefined) u.cachedInputTokens = cached;
  if (reasoning !== undefined) u.reasoningTokens = reasoning;
  return Object.keys(u).length === 0 ? undefined : u;
}

export function normaliseFinish(raw: string): FinishReason {
  switch (raw) {
    case "stop": case "length": case "tool_calls": case "content_filter": return raw;
    case "function_call": return "tool_calls";
    default: return "other";
  }
}

interface RawCall { index: number; id?: string; name?: string; args: string }

function readMeta(chunk: Record<string, unknown>, meta: ResponseMeta): void {
  if (typeof chunk["id"] === "string" && meta.id === undefined) meta.id = chunk["id"];
  if (typeof chunk["model"] === "string" && meta.model === undefined) meta.model = chunk["model"];
  if (typeof chunk["system_fingerprint"] === "string" && meta.systemFingerprint === undefined) meta.systemFingerprint = chunk["system_fingerprint"];
}

/**
 * Folds `chat.completion.chunk` objects into events and, at the end, one `ChatResult`. Tool-call deltas are
 * assembled per `index`; everything that does not look like the documented shape is a `protocol` error
 * (fail closed: a half-understood turn is never handed to the agent as if it were whole).
 */
export class ChatAccumulator {
  readonly #redact: (s: string) => string;
  readonly #maxArgs: number;
  readonly #meta: ResponseMeta = {};
  readonly #calls = new Map<number, RawCall>();
  #text = "";
  #reasoning = "";
  #refusal = "";
  #raw: string | undefined;
  #usage: Usage | undefined;

  constructor(redact: (s: string) => string, maxToolArgumentBytes: number) {
    this.#redact = redact;
    this.#maxArgs = maxToolArgumentBytes;
  }

  get finished(): boolean { return this.#raw !== undefined; }

  push(chunk: unknown): ChatStreamEvent[] {
    if (!isRecord(chunk)) throw protocol("chunk is not an object");
    if (chunk["error"] !== undefined && chunk["error"] !== null) throw classifyStreamError(chunk, this.#redact);
    readMeta(chunk, this.#meta);
    const events: ChatStreamEvent[] = [];
    const choices = chunk["choices"], usage = chunk["usage"];
    if (!Array.isArray(choices) && !isRecord(usage)) throw protocol("chunk has neither choices nor usage");
    if (Array.isArray(choices)) for (const c of choices) this.#choice(c, events);
    if (usage !== undefined && usage !== null) {
      const u = parseUsage(usage);
      // RULING: an empty usage object says nothing; it neither emits an event nor erases a usage already known.
      if (u !== undefined) { this.#usage = u; events.push({ type: "usage", usage: u }); }
    }
    return events;
  }

  #choice(c: unknown, events: ChatStreamEvent[]): void {
    if (!isRecord(c)) throw protocol("choice is not an object");
    const idx = c["index"] ?? 0;
    // RULING: only choice 0 exists (the adapter never sends `n`); another index means the server ignored a contract.
    if (idx !== 0) throw protocol("unexpected choice index");
    const delta = c["delta"];
    if (delta !== undefined && delta !== null) {
      if (!isRecord(delta)) throw protocol("delta is not an object");
      this.#delta(delta, events);
    }
    const fr = c["finish_reason"];
    if (fr !== undefined && fr !== null) {
      if (typeof fr !== "string") throw protocol("finish_reason is not a string");
      if (this.#raw !== undefined && this.#raw !== fr) throw protocol("conflicting finish_reason");
      if (this.#raw === undefined) {
        this.#raw = fr;
        events.push({ type: "finish", finishReason: normaliseFinish(fr), rawFinishReason: fr });
      }
    }
  }

  #delta(d: Record<string, unknown>, events: ChatStreamEvent[]): void {
    const role = d["role"];
    if (role !== undefined && role !== null && typeof role !== "string") throw protocol("delta.role is not a string");
    const content = d["content"], refusal = d["refusal"];
    const reasoning = d["reasoning_content"] ?? d["reasoning"];
    const tcs = d["tool_calls"];
    for (const [v, name] of [[content, "content"], [refusal, "refusal"], [reasoning, "reasoning_content"]] as const) {
      if (v !== undefined && v !== null && typeof v !== "string") throw protocol(`delta.${name} is not a string`);
    }
    const any = (typeof content === "string" && content !== "") || (typeof refusal === "string" && refusal !== "") ||
      (typeof reasoning === "string" && reasoning !== "") || (Array.isArray(tcs) && tcs.length > 0);
    if (any && this.#raw !== undefined) throw protocol("content after finish_reason");
    if (typeof content === "string" && content !== "") { this.#text += content; events.push({ type: "text_delta", text: content }); }
    if (typeof reasoning === "string" && reasoning !== "") { this.#reasoning += reasoning; events.push({ type: "reasoning_delta", text: reasoning }); }
    if (typeof refusal === "string" && refusal !== "") this.#refusal += refusal;
    if (tcs !== undefined && tcs !== null) {
      if (!Array.isArray(tcs)) throw protocol("delta.tool_calls is not an array");
      for (const tc of tcs) this.#toolCall(tc, events);
    }
  }

  #toolCall(tc: unknown, events: ChatStreamEvent[]): void {
    if (!isRecord(tc)) throw protocol("tool call delta is not an object");
    // RULING: a delta without an integer `index` cannot be assembled safely, so it is refused rather than guessed.
    const index = tc["index"];
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > 1023) throw protocol("tool call delta lacks a valid index");
    let call = this.#calls.get(index);
    const fresh = call === undefined;
    if (call === undefined) { call = { index, args: "" }; this.#calls.set(index, call); }
    const id = tc["id"];
    if (id !== undefined && id !== null) {
      if (typeof id !== "string" || id === "") throw protocol("tool call id is not a non-empty string");
      if (call.id !== undefined && call.id !== id) throw protocol(`tool call ${index} changed its id`);
      call.id = id;
    }
    const fn = tc["function"];
    let argsDelta = "";
    if (fn !== undefined && fn !== null) {
      if (!isRecord(fn)) throw protocol("tool call function is not an object");
      const name = fn["name"], args = fn["arguments"];
      if (name !== undefined && name !== null && name !== "") {
        if (typeof name !== "string") throw protocol("tool call name is not a string");
        if (call.name !== undefined && call.name !== name) throw protocol(`tool call ${index} changed its name`);
        call.name = name;
      }
      if (args !== undefined && args !== null) {
        if (typeof args !== "string") throw protocol("tool call arguments are not a string");
        argsDelta = args;
        if (call.args.length + args.length > this.#maxArgs) throw protocol(`tool call ${index} arguments exceed ${this.#maxArgs} bytes`);
        call.args += args;
      }
    }
    if (fresh) {
      const ev: ChatStreamEvent = { type: "tool_call_start", index };
      if (call.id !== undefined) ev.id = call.id;
      if (call.name !== undefined) ev.name = call.name;
      events.push(ev);
    }
    if (argsDelta !== "") events.push({ type: "tool_call_delta", index, argumentsDelta: argsDelta });
  }

  snapshot(): PartialChatResult {
    const p: PartialChatResult = {
      text: this.#text,
      toolCalls: [...this.#calls.values()].sort((a, b) => a.index - b.index).map((c) => {
        const o: PartialChatResult["toolCalls"][number] = { index: c.index, argumentsRaw: c.args };
        if (c.id !== undefined) o.id = c.id;
        if (c.name !== undefined) o.name = c.name;
        return o;
      }),
    };
    if (this.#reasoning) p.reasoning = this.#reasoning;
    if (this.#usage) p.usage = this.#usage;
    return p;
  }

  /** The end of a stream that reached `[DONE]`. */
  async finish(repair: ToolArgumentRepair | undefined, tools: ToolDefinition[] | undefined, signal: AbortSignal): Promise<ChatResult> {
    if (this.#raw === undefined) throw protocol("stream ended without a finish_reason");
    const raw = [...this.#calls.values()].sort((a, b) => a.index - b.index);
    return buildResult({
      text: this.#text, reasoning: this.#reasoning, refusal: this.#refusal, calls: raw, rawFinish: this.#raw, usage: this.#usage, meta: this.#meta,
    }, repair, tools, signal);
  }
}

interface ResultParts {
  text: string; reasoning: string; refusal: string; calls: RawCall[]; rawFinish: string; usage: Usage | undefined; meta: ResponseMeta;
}

async function buildResult(p: ResultParts, repair: ToolArgumentRepair | undefined, tools: ToolDefinition[] | undefined, signal: AbortSignal): Promise<ChatResult> {
  const seen = new Set<string>();
  const toolCalls: ToolCall[] = [];
  for (const c of p.calls) {
    if (c.id === undefined || c.name === undefined) throw protocol(`tool call ${c.index} lacks an id or a name`);
    if (seen.has(c.id)) throw protocol(`duplicate tool call id`);
    seen.add(c.id);
    toolCalls.push(await finaliseCall(c.id, c.name, c.args, repair, tools, signal));
  }
  const r: ChatResult = { text: p.text, toolCalls, finishReason: normaliseFinish(p.rawFinish), rawFinishReason: p.rawFinish, meta: p.meta };
  if (p.reasoning) r.reasoning = p.reasoning;
  if (p.refusal) r.refusal = p.refusal;
  if (p.usage) r.usage = p.usage;
  return r;
}

function parseArgs(text: string): { ok: true; value: JsonObject } | { ok: false; error: string } {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { return { ok: false, error: `arguments are not valid JSON: ${(e as Error).message}` }; }
  if (!isRecord(v)) return { ok: false, error: "arguments must be a JSON object" };
  return { ok: true, value: v as JsonObject };
}

async function finaliseCall(id: string, name: string, raw: string, repair: ToolArgumentRepair | undefined, tools: ToolDefinition[] | undefined, signal: AbortSignal): Promise<ToolCall> {
  const first = parseArgs(raw);
  if (first.ok) return { id, name, argumentsRaw: raw, arguments: first.value };
  const failed: ToolCall = { id, name, argumentsRaw: raw, argumentsError: first.error };
  if (!repair) return failed;
  let outcome;
  try {
    const input: Parameters<ToolArgumentRepair["repair"]>[0] = { call: { id, name, argumentsRaw: raw }, error: first.error, signal };
    const tool = tools?.find((t) => t.name === name);
    if (tool) input.tool = tool;
    outcome = await repair.repair(input);
  } catch (e) {
    if (signal.aborted) throw e;
    return failed; // a broken repair hook never loses the turn; the call keeps its original error
  }
  if (!outcome) return failed;
  if ("arguments" in outcome) {
    if (!isRecord(outcome.arguments)) return failed;
    return { id, name, argumentsRaw: JSON.stringify(outcome.arguments), arguments: outcome.arguments, repaired: true };
  }
  const second = parseArgs(outcome.argumentsRaw);
  if (!second.ok) return failed;
  return { id, name, argumentsRaw: outcome.argumentsRaw, arguments: second.value, repaired: true };
}

/** The non-stream response body (`chat.completion`) → the same `ChatResult`. */
export async function parseCompletion(body: unknown, redact: (s: string) => string, repair: ToolArgumentRepair | undefined, tools: ToolDefinition[] | undefined, signal: AbortSignal): Promise<ChatResult> {
  if (!isRecord(body)) throw protocol("body is not an object");
  if (body["error"] !== undefined && body["error"] !== null) throw classifyStreamError(body, redact);
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) throw protocol("choices is missing or empty");
  const c = choices[0];
  if (!isRecord(c) || !isRecord(c["message"])) throw protocol("choices[0].message is missing");
  const m = c["message"];
  const fr = c["finish_reason"];
  if (typeof fr !== "string") throw protocol("finish_reason is missing");
  const content = m["content"], refusal = m["refusal"], reasoning = m["reasoning_content"] ?? m["reasoning"];
  for (const [v, n] of [[content, "content"], [refusal, "refusal"], [reasoning, "reasoning_content"]] as const) {
    if (v !== undefined && v !== null && typeof v !== "string") throw protocol(`message.${n} is not a string`);
  }
  const meta: ResponseMeta = {};
  readMeta(body, meta);
  const calls: RawCall[] = [];
  const tcs = m["tool_calls"];
  if (tcs !== undefined && tcs !== null) {
    if (!Array.isArray(tcs)) throw protocol("message.tool_calls is not an array");
    tcs.forEach((tc, index) => {
      if (!isRecord(tc) || !isRecord(tc["function"])) throw protocol("tool call is malformed");
      const fn = tc["function"];
      if (typeof tc["id"] !== "string" || tc["id"] === "" || typeof fn["name"] !== "string" || fn["name"] === "" || typeof fn["arguments"] !== "string") {
        throw protocol("tool call lacks id, name or string arguments");
      }
      calls.push({ index, id: tc["id"], name: fn["name"], args: fn["arguments"] });
    });
  }
  return buildResult({
    text: typeof content === "string" ? content : "", reasoning: typeof reasoning === "string" ? reasoning : "",
    refusal: typeof refusal === "string" ? refusal : "", calls, rawFinish: fr,
    usage: body["usage"] === undefined || body["usage"] === null ? undefined : parseUsage(body["usage"]), meta,
  }, repair, tools, signal);
}
