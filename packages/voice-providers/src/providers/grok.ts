// xAI Grok Voice: full-duplex realtime over a WebSocket in an OpenAI-realtime-shaped protocol (VERIFY, see
// constants.ts). The session lives on the server side of the harness; the provider key is used for the handshake
// header only and never appears in any event, error or log field handed to a client.
import { XAI } from "../constants.ts";
import { VoiceProviderError } from "../errors.ts";
import type { AudioChunk, RealtimeConnectOptions, RealtimeEvent, RealtimeProvider, RealtimeSession, UsageReport } from "../types.ts";
import { fromBase64, toBase64 } from "../util.ts";
import { openSocket } from "../ws.ts";
import { KeyHolder, frameError, httpToWs, makeHttp, trimBase, type CloudDeps } from "./common.ts";
import { startRealtimeSession, type RealtimeCodec } from "./realtime-base.ts";

export interface GrokOptions extends CloudDeps {
  apiKeyRef: string | undefined;
  baseUrl?: string;
  defaultModel?: string;
  defaultVoice?: string;
}
const ID = "xai";

export function createGrokVoice(o: GrokOptions): RealtimeProvider {
  const keys = new KeyHolder(o.getSecret, o.apiKeyRef, ID);
  const http = makeHttp(ID, o, keys);
  const base = trimBase(o.baseUrl ?? XAI.baseUrl);
  let discovered: string | undefined;

  async function listModels(options: { signal?: AbortSignal } = {}) {
    const key = await keys.get();
    const j = await http.json<{ data?: Array<Record<string, any>> }>(`${base}${XAI.modelsPath}`, { headers: { authorization: `Bearer ${key}` }, ...(options.signal ? { signal: options.signal } : {}) });
    const rows = Array.isArray(j.data) ? j.data : [];
    return rows.filter((m) => typeof m?.["id"] === "string").map((m) => {
      const id = String(m["id"]);
      return { id, name: id, capabilities: XAI.realtimeModelPattern.test(id) ? ["realtime"] : [] };
    });
  }

  async function pickModel(options: RealtimeConnectOptions): Promise<string> {
    const m = options.model ?? o.defaultModel ?? discovered;
    if (m) return m;
    const found = (await listModels(options.signal ? { signal: options.signal } : {})).find((x) => x.capabilities.includes("realtime"));
    if (!found) throw new VoiceProviderError("invalid_request", `${ID}: no realtime model configured and none found by discovery`, { provider: ID });
    discovered = found.id;
    return found.id;
  }

  return {
    id: ID,
    kind: "realtime",
    toolCalls: true,
    listModels,
    async connect(options = {}): Promise<RealtimeSession> {
      const model = await pickModel(options);
      const key = await keys.get();
      const url = `${httpToWs(base)}${XAI.realtimePath}?model=${encodeURIComponent(model)}`;
      const ws = await openSocket({ provider: ID, url, headers: { authorization: `Bearer ${key}` }, ...(o.wsFactory ? { factory: o.wsFactory } : {}), ...(options.signal ? { signal: options.signal } : {}), secrets: keys.secrets });
      return startRealtimeSession({ provider: ID, ws, codec: grokCodec(model, withVoice(options, o.defaultVoice), keys.secrets), report: (r) => o.usage?.(r), signal: options.signal });
    },
  };
}

function grokCodec(model: string, opt: RealtimeConnectOptions, secrets: readonly string[]): RealtimeCodec {
  const rate = XAI.outputSampleRate;
  let transcript = "";
  return {
    init: () => [JSON.stringify({
      type: "session.update",
      session: {
        ...(opt.instructions ? { instructions: opt.instructions } : {}),
        ...(opt.voice ? { voice: opt.voice } : {}),
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        ...(opt.tools?.length ? { tools: opt.tools.map((t) => ({ type: "function", name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters ?? { type: "object", properties: {} } })) } : {}),
      },
    })],
    isReady: (f) => f["type"] === "session.created" || f["type"] === "session.updated",
    audio: (pcm) => JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(pcm) }),
    text: (t) => [JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] } }), JSON.stringify({ type: "response.create" })],
    interrupt: () => [JSON.stringify({ type: "response.cancel" })],
    toolResult: (callId, result) => [JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: typeof result === "string" ? result : JSON.stringify(result) } }), JSON.stringify({ type: "response.create" })],
    decode(f): RealtimeEvent[] {
      const t = String(f["type"] ?? "");
      if (t === "response.audio.delta" || t === "response.output_audio.delta") {
        if (typeof f["delta"] !== "string") throw new Error("response.audio.delta missing string delta");
        const chunk: AudioChunk = { data: fromBase64(f["delta"]), format: "pcm16", sampleRate: rate };
        return [{ type: "audio", chunk }];
      }

      if (t === "response.audio_transcript.delta" || t === "response.output_audio_transcript.delta") {
        transcript += String(f["delta"] ?? "");
        return [{ type: "transcript", role: "assistant", text: transcript, final: false }];
      }
      if (t === "response.audio_transcript.done" || t === "response.output_audio_transcript.done") {
        const text = typeof f["transcript"] === "string" ? f["transcript"] : transcript;
        transcript = "";
        return [{ type: "transcript", role: "assistant", text, final: true }];
      }
      if (t === "conversation.item.input_audio_transcription.completed") return [{ type: "transcript", role: "user", text: String(f["transcript"] ?? ""), final: true }];
      if (t === "input_audio_buffer.speech_started") return [{ type: "interrupted" }];
      if (t === "response.function_call_arguments.done") {
        let args: unknown = {};
        try { args = JSON.parse(String(f["arguments"] ?? "{}")); } catch { args = {}; }
        return [{ type: "tool.call", callId: String(f["call_id"] ?? ""), name: String(f["name"] ?? ""), arguments: args }];
      }
      if (t === "response.done") {
        const u = (f["response"] as Record<string, any> | undefined)?.["usage"];
        const out: RealtimeEvent[] = [];
        if (u && typeof u === "object") {
          const report: UsageReport = { provider: ID, operation: "realtime", model, ...(Number.isFinite(u.input_tokens) ? { inputTokens: Number(u.input_tokens) } : {}), ...(Number.isFinite(u.output_tokens) ? { outputTokens: Number(u.output_tokens) } : {}) };
          out.push({ type: "usage", report });
        }
        out.push({ type: "turn.done" });
        return out;
      }
      if (t === "error") return [{ type: "error", error: frameError(ID, (f["error"] as Record<string, unknown> | undefined) ?? f, secrets) }];
      return [];
    },
  };
}

function withVoice(options: RealtimeConnectOptions, fallback: string | undefined): RealtimeConnectOptions {
  const voice = options.voice ?? fallback;
  return voice === undefined ? options : { ...options, voice };
}
