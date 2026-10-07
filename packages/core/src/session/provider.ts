// The chat provider seam. The real adapters (packages/providers, another session) are not wired in yet: the turn loop
// depends on this interface only, and tests and `plur1bus chat` use the deterministic fake.

export type ChatChunk =
  | { type: "delta"; text: string }
  /** With a tool dispatcher the loop executes the call and persists the envelope as `tool.result`; without one it persists a reported call/result and executes nothing. */
  | { type: "tool.call"; id: string; name: string; args?: unknown }
  | { type: "tool.result"; id: string; output: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export interface ChatRequest {
  sessionId: string; agentId: string;
  /** Applied summaries of the compacted history, oldest first. */
  summaries: string[];
  /** The recalled memory block for this turn (empty when recall returned nothing or degraded). */
  memory: string;
  /** The uncovered history ending with this turn's user message. */
  messages: { role: "system" | "user" | "assistant" | "tool"; text: string }[];
  /** The tools the harness will execute for this turn (B1); absent when the turn loop has no tool dispatcher. */
  tools?: { name: string; description: string; inputSchema: Record<string, unknown>; risk: string }[];
  signal: AbortSignal;
}

export interface ChatProvider {
  readonly id: string;
  stream(req: ChatRequest): AsyncIterable<ChatChunk>;
}

export interface FakeProviderOptions {
  chunkSize?: number;
  /** Awaited before every chunk: lets a test interleave two sessions deterministically. */
  gate?: (req: ChatRequest, index: number) => Promise<void>;
  /** Sees every request (assert on what the loop sent). */
  onRequest?: (req: ChatRequest) => void;
}

/** Deterministic: replies `echo[<agent>]: <last user text>`. A last user text containing `FAIL` throws; containing
 *  `TOOL` first reports a placeholder tool call and result. */
export class FakeChatProvider implements ChatProvider {
  readonly id = "fake";
  readonly #o: FakeProviderOptions;
  constructor(o: FakeProviderOptions = {}) { this.#o = o; }

  async *stream(req: ChatRequest): AsyncGenerator<ChatChunk> {
    this.#o.onRequest?.(req);
    const last = [...req.messages].reverse().find((m) => m.role === "user")?.text ?? "";
    const reply = `echo[${req.agentId}]: ${last}`;
    const size = Math.max(1, this.#o.chunkSize ?? 8);
    let i = 0;
    const tick = async () => { req.signal.throwIfAborted(); await this.#o.gate?.(req, i++); req.signal.throwIfAborted(); };
    if (last.includes("TOOL")) {
      await tick(); yield { type: "tool.call", id: "t1", name: "fake.tool", args: {} };
      await tick(); yield { type: "tool.result", id: "t1", output: "ok" };
    }
    for (let p = 0; p < reply.length; p += size) {
      await tick();
      if (last.includes("FAIL") && p >= size) throw new Error("fake provider failure");
      yield { type: "delta", text: reply.slice(p, p + size) };
    }
    yield { type: "usage", inputTokens: req.messages.reduce((n, m) => n + Math.ceil(m.text.length / 4), 0), outputTokens: Math.ceil(reply.length / 4) };
  }
}
