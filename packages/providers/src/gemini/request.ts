import { isRecord, ProviderError } from "../errors.ts";
import { validateRequest } from "../request.ts";
import type { AssistantToolCall, ChatMessage, ChatRequest, ContentPart, ToolChoice } from "../types.ts";

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DATA_URL_RE = /^data:((?:image\/[a-z0-9.+-]{1,60})|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/i;
const SIGNATURE_RE = /^[A-Za-z0-9+/=_-]{1,65536}$/;

/** Separates the call id from a thought signature inside a tool-call id (`call_0~<signature>`); see `toolCallId`. */
export const SIGNATURE_SEPARATOR = "~";

function bad(msg: string): ProviderError {
  return new ProviderError("bad_request", `invalid request: ${msg}`);
}

/** `models/gemini-x` and `gemini-x` both name the model; anything that could change the URL path is refused. */
export function modelPath(model: string): string {
  const bare = model.startsWith("models/") ? model.slice("models/".length) : model;
  if (!MODEL_RE.test(bare)) throw bad("model name has characters Gemini model ids do not use");
  return `models/${bare}`;
}

/**
 * The id the adapter gives a Gemini tool call. Gemini does not number its calls, so the id is positional
 * (`call_<n>`). Gemini 3 additionally returns an opaque `thoughtSignature` on a function call that must be sent back
 * with it on the next turn; `AssistantToolCall` has no field for it, so it rides in the id after `~` (the id is
 * what the caller stores and replays) and is split off again by `parseCallId`. RULING: stateless carrying in the id
 * rather than an adapter-side cache (a cache would be lost across restarts and processes) or a change of the shared
 * `AssistantToolCall` type (other adapters' shape).
 */
export function toolCallId(index: number, thoughtSignature: string | undefined): string {
  return thoughtSignature === undefined ? `call_${index}` : `call_${index}${SIGNATURE_SEPARATOR}${thoughtSignature}`;
}

export function parseCallId(id: string): { base: string; thoughtSignature?: string } {
  const i = id.indexOf(SIGNATURE_SEPARATOR);
  if (i === -1) return { base: id };
  const sig = id.slice(i + 1);
  if (!SIGNATURE_RE.test(sig)) throw bad("a tool call id carries a malformed thought signature");
  return { base: id.slice(0, i), thoughtSignature: sig };
}

function part(p: ContentPart): Record<string, unknown> {
  if (p.type === "text") return { text: p.text };
  const m = DATA_URL_RE.exec(p.url);
  // RULING: only inline `data:` images (and PDFs) are sent. A remote URL would make either Gemini fetch an arbitrary
  // address on the user's behalf (its `fileData` only accepts Files-API / YouTube URIs anyway) or force this adapter
  // to download it; both are refused, fail closed.
  if (!m) throw bad("image parts must be base64 data: URLs (image/* or application/pdf)");
  return { inlineData: { mimeType: m[1]!.toLowerCase(), data: m[2]! } };
}

function callArgs(c: AssistantToolCall): Record<string, unknown> {
  let v: unknown;
  try { v = JSON.parse(c.arguments); } catch { throw bad(`tool call "${c.name}" has arguments that are not JSON`); }
  if (!isRecord(v)) throw bad(`tool call "${c.name}" arguments must be a JSON object`);
  return v;
}

function responseObject(content: string): Record<string, unknown> {
  // RULING: a tool result that is a JSON object goes through as the `functionResponse.response` object; any other text
  // (including JSON arrays, numbers, strings) is wrapped as `{ result: <the text> }`, because Gemini requires an object.
  try {
    const v: unknown = JSON.parse(content);
    if (isRecord(v)) return v;
  } catch { /* plain text */ }
  return { result: content };
}

function toolConfig(c: ToolChoice): Record<string, unknown> {
  if (c === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (c === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (c === "required") return { functionCallingConfig: { mode: "ANY" } };
  return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [c.name] } };
}

/**
 * The `generateContent` / `streamGenerateContent` request body, with a fixed key order (same request, same bytes).
 * Validates with the shared `validateRequest` first. The API key and the model are never part of it: the model is the
 * URL path, the key a header.
 *
 * RULING: system and developer messages are hoisted, in order, into one `systemInstruction` (Gemini has no system
 * role inside `contents`); a request with nothing but system messages is refused.
 * RULING: `parallelToolCalls: false` is refused (Gemini has no switch to forbid parallel calls; ignoring it would
 * silently break the caller's contract). `true` and absent are the same.
 * RULING: a tool message must answer a call from an earlier assistant message of the same request (Gemini's
 * `functionResponse` needs the function name, which a tool message does not carry).
 */
export function buildGeminiBody(req: ChatRequest): Record<string, unknown> {
  validateRequest(req);
  if (req.parallelToolCalls === false) throw bad("parallelToolCalls:false cannot be honoured by Gemini");
  const system: string[] = [];
  const contents: Record<string, unknown>[] = [];
  const names = new Map<string, string>();
  let responses: Record<string, unknown>[] | undefined;

  const flush = (): void => {
    if (responses) { contents.push({ role: "user", parts: responses }); responses = undefined; }
  };
  const push = (m: ChatMessage, i: number): void => {
    switch (m.role) {
      case "system":
      case "developer":
        system.push(m.content);
        return;
      case "user":
        flush();
        contents.push({ role: "user", parts: typeof m.content === "string" ? [{ text: m.content }] : m.content.map(part) });
        return;
      case "assistant": {
        flush();
        const parts: Record<string, unknown>[] = [];
        if (typeof m.content === "string" && m.content !== "") parts.push({ text: m.content });
        for (const c of m.toolCalls ?? []) {
          const { thoughtSignature } = parseCallId(c.id);
          if (names.has(c.id)) throw bad(`messages[${i}] repeats tool call id`);
          names.set(c.id, c.name);
          const p: Record<string, unknown> = { functionCall: { name: c.name, args: callArgs(c) } };
          if (thoughtSignature !== undefined) p["thoughtSignature"] = thoughtSignature;
          parts.push(p);
        }
        if (parts.length === 0) throw bad(`messages[${i}] is an empty assistant message`);
        contents.push({ role: "model", parts });
        return;
      }
      case "tool": {
        const name = names.get(m.toolCallId);
        if (name === undefined) throw bad(`messages[${i}] answers tool call "${m.toolCallId.slice(0, 40)}" that no earlier assistant message made`);
        (responses ??= []).push({ functionResponse: { name, response: responseObject(m.content) } });
        return;
      }
    }
  };
  req.messages.forEach(push);
  flush();
  if (contents.length === 0) throw bad("a request needs at least one non-system message");

  const body: Record<string, unknown> = {};
  if (system.length > 0) body["systemInstruction"] = { parts: system.map((text) => ({ text })) };
  body["contents"] = contents;
  if (req.tools && req.tools.length > 0) {
    // RULING: `parametersJsonSchema` (full JSON Schema) rather than `parameters` (OpenAPI subset): the registry's
    // schemas are JSON Schema and are sent as given, in the caller's key order.
    body["tools"] = [{
      functionDeclarations: req.tools.map((t) => {
        const d: Record<string, unknown> = { name: t.name };
        if (t.description !== undefined) d["description"] = t.description;
        if (t.parameters !== undefined) d["parametersJsonSchema"] = t.parameters;
        return d;
      }),
    }];
  }
  if (req.toolChoice !== undefined) body["toolConfig"] = toolConfig(req.toolChoice);
  const g: Record<string, unknown> = {};
  if (req.maxTokens !== undefined) g["maxOutputTokens"] = req.maxTokens;
  if (req.temperature !== undefined) g["temperature"] = req.temperature;
  if (req.topP !== undefined) g["topP"] = req.topP;
  if (req.stop !== undefined) g["stopSequences"] = req.stop;
  if (req.responseFormat !== undefined && req.responseFormat.type !== "text") {
    g["responseMimeType"] = "application/json";
    if (req.responseFormat.type === "json_schema") g["responseJsonSchema"] = req.responseFormat.schema;
  }
  if (Object.keys(g).length > 0) body["generationConfig"] = g;
  return body;
}
