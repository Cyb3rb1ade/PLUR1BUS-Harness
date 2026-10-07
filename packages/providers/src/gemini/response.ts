import { isRecord, protocolError, ProviderError } from "../errors.ts";
import type { ChatResult, ChatStreamEvent, FinishReason, JsonObject, PartialChatResult, ResponseMeta, ToolCall, Usage } from "../types.ts";
import { candidateBlock, classifyGeminiStreamError, isCandidateBlock, promptBlock } from "./errors.ts";
import { toolCallId } from "./request.ts";

function protocol(msg: string, retryable = false): ProviderError {
  return protocolError(`malformed Gemini response: ${msg}`, { retryable });
}

function count(v: Record<string, unknown>, key: string): number {
  const n = v[key];
  if (n === undefined || n === null) return 0;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw protocol(`usageMetadata.${key} must be a non-negative integer`);
  return n;
}

/**
 * `usageMetadata` → `Usage`.
 * RULING: Gemini reports thinking tokens apart from `candidatesTokenCount` but bills them as output, and reports
 * tool-use prompt tokens apart from `promptTokenCount`; so `outputTokens` = candidates + thoughts and `inputTokens` =
 * prompt + tool-use prompt, `reasoningTokens` = thoughts, `cachedInputTokens` = `cachedContentTokenCount` (a subset of
 * the prompt count, as for chat_completions). `totalTokens` is Gemini's own `totalTokenCount` when present, else the sum.
 * A count that is absent is 0 (Gemini omits zeros); one that is not a non-negative integer is a protocol error.
 */
export function parseGeminiUsage(v: unknown): Usage {
  if (!isRecord(v)) throw protocol("usageMetadata is not an object");
  const input = count(v, "promptTokenCount") + count(v, "toolUsePromptTokenCount");
  const thoughts = count(v, "thoughtsTokenCount");
  const output = count(v, "candidatesTokenCount") + thoughts;
  const total = v["totalTokenCount"] === undefined || v["totalTokenCount"] === null ? input + output : count(v, "totalTokenCount");
  const u: Usage = { inputTokens: input, outputTokens: output, totalTokens: total };
  if (v["cachedContentTokenCount"] !== undefined && v["cachedContentTokenCount"] !== null) u.cachedInputTokens = count(v, "cachedContentTokenCount");
  if (v["thoughtsTokenCount"] !== undefined && v["thoughtsTokenCount"] !== null) u.reasoningTokens = thoughts;
  return u;
}

function normaliseFinish(raw: string, hasCalls: boolean): FinishReason {
  if (raw === "STOP") return hasCalls ? "tool_calls" : "stop";
  if (raw === "MAX_TOKENS") return "length";
  return "other";
}

interface RawCall { id: string; name: string; args: string; parsed: JsonObject }

/**
 * Folds `GenerateContentResponse` objects (one per SSE event, or the single non-stream body) into events and one
 * `ChatResult`. Both paths use it, so they give the same result for the same turn. Fail closed: an unexpected shape,
 * a part kind this adapter never asked for, content after the finish, a second candidate or a missing finishReason are
 * `protocol` errors; a safety verdict is a `GeminiSafetyBlockError`.
 */
export class GeminiAccumulator {
  readonly #redact: (s: string) => string;
  readonly #maxArgs: number;
  readonly #meta: ResponseMeta = {};
  readonly #calls: RawCall[] = [];
  #text = "";
  #reasoning = "";
  #raw: string | undefined;
  #usage: Usage | undefined;

  constructor(redact: (s: string) => string, maxToolArgumentBytes: number) {
    this.#redact = redact;
    this.#maxArgs = maxToolArgumentBytes;
  }

