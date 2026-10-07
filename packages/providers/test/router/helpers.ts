import { ProviderError } from "../../src/errors.ts";
import type { ChatRequest, ChatResult, ChatStreamEvent } from "../../src/types.ts";
import type { Candidate, Clock, RouterEvent, StreamingAdapter } from "../../src/router/types.ts";

export class FakeClock implements Clock {
  t = 0;
  readonly sleeps: number[] = [];
  now(): number { return this.t; }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.sleeps.push(ms);
    this.t += ms; // time passes instantly and deterministically
  }
}

export const REQ: ChatRequest = { model: "ignored", messages: [{ role: "user", content: "hi" }] };

export function result(text: string, tokens = 10): ChatResult {
  return { text, toolCalls: [], finishReason: "stop", rawFinishReason: "stop", usage: { inputTokens: tokens, outputTokens: tokens, totalTokens: 2 * tokens }, meta: {} };
}

export type Step = { err: ProviderError } | { text: string } | { textThenErr: ProviderError; text: string } | { throwRaw: Error };

/** An adapter that plays one scripted step per `stream()` call (the last step repeats). */
export class ScriptedAdapter implements StreamingAdapter {
  calls = 0;
  readonly models: string[] = [];
  readonly steps: Step[];
  constructor(steps: Step[]) { this.steps = steps; }
  async *stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, void> {
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)]!;
    this.calls += 1;
    this.models.push(request.model);
    if ("throwRaw" in step) throw step.throwRaw;
    if ("err" in step) throw step.err;
    if ("textThenErr" in step) {
      yield { type: "text_delta", text: step.text };
      throw step.textThenErr;
    }
    yield { type: "text_delta", text: step.text };
    yield { type: "done", result: result(step.text) };
  }
}

export const server = (status = 500) => new ProviderError("overloaded", `HTTP ${status}`, { status });
export const rateLimit = (retryAfterMs?: number) => new ProviderError("rate_limit", "429", { status: 429, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
export const badRequest = () => new ProviderError("invalid_request", "400", { status: 400 });
export const auth = () => new ProviderError("auth", "401", { status: 401 });
/** A failure that is transient by class (so it may fall back) but that the same candidate will not cure: no retry. */
export const down = () => new ProviderError("overloaded", "503", { status: 503, retryable: false });
export const filter = () => new ProviderError("invalid_request", "blocked", { status: 400, contentFiltered: true });

export function cand(provider: string, model: string, steps: Step[]): Candidate & { adapter: ScriptedAdapter } {
  return { provider, model, adapter: new ScriptedAdapter(steps) };
}

export function collector(): { events: RouterEvent[]; sink: (e: RouterEvent) => void } {
  const events: RouterEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

export async function drain<T>(g: AsyncGenerator<T, void, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of g) out.push(v);
  return out;
}
