import type { ServerResponse } from "node:http";
import { createGeminiAdapter } from "../../src/index.ts";
import type { ChatRequest, GeminiConfig } from "../../src/index.ts";
import { sseHeaders } from "../helpers/stub.ts";

/** A synthetic key in the shape of a Google API key; it never leaves the test process except into the fake server. */
export const KEY = "AIzaSyLEAKMARKER0123456789abcdefghijk";
export const fakeKey = (value: string | undefined = KEY) => ({ apiKey: () => value });

export const req: ChatRequest = { model: "gemini-test-1", messages: [{ role: "user", content: "hi" }] };
export const weatherTool = { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } };

export const adapterFor = (baseUrl: string, extra: Partial<GeminiConfig> = {}) => createGeminiAdapter({ baseUrl, credentials: fakeKey(), ...extra });

export const sse = (...chunks: object[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");

export function sendSse(res: ServerResponse, body: string): void { sseHeaders(res); res.end(body); }
export function sendJson(res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export const part = (text: string, extra: object = {}) => ({ text, ...extra });
export const cand = (parts: object[], finishReason?: string) => ({ candidates: [{ index: 0, content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] });
export const usageMeta = { promptTokenCount: 11, candidatesTokenCount: 5, totalTokenCount: 16 };