  get finished(): boolean { return this.#raw !== undefined; }
  get usage(): Usage | undefined { return this.#usage; }

  push(chunk: unknown): ChatStreamEvent[] {
    if (!isRecord(chunk)) throw protocol("chunk is not an object");
    if (chunk["error"] !== undefined && chunk["error"] !== null) throw classifyGeminiStreamError(chunk, this.#redact);
    if (typeof chunk["responseId"] === "string" && this.#meta.id === undefined) this.#meta.id = chunk["responseId"];
    if (typeof chunk["modelVersion"] === "string" && this.#meta.model === undefined) this.#meta.model = chunk["modelVersion"];
    const pf = chunk["promptFeedback"];
    if (pf !== undefined && pf !== null) {
      if (!isRecord(pf)) throw protocol("promptFeedback is not an object");
      if (pf["blockReason"] !== undefined && pf["blockReason"] !== null) throw promptBlock(pf, this.#redact);
    }
    const events: ChatStreamEvent[] = [];
    const candidates = chunk["candidates"], usage = chunk["usageMetadata"];
    if (candidates !== undefined && candidates !== null) {
      if (!Array.isArray(candidates)) throw protocol("candidates is not an array");
      // RULING: only candidate 0 exists (the adapter never sends `candidateCount`); more means the server ignored a contract.
      if (candidates.length > 1) throw protocol("more than one candidate");
      if (candidates.length === 1) this.#candidate(candidates[0], events);
    } else if (usage === undefined && pf === undefined) {
      throw protocol("chunk has no candidates, promptFeedback or usageMetadata");
    }
    if (usage !== undefined && usage !== null) this.#usage = parseGeminiUsage(usage);
    return events;
  }

  #candidate(c: unknown, events: ChatStreamEvent[]): void {
    if (!isRecord(c)) throw protocol("candidate is not an object");
    if (c["index"] !== undefined && c["index"] !== 0) throw protocol("unexpected candidate index");
    const content = c["content"];
    if (content !== undefined && content !== null) {
      if (!isRecord(content)) throw protocol("candidate.content is not an object");
      const parts = content["parts"];
      if (parts !== undefined && parts !== null) {
        if (!Array.isArray(parts)) throw protocol("content.parts is not an array");
        for (const p of parts) this.#part(p, events);
      }
    }
    const fr = c["finishReason"];
    if (fr === undefined || fr === null || fr === "FINISH_REASON_UNSPECIFIED") return;
    if (typeof fr !== "string") throw protocol("finishReason is not a string");
    if (this.#raw !== undefined && this.#raw !== fr) throw protocol("conflicting finishReason");
    if (this.#raw !== undefined) return;
    if (isCandidateBlock(fr)) {
      const e = candidateBlock(fr, c["safetyRatings"], c["finishMessage"], this.#redact);
      e.partial = this.snapshot();
      throw e;
    }
    // RULING: the model itself produced an unusable function call; sampling again can succeed, so retryable.
    if (fr === "MALFORMED_FUNCTION_CALL" || fr === "UNEXPECTED_TOOL_CALL") throw protocol(`the model made an unusable tool call (${fr})`, true);
    this.#raw = fr;
    events.push({ type: "finish", finishReason: normaliseFinish(fr, this.#calls.length > 0), rawFinishReason: fr });
  }

  #part(p: unknown, events: ChatStreamEvent[]): void {
    if (!isRecord(p)) throw protocol("part is not an object");
    const text = p["text"], fc = p["functionCall"], sig = p["thoughtSignature"];
    if (text !== undefined && typeof text !== "string") throw protocol("part.text is not a string");
    if (sig !== undefined && typeof sig !== "string") throw protocol("part.thoughtSignature is not a string");
    if (p["thought"] !== undefined && typeof p["thought"] !== "boolean") throw protocol("part.thought is not a boolean");
    for (const k of Object.keys(p)) {
      if (k !== "text" && k !== "thought" && k !== "functionCall" && k !== "thoughtSignature") throw protocol(`unsupported part kind "${k.slice(0, 40)}"`);
    }
    const any = (typeof text === "string" && text !== "") || fc !== undefined;
    if (any && this.#raw !== undefined) throw protocol("content after finishReason");
    if (typeof text === "string" && text !== "") {
      if (p["thought"] === true) { this.#reasoning += text; events.push({ type: "reasoning_delta", text }); }
      else { this.#text += text; events.push({ type: "text_delta", text }); }
    }
    if (fc !== undefined) {
      if (!isRecord(fc) || typeof fc["name"] !== "string" || fc["name"] === "") throw protocol("functionCall lacks a name");
      const args = fc["args"] === undefined || fc["args"] === null ? {} : fc["args"];
      if (!isRecord(args)) throw protocol("functionCall.args is not an object");
      const raw = JSON.stringify(args);
      if (raw.length > this.#maxArgs) throw protocol(`tool call arguments exceed ${this.#maxArgs} bytes`);
      const index = this.#calls.length;
      if (index > 1023) throw protocol("too many tool calls");
      const id = toolCallId(index, sig);
      this.#calls.push({ id, name: fc["name"], args: raw, parsed: args as JsonObject });
      events.push({ type: "tool_call_start", index, id, name: fc["name"] });
      events.push({ type: "tool_call_delta", index, argumentsDelta: raw });
    }
  }

  snapshot(): PartialChatResult {
    const p: PartialChatResult = {
      text: this.#text,
      toolCalls: this.#calls.map((c, index) => ({ index, id: c.id, name: c.name, argumentsRaw: c.args })),
    };
    if (this.#reasoning) p.reasoning = this.#reasoning;
    if (this.#usage) p.usage = this.#usage;
    return p;
  }

  /** The end of a response that carried a finishReason. */
  finish(): ChatResult {
    if (this.#raw === undefined) throw protocol("response ended without a finishReason");
    const toolCalls: ToolCall[] = this.#calls.map((c) => ({ id: c.id, name: c.name, argumentsRaw: c.args, arguments: c.parsed }));
    const r: ChatResult = {
      text: this.#text, toolCalls, finishReason: normaliseFinish(this.#raw, toolCalls.length > 0), rawFinishReason: this.#raw, meta: this.#meta,
    };
    if (this.#reasoning) r.reasoning = this.#reasoning;
    if (this.#usage) r.usage = this.#usage;
    return r;
  }
}
