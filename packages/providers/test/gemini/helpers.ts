// Fake Gemini server pieces on top of the shared loopback stub: no network beyond 127.0.0.1, synthetic keys only.
import type { ServerResponse } from "node:http";
import { createGeminiAdapter, secretStoreKey } from "../../src/index.ts";
import type { ChatRequest, GeminiConfig } from "../../src/index.ts";
import { sseHeaders } from "../helpers/stub.ts";
import type { Stub } from "../helpers/stub.ts";

export const T = { timeout: 15_000 };
/** A recognisable synthetic key: the leak tests search every observable output for it. */
export const KEY = "AIzaSyLEAKMARKER-synthetic-0000000000000";

export const MODEL = "gemini-synthetic-flash";
export const basic: ChatRequest = { model: MODEL, messages: [{ role: "user", content: "hi" }] };

export class MemStore {
  readonly #m = new Map<string, string>();
  gets = 0;
  async get(ref: string) { this.gets++; return this.#m.get(ref); }
  put(ref: string, v: string) { this.#m.set(ref, v); }
}

export function adapterFor(stub: Stub, over: Partial<GeminiConfig> = {}, key: string | undefined = KEY) {
  const store = new MemStore();
  if (key !== undefined) store.put("gemini:test", key);
  return { store, adapter: createGeminiAdapter({ baseUrl: stub.baseUrl, credentials: secretStoreKey(store, "gemini:test"), ...over }) };
}

export const candidate = (parts: object[], finishReason?: string, extra: object = {}) => ({
  candidates: [{ index: 0, content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}), ...extra }],
});

export const usage = (u: object) => ({ usageMetadata: u });

export const json = (res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-type": "application/json; charset=UTF-8", ...headers });
  res.end(JSON.stringify(body));
};

/** Writes the chunks as Gemini's `alt=sse` stream (`data: {...}\r\n\r\n`, no [DONE]) and closes it. */
export function sse(res: ServerResponse, chunks: unknown[]): void {
  sseHeaders(res);
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
  res.end();
}

export const geminiError = (code: number, status: string, message: string, details?: object[]) => ({ error: { code, message, status, ...(details ? { details } : {}) } });

export async function collect(it: AsyncGenerator<import("../../src/index.ts").ChatStreamEvent, void, void>) {
  const events = [];
  for await (const e of it) events.push(e);
  return events;
}
