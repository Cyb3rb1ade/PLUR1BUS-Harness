import { isRecord, ProviderError } from "../errors.ts";
import type { ProviderErrorInit } from "../errors.ts";
import type { ChatResult, ChatStreamEvent, FinishReason, JsonObject, PartialChatResult, ResponseMeta, ToolCall, Usage } from "../types.ts";
import { SYNTHETIC_ID_PREFIX } from "./request.ts";

const MAX_MESSAGE_CHARS = 500;

function protocol(msg: string): ProviderError {
  return new ProviderError("protocol", `malformed gemini response: ${msg}`);
}

function count(v: unknown, what: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw protocol(`${what} must be a non-negative integer`);
  return v;
}

/**
 * `usageMetadata` → `Usage`. RULING: Gemini bills thinking tokens as output, so `outputTokens` is
 * `candidatesTokenCount + thoughtsTokenCount` (`reasoningTokens` carries the thinking share); `inputTokens` is
 * `promptTokenCount + toolUsePromptTokenCount`; `cachedInputTokens` is `cachedContentTokenCount` (already inside the prompt count).
 */
export function parseUsageMetadata(v: unknown): Usage | undefined {
  if (!isRecord(v)) throw protocol("usageMetadata is not an object");
  const prompt = count(v["promptTokenCount"], "usageMetadata.promptTokenCount");
  const cand = count(v["candidatesTokenCount"], "usageMetadata.candidatesTokenCount");
  const thoughts = count(v["thoughtsTokenCount"], "usageMetadata.thoughtsTokenCount");
  const toolUse = count(v["toolUsePromptTokenCount"], "usageMetadata.toolUsePromptTokenCount");
  const cached = count(v["cachedContentTokenCount"], "usageMetadata.cachedContentTokenCount");
  const total = count(v["totalTokenCount"], "usageMetadata.totalTokenCount");
  if (prompt === undefined && total === undefined) return undefined; // nothing countable yet
  const input = (prompt ?? 0) + (toolUse ?? 0);
  const output = (cand ?? 0) + (thoughts ?? 0);
  const u: Usage = { inputTokens: input, outputTokens: output, totalTokens: total ?? input + output };
  if (cached !== undefined) u.cachedInputTokens = cached;
  if (thoughts !== undefined) u.reasoningTokens = thoughts;
  return u;
}

