// Google Gemini Live: duplex audio over the Live API WebSocket (BidiGenerateContent). Native-audio models come from
// discovery (models whose supportedGenerationMethods include bidiGenerateContent); config defaultModel wins over
// discovery and the constant is only the last fallback. The API key goes in the server-side handshake only.
import { GEMINI } from "../constants.ts";
import type { AudioChunk, RealtimeConnectOptions, RealtimeEvent, RealtimeProvider, RealtimeSession, UsageReport } from "../types.ts";
import { fromBase64, toBase64 } from "../util.ts";
import { openSocket } from "../ws.ts";
import { KeyHolder, frameError, makeHttp, trimBase, type CloudDeps } from "./common.ts";
import { startRealtimeSession, type RealtimeCodec } from "./realtime-base.ts";

export interface GeminiOptions extends CloudDeps {
  apiKeyRef: string | undefined;
  baseUrl?: string;
  defaultModel?: string;
  defaultVoice?: string;
}
const ID = "gemini";

export function createGeminiLive(o: GeminiOptions): RealtimeProvider {
  const keys = new KeyHolder(o.getSecret, o.apiKeyRef, ID);
  const http = makeHttp(ID, o, keys);
  const base = trimBase(o.baseUrl ?? GEMINI.baseUrl);
  const wsBase = o.baseUrl ? base.replace(/^http/, "ws") : GEMINI.wsHost;
  let discovered: string | undefined;

  async function listModels(options: { signal?: AbortSignal } = {}) {
    const key = await keys.get();
    const out = [];
    let token: string | undefined;
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ pageSize: "100" });
      if (token) q.set("pageToken", token);
      const j = await http.json<{ models?: Array<Record<string, any>>; nextPageToken?: string }>(`${base}${GEMINI.modelsPath}?${q}`, { headers: { "x-goog-api-key": key }, ...(options.signal ? { signal: options.signal } : {}) });
      for (const m of j.models ?? []) {
        if (typeof m?.["name"] !== "string") continue;
        const methods: string[] = Array.isArray(m["supportedGenerationMethods"]) ? m["supportedGenerationMethods"] : [];
        const caps: string[] = [];
        if (methods.includes(GEMINI.liveMethod)) caps.push("realtime");
        if (caps.includes("realtime") && GEMINI.nativeAudioPattern.test(m["name"])) caps.push("native-audio");
        out.push({ id: m["name"], name: String(m["displayName"] ?? m["name"]), capabilities: caps });
      }
      if (!j.nextPageToken) break;
      token = j.nextPageToken;
    }
    return out;
  }

  async function pickModel(options: RealtimeConnectOptions): Promise<string> {
    const m = options.model ?? o.defaultModel ?? discovered;
    if (m) return m;
    try {
      const all = await listModels(options.signal ? { signal: options.signal } : {});
      const best = all.find((x) => x.capabilities.includes("native-audio")) ?? all.find((x) => x.capabilities.includes("realtime"));
      if (best) { discovered = best.id; return best.id; }
    } catch (e) {
      if ((e as { code?: string }).code === "auth" || (e as { code?: string }).code === "aborted") throw e;
    }
    return GEMINI.defaultModel;
  }

  return {
    id: ID,
    kind: "realtime",
    toolCalls: true,
    listModels,
    async connect(options = {}): Promise<RealtimeSession> {
      const model = await pickModel(options);
      const key = await keys.get();
      const url = `${wsBase}${GEMINI.liveWsPath}?key=${encodeURIComponent(key)}`;
      const ws = await openSocket({ provider: ID, url, ...(o.wsFactory ? { factory: o.wsFactory } : {}), ...(options.signal ? { signal: options.signal } : {}), secrets: keys.secrets });
      return startRealtimeSession({ provider: ID, ws, codec: geminiCodec(model, withVoice(options, o.defaultVoice), keys.secrets), report: (r) => o.usage?.(r), signal: options.signal });
    },
  };
}

