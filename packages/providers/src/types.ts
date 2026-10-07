// Public types of the chat_completions adapter (OpenAI-compatible `/chat/completions`). Provider-neutral names
// (camelCase); the wire spelling lives only in request.ts and accumulate.ts.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; url: string; detail?: "auto" | "low" | "high" };

export interface AssistantToolCall {
  id: string;
  name: string;
  /** The arguments as the JSON text the model produced (or the caller re-serialised). */
  arguments: string;
  /** Opaque provider state to echo back on the next turn (Gemini `thoughtSignature`); other adapters ignore it. */
  thoughtSignature?: string;
}

export type ChatMessage =
  | { role: "system" | "developer"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content?: string | null; toolCalls?: AssistantToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema of the arguments object. Serialised exactly as given (key order is the caller's: cache stability). */
  parameters?: JsonObject;
  strict?: boolean;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name: string; schema: JsonObject; strict?: boolean };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  responseFormat?: ResponseFormat;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "other";

export interface ToolCall {
  id: string;
  name: string;
  /** Exactly the text the model produced (after repair, the repaired text). */
  argumentsRaw: string;
  /** The parsed arguments object; absent when `argumentsError` is set. */
  arguments?: JsonObject;
  argumentsError?: string;
  /** True when the repair hook changed the arguments. */
  repaired?: boolean;
  /** Opaque provider state the caller must hand back in `AssistantToolCall.thoughtSignature` (Gemini). */
  thoughtSignature?: string;
}

export interface ResponseMeta {
  id?: string;
  model?: string;
  systemFingerprint?: string;
}

export interface ChatResult {
  text: string;
  reasoning?: string;
  refusal?: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  rawFinishReason: string;
  usage?: Usage;
  meta: ResponseMeta;
}

/** What had been received when a stream failed. Tool arguments are unparsed. */
export interface PartialChatResult {
  text: string;
  reasoning?: string;
  toolCalls: { index: number; id?: string; name?: string; argumentsRaw: string }[];
  usage?: Usage;
}

export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; index: number; id?: string; name?: string }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; finishReason: FinishReason; rawFinishReason: string }
  | { type: "done"; result: ChatResult };

/** The adapter holds no auth logic: it asks for a ready-made `Authorization` header value ("Bearer …") per call. */
export interface ProviderCredentials {
  authorization(ctx: { signal: AbortSignal }): Promise<string | undefined> | string | undefined;
}

/** Milliseconds; `null` disables a bound. */
export interface Timeouts {
  /** Until the response headers arrive (non-stream calls default to `totalMs`: headers come when generation ends). */
  headersMs: number | null;
  /** Longest silence between two body chunks. */
  idleMs: number | null;
  /** The whole call. */
  totalMs: number | null;
}

export interface ToolArgumentRepairInput {
  call: { id: string; name: string; argumentsRaw: string };
  /** The tool's definition when the request declared it. */
  tool?: ToolDefinition;
  /** Why the arguments were rejected. */
  error: string;
  signal: AbortSignal;
}

export type ToolArgumentRepairOutcome =
  | { argumentsRaw: string }
  | { arguments: JsonObject }
  | undefined;

/**
 * Hook point only (D97 supplies the implementation later): called at most once per tool call whose arguments are
 * not a JSON object. Returning `undefined` leaves the call as it was, with `argumentsError` set.
 */
export interface ToolArgumentRepair {
  repair(input: ToolArgumentRepairInput): Promise<ToolArgumentRepairOutcome> | ToolArgumentRepairOutcome;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Overrides the adapter's timeouts for this call. */
  timeouts?: Partial<Timeouts>;
}

export interface ChatCompletionsConfig {
  /** Includes the version segment, e.g. `https://api.openai.com/v1`; `/chat/completions` is appended. */
  baseUrl: string;
  credentials: ProviderCredentials;
  /** Extra headers; may not carry authorization, content or routing headers. */
  headers?: Record<string, string>;
  timeouts?: Partial<Timeouts>;
  repair?: ToolArgumentRepair;
  /** Default `max_tokens` (widest compatibility); OpenAI's newer models want `max_completion_tokens`. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Ask for the final usage chunk (`stream_options.include_usage`). Default true. */
  includeUsage?: boolean;
  /** Accept a stream that ends without `[DONE]` once a `finish_reason` arrived. Default false. */
  allowMissingDone?: boolean;
  /** Send the Authorization header over plain `http:` to a non-loopback host. Default false. */
  allowInsecureHttp?: boolean;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  limits?: Partial<Limits>;
}

export interface Limits {
  /** One SSE event (all its data lines). */
  maxEventBytes: number;
  /** One tool call's accumulated arguments. */
  maxToolArgumentBytes: number;
  /** A non-stream response body or an error body read for classification. */
  maxBodyBytes: number;
}

export interface ChatCompletionsAdapter {
  /** Non-stream path (`stream:false`). */
  complete(request: ChatRequest, options?: CallOptions): Promise<ChatResult>;
  /** Stream path; the last event is `done`. Stopping iteration early cancels the request. */
  stream(request: ChatRequest, options?: CallOptions): AsyncGenerator<ChatStreamEvent, void, void>;
}
