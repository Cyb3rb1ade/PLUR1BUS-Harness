import { createHash } from "node:crypto";
import { ProviderError } from "../errors.ts";
import { validateRequest } from "../request.ts";
import type { ChatMessage, ContentPart, ResponseFormat, ToolChoice } from "../types.ts";
import type { ReasoningEffort, ReasoningSummary, ResponsesProfile, ResponsesRequest } from "./types.ts";

export interface ResponsesBuildOptions {
  stream: boolean;
  profile: ResponsesProfile;
  /** The adapter-level default; a request's `providerOptions.responses.store` wins. Forced off by `chatgpt_plan`. */
  store: boolean;
  reasoningEffort?: ReasoningEffort | undefined;
  reasoningSummary?: ReasoningSummary | undefined;
}

type Item = { type: string; [key: string]: unknown };

const EFFORTS: ReadonlySet<string> = new Set(["minimal", "low", "medium", "high"]);
const SUMMARIES: ReadonlySet<string> = new Set(["auto", "concise", "detailed"]);
const MAX_CALL_ID = 64;

function bad(msg: string): ProviderError {
  return new ProviderError("invalid_request", `invalid request: ${msg}`);
}

const blank = (s: string): boolean => s.trim() === "";

/**
 * `call_id` is at most 64 characters on this wire; an id minted by another adapter in the same session (Gemini's carries
 * a base64 thought signature) is replaced by a stable hash of itself, the same everywhere it occurs in the request.
 */
