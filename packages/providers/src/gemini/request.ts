import { ProviderError } from "../errors.ts";
import { validateRequest } from "../request.ts";
import type { AssistantToolCall, ChatMessage, ChatRequest, ContentPart, JsonObject } from "../types.ts";

/** Ids the adapter made up for a call the model sent without one; they are not echoed back to the provider. */
export const SYNTHETIC_ID_PREFIX = "gemini-call-";

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FUNCTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const DATA_URL_RE = /^data:([a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*);base64,([A-Za-z0-9+/]+={0,2})$/i;

function bad(msg: string): ProviderError {
  return new ProviderError("bad_request", `invalid request: ${msg}`);
}

/** `models/x` and `x` both name model `x`; anything that could change the URL path is refused. */
export function modelId(model: string): string {
  const id = model.startsWith("models/") ? model.slice("models/".length) : model;
  if (!MODEL_RE.test(id)) throw bad("model must be a plain model id such as gemini-2.5-flash");
  return id;
}

type Part = Record<string, unknown>;
interface Content { role: "user" | "model"; parts: Part[] }

function imagePart(p: Extract<ContentPart, { type: "image_url" }>): Part {
  // RULING: only inline `data:` images are sent; an http(s) URL would need Gemini's Files API or make the provider fetch an
  // arbitrary host, so it is refused (fail closed).
  const m = DATA_URL_RE.exec(p.url);
  if (!m) throw bad("images must be base64 data: URLs");
  return { inlineData: { mimeType: m[1]!.toLowerCase(), data: m[2]! } };
}

function parseArgs(c: AssistantToolCall, at: string): JsonObject {
  let v: unknown;
  try { v = JSON.parse(c.arguments); } catch { throw bad(`${at} tool call "${c.name}" has arguments that are not JSON`); }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad(`${at} tool call "${c.name}" arguments must be a JSON object`);
  return v as JsonObject;
}

function toolResponse(content: string): JsonObject {
  // RULING: functionResponse.response must be an object; a tool result that is a JSON object goes through as is, anything
  // else (plain text, array, scalar) is wrapped as `{ "result": <text> }`, text kept verbatim.
  try {
    const v: unknown = JSON.parse(content);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as JsonObject;
  } catch { /* plain text */ }
  return { result: content };
}

function push(out: Content[], role: Content["role"], parts: Part[]): void {
  if (parts.length === 0) return;
  // RULING: consecutive messages of one role are merged into one content (Gemini wants strict turn alternation, and the
  // results of parallel tool calls must share one turn).
  const last = out[out.length - 1];
  if (last && last.role === role) last.parts.push(...parts);
  else out.push({ role, parts });
}

function convert(messages: ChatMessage[]): { system: string[]; contents: Content[] } {
  const system: string[] = [];
  const contents: Content[] = [];
  const names = new Map<string, string>();
  messages.forEach((m, i) => {
    const at = `messages[${i}]`;
    switch (m.role) {
      case "system":
      case "developer":
        // RULING: system/developer messages anywhere are hoisted, in order, into the single systemInstruction.
        if (m.content !== "") system.push(m.content);
        return;
      case "user":
        push(contents, "user", typeof m.content === "string" ? [{ text: m.content }] : m.content.map((p) => (p.type === "text" ? { text: p.text } : imagePart(p))));
        return;
      case "assistant": {
        const parts: Part[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const c of m.toolCalls ?? []) {
          if (!FUNCTION_NAME_RE.test(c.name)) throw bad(`${at} tool name "${c.name}" is not valid for Gemini`);
          names.set(c.id, c.name);
          const fc: Part = { name: c.name, args: parseArgs(c, at) };
          if (!c.id.startsWith(SYNTHETIC_ID_PREFIX)) fc["id"] = c.id;
          const part: Part = { functionCall: fc };
          if (c.thoughtSignature) part["thoughtSignature"] = c.thoughtSignature;
          parts.push(part);
        }
        push(contents, "model", parts);
        return;
      }
      case "tool": {
        const name = names.get(m.toolCallId);
        if (name === undefined) throw bad(`${at} answers tool call "${m.toolCallId}", which no earlier assistant message made`);
        const fr: Part = { name, response: toolResponse(m.content) };
        if (!m.toolCallId.startsWith(SYNTHETIC_ID_PREFIX)) fr["id"] = m.toolCallId;
        push(contents, "user", [{ functionResponse: fr }]);
        return;
      }
    }
  });
  return { system, contents };
}

/** The `generateContent` body, fixed key order (same request, same bytes). Validates first. */
export function buildGeminiBody(req: ChatRequest): Record<string, unknown> {
  validateRequest(req);
  modelId(req.model);
  // RULING: Gemini has no switch for parallel calls; an explicit `false` cannot be honoured and is refused, `true` is its behaviour.
  if (req.parallelToolCalls === false) throw bad("parallelToolCalls:false is not supported by Gemini");
  for (const t of req.tools ?? []) if (!FUNCTION_NAME_RE.test(t.name)) throw bad(`tool name "${t.name}" must start with a letter or underscore for Gemini`);
  const { system, contents } = convert(req.messages);
  if (contents.length === 0) throw bad("messages need at least one user, assistant or tool message");
  const body: Record<string, unknown> = {};
  if (system.length > 0) body["systemInstruction"] = { parts: [{ text: system.join("\n\n") }] };
  body["contents"] = contents;
  if (req.tools && req.tools.length > 0) {
    body["tools"] = [{
      functionDeclarations: req.tools.map((t) => {
        const d: Record<string, unknown> = { name: t.name };
        if (t.description !== undefined) d["description"] = t.description;
        if (t.parameters !== undefined) d["parametersJsonSchema"] = t.parameters;
        return d;
      }),
    }];
    if (req.toolChoice !== undefined) {
      const c = req.toolChoice;
      body["toolConfig"] = { functionCallingConfig: typeof c === "string"
        ? { mode: c === "auto" ? "AUTO" : c === "none" ? "NONE" : "ANY" }
        : { mode: "ANY", allowedFunctionNames: [c.name] } };
    }
  }
  const gc: Record<string, unknown> = {};
  if (req.maxTokens !== undefined) gc["maxOutputTokens"] = req.maxTokens;
  if (req.temperature !== undefined) gc["temperature"] = req.temperature;
  if (req.topP !== undefined) gc["topP"] = req.topP;
  if (req.stop !== undefined) gc["stopSequences"] = req.stop;
  if (req.responseFormat?.type === "json_object") gc["responseMimeType"] = "application/json";
  if (req.responseFormat?.type === "json_schema") { gc["responseMimeType"] = "application/json"; gc["responseJsonSchema"] = req.responseFormat.schema; }
  if (Object.keys(gc).length > 0) body["generationConfig"] = gc;
  return body;
}