function geminiCodec(model: string, opt: RealtimeConnectOptions, secrets: readonly string[]): RealtimeCodec {
  const callNames = new Map<string, string>();
  const inputMime = opt.inputSampleRate ? `audio/pcm;rate=${opt.inputSampleRate}` : GEMINI.inputMime;
  let userText = "";
  let modelText = "";
  let muted = false;
  let lastReportedUsage: { inputTokens?: number; outputTokens?: number } | undefined;
  return {
    init: () => [JSON.stringify({
      setup: {
        model: model.startsWith("models/") ? model : `models/${model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          ...(opt.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opt.voice } } } } : {}),
        },
        ...(opt.instructions ? { systemInstruction: { parts: [{ text: opt.instructions }] } } : {}),
        ...(opt.tools?.length ? { tools: [{ functionDeclarations: opt.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.parameters ? { parameters: t.parameters } : {}) })) }] } : {}),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    })],
    isReady: (f) => f["setupComplete"] !== undefined,
    audio: (pcm) => JSON.stringify({ realtimeInput: { audio: { data: toBase64(pcm), mimeType: inputMime } } }),
    text: (t) => [JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: t }] }], turnComplete: true } })],
    // The Live API has no explicit cancel message. interrupt() mutes the local audio stream until the model's turn
    // ends or the service reports its own interruption (server-side VAD on the user's speech does that).
    interrupt: () => { muted = true; return []; },
    toolResult: (callId, result) => [JSON.stringify({ toolResponse: { functionResponses: [{ id: callId, name: callNames.get(callId) ?? "", response: typeof result === "object" && result !== null ? result : { output: result } }] } })],
    decode(f): RealtimeEvent[] {
      const out: RealtimeEvent[] = [];
      const sc = f["serverContent"] as Record<string, any> | undefined;
      if (sc) {
        const rawParts = sc["modelTurn"]?.parts;
        const parts: Array<Record<string, any>> = Array.isArray(rawParts) ? rawParts : [];
        if (sc["modelTurn"] && rawParts !== undefined && !Array.isArray(rawParts)) {
          throw new Error("modelTurn.parts is not an array");
        }
        for (const p of parts) {
          const d = p?.inlineData;
          if (d && typeof d.data === "string" && !muted) {
            const m = /rate=(\d+)/.exec(String(d.mimeType ?? ""));
            const chunk: AudioChunk = { data: fromBase64(d.data), format: "pcm16", sampleRate: m ? Number(m[1]) : GEMINI.outputSampleRate };
            out.push({ type: "audio", chunk });
          }
        }
        if (typeof sc["inputTranscription"]?.text === "string") { userText += sc["inputTranscription"].text; out.push({ type: "transcript", role: "user", text: userText, final: false }); }
        if (typeof sc["outputTranscription"]?.text === "string") { modelText += sc["outputTranscription"].text; out.push({ type: "transcript", role: "assistant", text: modelText, final: false }); }
        if (sc["interrupted"] === true) { muted = false; out.push({ type: "interrupted" }); }
        if (sc["turnComplete"] === true) {
          muted = false;
          lastReportedUsage = undefined;
          if (userText) { out.push({ type: "transcript", role: "user", text: userText, final: true }); userText = ""; }
          if (modelText) { out.push({ type: "transcript", role: "assistant", text: modelText, final: true }); modelText = ""; }
          out.push({ type: "turn.done" });
        }
      }
      const calls = (f["toolCall"] as Record<string, any> | undefined)?.["functionCalls"];
      if (Array.isArray(calls)) for (const c of calls) {
        const id = String(c?.id ?? "");
        callNames.set(id, String(c?.name ?? ""));
        out.push({ type: "tool.call", callId: id, name: String(c?.name ?? ""), arguments: c?.args ?? {} });
      }
      const u = f["usageMetadata"] as Record<string, any> | undefined;
      if (u) {
        const inTok = Number.isFinite(u["promptTokenCount"]) ? Number(u["promptTokenCount"]) : undefined;
        const outTok = Number.isFinite(u["responseTokenCount"]) ? Number(u["responseTokenCount"]) : undefined;
        if (!lastReportedUsage || lastReportedUsage.inputTokens !== inTok || lastReportedUsage.outputTokens !== outTok) {
          lastReportedUsage = {
            ...(inTok !== undefined ? { inputTokens: inTok } : {}),
            ...(outTok !== undefined ? { outputTokens: outTok } : {}),
          };
          const report: UsageReport = { provider: ID, operation: "realtime", model, ...(inTok !== undefined ? { inputTokens: inTok } : {}), ...(outTok !== undefined ? { outputTokens: outTok } : {}) };
          out.push({ type: "usage", report });
        }
      }
      if (f["error"] !== undefined) out.push({ type: "error", error: frameError(ID, typeof f["error"] === "object" ? (f["error"] as Record<string, unknown>) : f, secrets) });
      return out;
    },
  };
}


function withVoice(options: RealtimeConnectOptions, fallback: string | undefined): RealtimeConnectOptions {
  const voice = options.voice ?? fallback;
  return voice === undefined ? options : { ...options, voice };
}
