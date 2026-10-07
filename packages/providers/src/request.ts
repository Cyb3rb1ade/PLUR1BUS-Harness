import { ProviderError } from "./errors.ts";
import type { ChatMessage, ChatRequest, ContentPart, ToolChoice } from "./types.ts";

export interface BuildOptions {
  stream: boolean;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  includeUsage: boolean;
}

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function bad(msg: string): ProviderError {
  return new ProviderError("invalid_request", `invalid request: ${msg}`);
}

function checkMessage(m: ChatMessage, i: number): void {
  const at = `messages[${i}]`;
  switch (m.role) {
    case "system":
    case "developer":
      if (typeof m.content !== "string") throw bad(`${at}.content must be a string`);
      return;
    case "user":
      if (typeof m.content === "string") return;
      if (!Array.isArray(m.content) || m.content.length === 0) throw bad(`${at}.content must be a string or a non-empty part list`);
      for (const p of m.content) if (p.type !== "text" && p.type !== "image_url") throw bad(`${at} has an unknown content part`);
      return;
    case "assistant": {
      const hasCalls = (m.toolCalls?.length ?? 0) > 0;
      if (!hasCalls && (m.content === undefined || m.content === null)) throw bad(`${at} needs content or toolCalls`);
      for (const c of m.toolCalls ?? []) {
        if (!c.id || !TOOL_NAME_RE.test(c.name) || typeof c.arguments !== "string") throw bad(`${at} has a malformed tool call`);
      }
      return;
    }
    case "tool":
      if (!m.toolCallId || typeof m.content !== "string") throw bad(`${at} needs toolCallId and string content`);
      return;
    default:
      throw bad(`${at} has an unknown role`);
  }
}

/** Fail-closed validation: a request that cannot be valid on the wire never leaves the process. */
export function validateRequest(req: ChatRequest): void {
  if (typeof req.model !== "string" || req.model.trim() === "") throw bad("model is required");
  if (!Array.isArray(req.messages) || req.messages.length === 0) throw bad("messages must not be empty");
  req.messages.forEach(checkMessage);
  const names = new Set<string>();
  for (const t of req.tools ?? []) {
    if (!TOOL_NAME_RE.test(t.name)) throw bad(`tool name "${t.name}" is not 1-64 of [a-zA-Z0-9_-]`);
    if (names.has(t.name)) throw bad(`duplicate tool "${t.name}"`);
    names.add(t.name);
  }
  if (req.toolChoice !== undefined) {
    if (names.size === 0) throw bad("toolChoice needs tools");
    if (typeof req.toolChoice === "object" && !names.has(req.toolChoice.name)) throw bad(`toolChoice names undeclared tool "${req.toolChoice.name}"`);
  }
  if (req.parallelToolCalls !== undefined && names.size === 0) throw bad("parallelToolCalls needs tools");
  if (req.maxTokens !== undefined && (!Number.isSafeInteger(req.maxTokens) || req.maxTokens < 1)) throw bad("maxTokens must be a positive integer");
  if (req.temperature !== undefined && !(Number.isFinite(req.temperature) && req.temperature >= 0 && req.temperature <= 2)) throw bad("temperature must be within 0..2");
  if (req.topP !== undefined && !(Number.isFinite(req.topP) && req.topP > 0 && req.topP <= 1)) throw bad("topP must be within (0, 1]");
  if (req.stop !== undefined && (req.stop.length > 4 || req.stop.some((s) => typeof s !== "string" || s === ""))) throw bad("stop takes up to 4 non-empty strings");
  if (req.responseFormat?.type === "json_schema" && !req.responseFormat.name) throw bad("json_schema response format needs a name");
}

function wireMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case "system":
    case "developer":
      return { role: m.role, content: m.content };
    case "user":
      return { role: "user", content: typeof m.content === "string" ? m.content : m.content.map(wirePart) };
    case "assistant": {
      const out: Record<string, unknown> = { role: "assistant", content: m.content ?? null };
      if (m.toolCalls && m.toolCalls.length > 0) {
        out["tool_calls"] = m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
      }
      return out;
    }
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}

function wirePart(p: ContentPart): Record<string, unknown> {
  if (p.type === "text") return { type: "text", text: p.text };
  return { type: "image_url", image_url: p.detail ? { url: p.url, detail: p.detail } : { url: p.url } };
}

function wireToolChoice(c: ToolChoice): unknown {
  return typeof c === "string" ? c : { type: "function", function: { name: c.name } };
}

/**
 * The request body as a plain object with a fixed key order (the serialised bytes are the cache key on providers
 * with prefix caching, ADR-010 R-rules): same request → same bytes. Validates first.
 */
export function buildRequestBody(req: ChatRequest, opts: BuildOptions): Record<string, unknown> {
  validateRequest(req);
  const body: Record<string, unknown> = { model: req.model, messages: req.messages.map(wireMessage) };
  if (req.tools && req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => {
      const fn: Record<string, unknown> = { name: t.name };
      if (t.description !== undefined) fn["description"] = t.description;
      if (t.parameters !== undefined) fn["parameters"] = t.parameters;
      if (t.strict !== undefined) fn["strict"] = t.strict;
      return { type: "function", function: fn };
    });
  }
  if (req.toolChoice !== undefined) body["tool_choice"] = wireToolChoice(req.toolChoice);
  if (req.parallelToolCalls !== undefined) body["parallel_tool_calls"] = req.parallelToolCalls;
  if (req.maxTokens !== undefined) body[opts.maxTokensField] = req.maxTokens;
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.topP !== undefined) body["top_p"] = req.topP;
  if (req.stop !== undefined) body["stop"] = req.stop;
  if (req.responseFormat !== undefined) {
    const f = req.responseFormat;
    body["response_format"] = f.type === "json_schema"
      ? { type: "json_schema", json_schema: { name: f.name, schema: f.schema, ...(f.strict === undefined ? {} : { strict: f.strict }) } }
      : { type: f.type };
  }
  body["stream"] = opts.stream;
  if (opts.stream && opts.includeUsage) body["stream_options"] = { include_usage: true };
  return body;
}