function wireCallId(id: string): string {
  return id.length <= MAX_CALL_ID ? id : `call_h_${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

function imagePart(p: Extract<ContentPart, { type: "image_url" }>, at: string): Item {
  let ok = /^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.url);
  if (!ok) {
    try { const u = new URL(p.url); ok = u.protocol === "https:" || u.protocol === "http:"; } catch { /* refused below */ }
  }
  if (!ok) throw bad(`${at} has an image that is neither an http(s) URL nor a base64 data URL of jpeg, png, gif or webp`);
  const out: Item = { type: "input_image", image_url: p.url };
  if (p.detail !== undefined) out["detail"] = p.detail;
  return out;
}

function userItem(content: string | ContentPart[], at: string): Item {
  const parts: Item[] = typeof content === "string"
    ? [{ type: "input_text", text: content }]
    : content.map((p) => (p.type === "text" ? { type: "input_text", text: p.text } : imagePart(p, at)));
  return { type: "message", role: "user", content: parts };
}

function wireToolChoice(c: ToolChoice): unknown {
  return typeof c === "string" ? c : { type: "function", name: c.name };
}

function wireFormat(f: ResponseFormat): Record<string, unknown> {
  if (f.type !== "json_schema") return { type: f.type };
  const o: Record<string, unknown> = { type: "json_schema", name: f.name, schema: f.schema };
  if (f.strict !== undefined) o["strict"] = f.strict;
  return o;
}

/** Every `function_call` needs its `function_call_output` later in the list, and every output follows its call. */
function checkPairing(items: Item[]): void {
  const open = new Set<string>();
  for (const it of items) {
    if (it.type === "function_call") open.add(it["call_id"] as string);
    else if (it.type === "function_call_output") {
      const id = it["call_id"] as string;
      if (!open.delete(id)) throw bad(`tool result for ${id} does not answer an earlier tool call`);
    }
  }
  for (const id of open) throw bad(`tool call ${id} has no tool result`);
}

/**
 * The Responses API request body, as a plain object with a fixed key order (`model`, `instructions`, `input`, `tools`,
 * `tool_choice`, `parallel_tool_calls`, `max_output_tokens`, `temperature`, `top_p`, `reasoning`, `text`, `store`,
 * `stream`): the same request gives the same bytes. `system`/`developer` messages become `instructions`; the rest
 * becomes `input` items. `store` is always sent (default false: stateless). Fail closed: whatever the wire cannot
 * express (`stop`, a tool result without its call, an empty assistant message) and, for the `chatgpt_plan` profile,
 * every field that backend does not accept is refused before any I/O.
 */
export function buildResponsesBody(req: ResponsesRequest, opts: ResponsesBuildOptions): Record<string, unknown> {
  validateRequest(req);
  if (req.stop !== undefined) throw bad("stop sequences are not supported by the Responses API");
  const own = req.providerOptions?.responses;
  const effort = own?.reasoningEffort ?? opts.reasoningEffort;
  const summary = own?.reasoningSummary ?? opts.reasoningSummary;
  if (effort !== undefined && !EFFORTS.has(effort)) throw bad("reasoningEffort must be minimal, low, medium or high");
  if (summary !== undefined && !SUMMARIES.has(summary)) throw bad("reasoningSummary must be auto, concise or detailed");
  const plan = opts.profile === "chatgpt_plan";
  if (plan) {
    // D110 public Sign in with ChatGPT wire constraints: the
    // ChatGPT-plan backend takes instructions, input, tools, tool_choice, parallel_tool_calls, reasoning and text, and
    // only with store:false and stream:true. Fields it does not take are refused here rather than discovered as a 400.
    if (req.maxTokens !== undefined) throw bad("maxTokens is not accepted by the chatgpt_plan profile");
    if (req.temperature !== undefined) throw bad("temperature is not accepted by the chatgpt_plan profile");
    if (req.topP !== undefined) throw bad("topP is not accepted by the chatgpt_plan profile");
    if (own?.store === true) throw bad("store:true is not accepted by the chatgpt_plan profile (it is stateless)");
  }

  const instructions: string[] = [];
  const input: Item[] = [];
  req.messages.forEach((m: ChatMessage, i) => {
    const at = `messages[${i}]`;
    switch (m.role) {
      case "system":
      case "developer":
        // RULING: system messages anywhere in the list are hoisted, in order, into `instructions`.
        if (!blank(m.content)) instructions.push(m.content);
        return;
      case "user": input.push(userItem(m.content, at)); return;
      case "assistant": {
        let any = false;
        if (typeof m.content === "string" && !blank(m.content)) { input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] }); any = true; }
        for (const c of m.toolCalls ?? []) { input.push({ type: "function_call", call_id: wireCallId(c.id), name: c.name, arguments: c.arguments }); any = true; }
        if (!any) throw bad(`${at} is empty: an assistant message needs text or tool calls`);
        return;
      }
      case "tool": input.push({ type: "function_call_output", call_id: wireCallId(m.toolCallId), output: m.content }); return;
    }
  });
  if (input.length === 0) throw bad("the request needs at least one non-system message");
  if (plan && instructions.length === 0) throw bad("the chatgpt_plan profile requires instructions (a system or developer message)");
  checkPairing(input);

  const body: Record<string, unknown> = { model: req.model };
  if (instructions.length > 0) body["instructions"] = instructions.join("\n\n");
  body["input"] = input;
  if (req.tools && req.tools.length > 0) {
    // RULING: `strict` is always sent. The Responses API defaults function tools to strict:true, which demands
    // additionalProperties:false and every property required; the neutral request means "as written" unless it says otherwise.
    body["tools"] = req.tools.map((t) => {
      const o: Record<string, unknown> = { type: "function", name: t.name };
      if (t.description !== undefined) o["description"] = t.description;
      o["parameters"] = t.parameters ?? { type: "object", properties: {} };
      o["strict"] = t.strict ?? false;
      return o;
    });
  }
  if (req.toolChoice !== undefined) body["tool_choice"] = wireToolChoice(req.toolChoice);
  if (req.parallelToolCalls !== undefined) body["parallel_tool_calls"] = req.parallelToolCalls;
  if (req.maxTokens !== undefined) body["max_output_tokens"] = req.maxTokens;
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.topP !== undefined) body["top_p"] = req.topP;
  if (effort !== undefined || summary !== undefined) {
    const r: Record<string, unknown> = {};
    if (effort !== undefined) r["effort"] = effort;
    if (summary !== undefined) r["summary"] = summary;
    body["reasoning"] = r;
  }
  if (req.responseFormat !== undefined && req.responseFormat.type !== "text") body["text"] = { format: wireFormat(req.responseFormat) };
  body["store"] = plan ? false : own?.store ?? opts.store;
  body["stream"] = plan ? true : opts.stream;
  return body;
}