/** Candidate finish reasons that mean the provider's safety layer cut the answer: a typed error, not a result. */
const BLOCKED_FINISH = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "RECITATION"]);
/** A turn the model could not complete as a call: refused, never half-delivered. */
const BROKEN_FINISH = new Set(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS"]);

function blockedError(code: string, where: string, detail: Record<string, unknown>, redact: (s: string) => string): ProviderError {
  const cats: string[] = [];
  const ratings = detail["safetyRatings"];
  if (Array.isArray(ratings)) {
    for (const r of ratings) {
      if (isRecord(r) && (r["blocked"] === true) && typeof r["category"] === "string") cats.push(`${r["category"]}${typeof r["probability"] === "string" ? `:${r["probability"]}` : ""}`);
    }
  }
  const message = typeof detail["blockReasonMessage"] === "string" ? detail["blockReasonMessage"] : typeof detail["finishMessage"] === "string" ? detail["finishMessage"] : undefined;
  const providerMessage = redact([message, cats.length ? `blocked: ${cats.join(", ")}` : undefined].filter(Boolean).join("; ")).slice(0, MAX_MESSAGE_CHARS);
  const init: ProviderErrorInit = { code, providerType: "safety" };
  if (providerMessage) init.providerMessage = providerMessage;
  return new ProviderError("content_filter", `blocked by Gemini safety (${where}: ${code})${providerMessage ? `: ${providerMessage}` : ""}`, init);
}

export function normaliseGeminiFinish(raw: string, hasToolCalls: boolean): FinishReason {
  if (raw === "STOP") return hasToolCalls ? "tool_calls" : "stop";
  if (raw === "MAX_TOKENS") return "length";
  return "other";
}

interface RawCall { id: string; name: string; args: JsonObject; argsRaw: string; thoughtSignature?: string }

/**
 * Folds `GenerateContentResponse` objects into events and one `ChatResult`. The stream and the non-stream path feed
 * the same instance type, so one turn gives one result either way. Anything off the documented shape is a `protocol` error.
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

  push(chunk: unknown): ChatStreamEvent[] {
    if (!isRecord(chunk)) throw protocol("chunk is not an object");
    const events: ChatStreamEvent[] = [];
    if (typeof chunk["responseId"] === "string" && this.#meta.id === undefined) this.#meta.id = chunk["responseId"];
    if (typeof chunk["modelVersion"] === "string" && this.#meta.model === undefined) this.#meta.model = chunk["modelVersion"];
    const pf = chunk["promptFeedback"];
    if (pf !== undefined && pf !== null) {
      if (!isRecord(pf)) throw protocol("promptFeedback is not an object");
      const br = pf["blockReason"];
      if (br !== undefined && br !== null) {
        if (typeof br !== "string" || br === "") throw protocol("promptFeedback.blockReason is not a string");
        throw blockedError(br, "prompt", pf, this.#redact);
      }
    }
    const cands = chunk["candidates"];
    const um = chunk["usageMetadata"];
    if (cands !== undefined && cands !== null) {
      if (!Array.isArray(cands)) throw protocol("candidates is not an array");
      if (cands.length > 1) throw protocol("more than one candidate"); // the adapter never sends candidateCount
      for (const c of cands) this.#candidate(c, events);
    } else if ((um === undefined || um === null) && (pf === undefined || pf === null)) {
      throw protocol("chunk has no candidates, promptFeedback or usageMetadata");
    }
    if (um !== undefined && um !== null) {
      const u = parseUsageMetadata(um);
      if (u && JSON.stringify(u) !== JSON.stringify(this.#usage)) { this.#usage = u; events.push({ type: "usage", usage: u }); }
    }
    return events;
  }

  #candidate(c: unknown, events: ChatStreamEvent[]): void {
    if (!isRecord(c)) throw protocol("candidate is not an object");
    const idx = c["index"] ?? 0;
    if (idx !== 0) throw protocol("unexpected candidate index");
    const content = c["content"];
    if (content !== undefined && content !== null) {
      if (!isRecord(content)) throw protocol("candidate.content is not an object");
      const parts = content["parts"];
      if (parts !== undefined && parts !== null) {
        if (!Array.isArray(parts)) throw protocol("content.parts is not an array");
        if (parts.length > 0 && this.#raw !== undefined) throw protocol("content after finishReason");
        for (const p of parts) this.#part(p, events);
      }
    }
    const fr = c["finishReason"];
    if (fr === undefined || fr === null) return;
    if (typeof fr !== "string" || fr === "") throw protocol("finishReason is not a string");
    if (this.#raw !== undefined) {
      if (this.#raw !== fr) throw protocol("conflicting finishReason");
      return;
    }
    if (BLOCKED_FINISH.has(fr)) throw blockedError(fr, "candidate", c, this.#redact);
    if (BROKEN_FINISH.has(fr)) throw protocol(`the model ended the turn with ${fr}`);
    this.#raw = fr;
    events.push({ type: "finish", finishReason: normaliseGeminiFinish(fr, this.#calls.length > 0), rawFinishReason: fr });
  }

  #part(p: unknown, events: ChatStreamEvent[]): void {
    if (!isRecord(p)) throw protocol("part is not an object");
    const fc = p["functionCall"];
    const text = p["text"];
    if (fc !== undefined && fc !== null) {
      if (text !== undefined) throw protocol("part has both text and functionCall");
      if (!isRecord(fc)) throw protocol("functionCall is not an object");
      const name = fc["name"];
      if (typeof name !== "string" || name === "") throw protocol("functionCall lacks a name");
      const args = fc["args"] ?? {};
      if (!isRecord(args)) throw protocol("functionCall.args is not an object");
      const argsRaw = JSON.stringify(args);
      if (argsRaw.length > this.#maxArgs) throw protocol(`tool call arguments exceed ${this.#maxArgs} bytes`);
      const given = fc["id"];
      if (given !== undefined && given !== null && (typeof given !== "string" || given === "")) throw protocol("functionCall.id is not a non-empty string");
      const index = this.#calls.length;
      const id = typeof given === "string" ? given : `${SYNTHETIC_ID_PREFIX}${index}`;
      if (this.#calls.some((x) => x.id === id)) throw protocol("duplicate tool call id");
      const call: RawCall = { id, name, args: args as JsonObject, argsRaw };
      const sig = p["thoughtSignature"];
      if (typeof sig === "string" && sig !== "") call.thoughtSignature = sig;
      this.#calls.push(call);
      // Gemini delivers a call whole, so the start and its one argument delta follow each other.
      events.push({ type: "tool_call_start", index, id, name }, { type: "tool_call_delta", index, argumentsDelta: argsRaw });
      return;
    }
    if (text !== undefined && text !== null) {
      if (typeof text !== "string") throw protocol("part.text is not a string");
      if (text === "") return;
      if (p["thought"] === true) { this.#reasoning += text; events.push({ type: "reasoning_delta", text }); }
      else { this.#text += text; events.push({ type: "text_delta", text }); }
      return;
    }
    // RULING: a part that is neither text nor a function call (inline data, code execution, …) is outside what this adapter
    // requested; it is refused rather than dropped, so a turn is never delivered with a piece silently missing. A part that
    // carries only a thoughtSignature is metadata and is ignored.
    if (Object.keys(p).every((k) => k === "thoughtSignature")) return;
    throw protocol("unsupported part type");
  }

  snapshot(): PartialChatResult {
    const out: PartialChatResult = {
      text: this.#text,
      toolCalls: this.#calls.map((c, index) => ({ index, id: c.id, name: c.name, argumentsRaw: c.argsRaw })),
    };
    if (this.#reasoning) out.reasoning = this.#reasoning;
    if (this.#usage) out.usage = this.#usage;
    return out;
  }

  finish(): ChatResult {
    if (this.#raw === undefined) throw protocol("response ended without a finishReason");
    const toolCalls: ToolCall[] = this.#calls.map((c) => {
      const t: ToolCall = { id: c.id, name: c.name, argumentsRaw: c.argsRaw, arguments: c.args };
      if (c.thoughtSignature) t.thoughtSignature = c.thoughtSignature;
      return t;
    });
    const r: ChatResult = {
      text: this.#text, toolCalls, finishReason: normaliseGeminiFinish(this.#raw, toolCalls.length > 0), rawFinishReason: this.#raw, meta: this.#meta,
    };
    if (this.#reasoning) r.reasoning = this.#reasoning;
    if (this.#usage) r.usage = this.#usage;
    return r;
  }
}
