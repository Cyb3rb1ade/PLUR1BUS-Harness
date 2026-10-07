import { isRecord, protocolError, ProviderError } from "../errors.ts";
import type { ChatResult, ChatStreamEvent, FinishReason, JsonObject, PartialChatResult, ResponseMeta, ToolCall, Usage } from "../types.ts";
import { candidateBlock, classifyGeminiStreamError, isCandidateBlock, promptBlock } from "./errors.ts";
import { toolCallId } from "./request.ts";

function protocol(msg: string, retryable = false): ProviderError {
  return protocolError(`malformed Gemini response: ${msg}`, { retryable });
}

function count(v: Record<string, unknown>, key: string): number | undefined {
  const n = v[key];
  if (n === undefined || n === null) return undefined;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw protocol(`usageMetadata.${key} must be a non-negative integer`);
  return n;
}

/** The sum of the counts that are present; `undefined` when none is. */
function sumKnown(...xs: (number | undefined)[]): number | undefined {
  const known = xs.filter((x): x is number => x !== undefined);
  return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0);
}

/**
 * `usageMetadata` → `Usage`, or `undefined` when it carries no count at all.
 * RULING: Gemini reports thinking tokens apart from `candidatesTokenCount` but bills them as output, and reports
 * tool-use prompt tokens apart from `promptTokenCount`; so `outputTokens` = candidates + thoughts and `inputTokens` =
 * prompt + tool-use prompt (each the sum of those present, `undefined` when neither is), `reasoningTokens` = thoughts,
 * `cachedInputTokens` = `cachedContentTokenCount` (a subset of the prompt count, as for chat_completions).
 * `totalTokens` is Gemini's own `totalTokenCount` when present, else input+output when BOTH are known, else absent.
 * A count that is absent stays absent (never 0); one that is not a non-negative integer is a protocol error.
 */
export function parseGeminiUsage(v: unknown): Usage | undefined {
  if (!isRecord(v)) throw protocol("usageMetadata is not an object");
  const prompt = count(v, "promptTokenCount"), toolUse = count(v, "toolUsePromptTokenCount");
  const candidates = count(v, "candidatesTokenCount"), thoughts = count(v, "thoughtsTokenCount");
  const cached = count(v, "cachedContentTokenCount"), reported = count(v, "totalTokenCount");
  const input = sumKnown(prompt, toolUse), output = sumKnown(candidates, thoughts);
  const total = reported ?? (input !== undefined && output !== undefined ? input + output : undefined);
  const u: Usage = {};
  if (input !== undefined) u.inputTokens = input;
  if (output !== undefined) u.outputTokens = output;
  if (total !== undefined) u.totalTokens = total;
  if (cached !== undefined) u.cachedInputTokens = cached;
  if (thoughts !== undefined) u.reasoningTokens = thoughts;
  return Object.keys(u).length === 0 ? undefined : u;
}

/**
 * Gemini `finishReason` / `promptFeedback.blockReason` → outcome. ONE table; every row is a deliberate ruling.
 * NOTE: written from the public API reference, NOT verified against the live API (no network here); every judgement
 * call below is deliberately conservative: an unknown value never crashes, never counts as a clean stop.
 *
 *  candidate.finishReason          outcome
 *  ------------------------------  ------------------------------------------------------------------------------
 *  STOP                            ChatResult "stop" (or "tool_calls" when functionCall parts arrived)
 *  MAX_TOKENS                      ChatResult "length"
 *  SAFETY, RECITATION, BLOCKLIST,  GeminiSafetyBlockError (invalid_request + contentFiltered, not retryable,
 *  PROHIBITED_CONTENT, SPII,       source "candidate", `partial` = what had arrived)
 *  IMAGE_SAFETY,
 *  IMAGE_PROHIBITED_CONTENT,
 *  IMAGE_RECITATION
 *  MALFORMED_FUNCTION_CALL,        `unknown` / code "protocol" error, retryable (a new sample can be well-formed)
 *  UNEXPECTED_TOOL_CALL
 *  TOO_MANY_TOOL_CALLS             `unknown` / code "protocol" error, NOT retryable (a limit, not a sampling slip)
 *  LANGUAGE, OTHER, IMAGE_OTHER,   ChatResult "other", raw value kept in rawFinishReason
 *  NO_IMAGE, any unrecognised
 *  FINISH_REASON_UNSPECIFIED,      no verdict: treated as "not finished"; a response that never gets a real
 *  absent, null                    finishReason is a protocol error at the end
 *
 *  promptFeedback.blockReason      outcome
 *  ------------------------------  ------------------------------------------------------------------------------
 *  SAFETY, OTHER, BLOCKLIST,       GeminiSafetyBlockError, source "prompt" (same properties as above)
 *  PROHIBITED_CONTENT,
 *  IMAGE_SAFETY, any unrecognised
 *  BLOCK_REASON_UNSPECIFIED        no verdict (proto default): ignored, the candidates decide
 *  non-string                      protocol error
 *
 * RULING: LANGUAGE (unsupported language) is not a safety verdict and the request itself was well-formed, so it is a
 * result with "other", not an error; the caller sees the raw value and any text. RULING: OTHER on the candidate side is
 * "other" (Gemini documents it as "unknown reason"), but on the PROMPT side it is a block: no candidate exists then.
 * RULING: an unrecognised blockReason is a block (fail closed: nothing was generated), an unrecognised finishReason is
 * "other" (text may be whole). RULING: MAX_TOKENS with partial tool calls is still "length"; the caller decides.
 */
const FINISH_RESULT: Readonly<Record<string, FinishReason>> = { STOP: "stop", MAX_TOKENS: "length" };
const TOOL_FAILURES: Readonly<Record<string, boolean>> = { MALFORMED_FUNCTION_CALL: true, UNEXPECTED_TOOL_CALL: true, TOO_MANY_TOOL_CALLS: false };

function normaliseFinish(raw: string, hasCalls: boolean): FinishReason {
  if (raw === "STOP") return hasCalls ? "tool_calls" : "stop";
  return Object.hasOwn(FINISH_RESULT, raw) ? FINISH_RESULT[raw]! : "other";
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
      const br = pf["blockReason"];
      if (br !== undefined && br !== null) {
        if (typeof br !== "string") throw protocol("promptFeedback.blockReason is not a string");
        if (br !== "BLOCK_REASON_UNSPECIFIED") throw promptBlock(pf, this.#redact);
      }
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
    if (usage !== undefined && usage !== null) {
      // RULING: an empty usageMetadata says nothing and never erases a usage already seen.
      const u = parseGeminiUsage(usage);
      if (u !== undefined) this.#usage = u;
    }
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
    // RULING: unusable model output is a protocol error; retryable only where a fresh sample can plausibly fix it (table above).
    if (Object.hasOwn(TOOL_FAILURES, fr)) throw protocol(`the model made an unusable tool call (${fr})`, TOOL_FAILURES[fr]!);
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
