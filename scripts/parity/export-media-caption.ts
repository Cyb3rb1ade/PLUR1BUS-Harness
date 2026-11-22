import { pathToFileURL } from "node:url";
import { CAPTION_PROMPT, createCloudCaptionProvider } from "../../packages/core/src/media-search/caption/cloud.ts";
import { createCaptionService, normaliseCaption, resolveCaptionProvider } from "../../packages/core/src/media-search/caption/service.ts";
import { captionVideoByKeyframes, mergeFrameCaptions } from "../../packages/core/src/media-search/caption/keyframes.ts";
import type { CaptionOrder, CaptionProvider } from "../../packages/core/src/media-search/caption/types.ts";
import type { CallBudget } from "../../packages/core/src/budget/index.ts";
import { exporterMain } from "./lib.mjs";

const PNG = Uint8Array.from([1, 2, 3]);
const input = { kind: "image" as const, mime: "image/png", source: { bytes: PNG } };
const ack = { provider: "fixture-cloud", acknowledgedAt: "2026-01-01T00:00:00Z", by: "u" };
const local: CaptionProvider = { id: "local", local: true, caption: async () => " local\ncaption " };

async function service(name: string, source: CaptionOrder, prompt?: string, userCaption?: string) {
  let calls = 0;
  const provider: CaptionProvider = { ...local, async caption(req) { calls++; return local.caption(req); } };
  const service = createCaptionService({ config: () => ({ source, maxChars: 24 }),
    provider: () => name === "no provider" ? undefined : provider });
  return { name, source, prompt: prompt ?? null, userCaption: userCaption ?? null,
    outcome: await service.resolve({ ...input, ...(prompt ? { prompt } : {}), ...(userCaption ? { userCaption } : {}) }), calls };
}

async function cloud(name: string) {
  const events: unknown[] = [];
  const abort = new AbortController();
  let pinned = name === "pinned";
  if (name === "cancelled") abort.abort();
  const budget = {
    checkBeforeCall(request: unknown) {
      events.push(["reserve", request]);
      return name === "budget" ? { kind: "refuse", code: "budget_exceeded" } : { kind: "allow", reservationId: "hold" };
    },
    settle(id: string, usage: unknown) { events.push(["settle", id, usage]); },
    releaseUnused(id: string) { events.push(["release", id]); },
  } as unknown as CallBudget;
  const cloud = createCloudCaptionProvider({
    id: "fixture-cloud", model: "fixture-model", principal: "u", agent: "a", maxChars: () => 50,
    budget: name === "unbound" ? null : budget,
    privacy: () => ({
      ...(name === "missing" ? {} : { ack: name === "invalid" ? { ...ack, by: " " } : ack }),
      ...(name === "endpoint" ? { endpoint: "https://example.invalid" } : {}),
      pinned,
    }),
    async decide() {
      events.push("policy");
      if (name === "policy denied") throw new Error("policy denied");
      if (name === "pin during policy") pinned = true;
    },
    chat: { async complete(request) {
      events.push(["request", request]);
      if (name === "aborted while sent") { abort.abort(); throw new Error("cancelled in port"); }
      if (name === "failed while sent") throw new Error("fixture provider failure");
      return { text: " a fixture caption ", provider: "fixture-cloud", model: "fixture-model",
        ...(name === "no usage" ? {} : { usage: { inputTokens: 11, outputTokens: 5 } }) };
    } },
  });
  let outcome: unknown;
  try { outcome = await cloud.caption({ ...input, signal: abort.signal }); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    outcome = { error: "error" in error ? error.error : error.message,
      reason: "data" in error && error.data && typeof error.data === "object" && "reason" in error.data ? error.data.reason : null };
  }
  return { name, outcome, events, ...(["failed while sent", "aborted while sent"].includes(name) ? {
    divergence: "charge-uncertain-provider-usage",
  } : {}) };
}

export async function buildMediaCaptionVectors() {
  const frameRows = [
    { tsMs: 20, text: "Second   frame.." }, { tsMs: 10, text: "First frame;" }, { tsMs: 30, text: "second frame" },
    { tsMs: 0, text: " " }, { tsMs: 40, text: "Another frame" },
  ];
  const cases = [
    { input: "  a\tcaption\n\ufeff with spaces  ", cap: 40 },
    { input: "One two, three and four", cap: 15 },
    { input: "abcdefghijk", cap: 6 },
    { input: "ab\u0085cde", cap: 4 },
    { input: "🔵 do not lose words", cap: 12 },
    { input: "  ", cap: 3 },
  ];
  const providers = [
    { id: "off", pinned: true, embeddingLocal: true },
    { id: undefined, pinned: false, embeddingLocal: false },
    { id: undefined, pinned: false, embeddingLocal: true },
    { id: undefined, pinned: true, embeddingLocal: false },
    { id: "local", pinned: false, embeddingLocal: false },
    { id: "fixture-cloud", pinned: true, embeddingLocal: false },
    { id: "fixture-cloud", pinned: false, embeddingLocal: true },
  ].map(row => {
    let chosen: unknown;
    try {
      chosen = resolveCaptionProvider({ ...row, config: row.id === undefined ? {} : { provider: row.id, privacyAck: ack },
        providers: { local, cloud: id => ({ ...local, id, local: false }) } })?.id ?? null;
    } catch (error) { if (!error || typeof error !== "object" || !("error" in error)) throw error; chosen = { error: error.error }; }
    return { ...row, id: row.id ?? null, chosen };
  });
  const frames = [];
  for (const count of [1, 3, 4, 5, 7]) {
    const calls: unknown[] = [];
    const caption = await captionVideoByKeyframes({ bytes: PNG }, {
      maxChars: 60, frames: count,
      extractor: { async *frames(_source, options) {
        calls.push(options);
        for (let i = 0; i < 10; i++) yield { tsMs: i * 100, image: Uint8Array.of(i), mime: "image/png" };
      } },
      captionImage: async image => { calls.push(image[0]); return "frame " + image[0]; },
    });
    frames.push({ count, calls, caption });
  }
  return { caption: {
    normalise: cases.map(row => ({ ...row, outcome: normaliseCaption(row.input, row.cap) })),
    service: await Promise.all([
      service("off", "off", "prompt", "user"), service("prompt", "prompt-then-user-then-auto", "  a prompt ", "user"),
      service("user", "prompt-then-user-then-auto", "  ", "  user caption "), service("user only", "user-only", "prompt"),
      service("auto", "prompt-then-user-then-auto"), service("no provider", "prompt-then-user-then-auto"),
    ]),
    providers, frameRows, merged: mergeFrameCaptions(frameRows, 25), frames,
    prompt: CAPTION_PROMPT,
    cloud: await Promise.all(["success", "no usage", "pinned", "missing", "invalid", "endpoint", "budget", "unbound",
      "policy denied", "pin during policy", "cancelled", "aborted while sent", "failed while sent"].map(cloud)),
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "media", build: buildMediaCaptionVectors });
}
