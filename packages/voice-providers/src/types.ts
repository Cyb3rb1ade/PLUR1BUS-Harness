// Provider interfaces (AL1). The usage numbers use the same units as core's VoiceUsage (seconds, input/output tokens);
// `UsageSink` is the single reporting hook: a caller maps a report onto VoiceBudgetPort.record, the package never
// imports or changes the budget code.
import type { VoiceUsage } from "../../core/src/voice/ports.ts";

export type { VoiceUsage };

export type AudioFormat = "pcm16" | "opus" | "mp3";
export interface AudioSpec { format: AudioFormat; sampleRate: number }
export interface AudioChunk extends AudioSpec { data: Uint8Array }

export type VoiceOperation = "asr" | "tts" | "realtime";
/** What one call cost in the provider's own units. Unknown parts are absent, never zero-filled. */
export interface UsageReport {
  provider: string;
  operation: VoiceOperation;
  model?: string;
  chars?: number;
  seconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Stable id of the billable event, so a consumer that records usage (VoiceBudgetPort.record) can de-duplicate. Absent when the vendor gives none. */
  eventId?: string;
}
export type UsageSink = (report: UsageReport) => void;

/** Map a provider report onto core's VoiceUsage so a caller can pass it to VoiceBudgetPort.record unchanged. */
export function toVoiceUsage(report: UsageReport, costMicros = 0): VoiceUsage {
  return { seconds: report.seconds ?? 0, costMicros, inputTokens: report.inputTokens ?? 0, outputTokens: report.outputTokens ?? 0 };
}

export interface ModelInfo {
  id: string;
  name: string;
  /** Free-form capability tags from discovery (for example "tts", "asr", "realtime", "native-audio"). */
  capabilities: string[];
  languages?: string[];
}
export interface VoiceInfo {
  id: string;
  name: string;
  languages?: string[];
  gender?: string;
  /** Engine / model family the voice belongs to when the vendor says so (Polly: standard, neural, ...). */
  engines?: string[];
  previewUrl?: string;
}

export interface CallOptions { signal?: AbortSignal }

// ---- ASR ----
export interface WordTiming { text: string; startMs: number; endMs: number }
export interface TranscribeOptions extends CallOptions { language?: string; model?: string; timestamps?: boolean }
export interface TranscriptResult { text: string; language?: string; words?: WordTiming[]; usage: UsageReport }
export type AsrEvent =
  | { type: "ready" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string; language?: string; words?: WordTiming[] }
  | { type: "error"; error: Error }
  | { type: "closed" };
export interface AsrStreamOptions extends TranscribeOptions { sampleRate?: number }
export interface AsrSession {
  /** Raw pcm16 mono at the requested sample rate. */
  sendAudio(pcm: Uint8Array): void;
  /** End of utterance: ask the recogniser to finalise what it has. */
  commit(): void;
  close(): Promise<void>;
  readonly events: AsyncIterable<AsrEvent>;
}
export interface AsrProvider {
  readonly id: string;
  readonly kind: "asr";
  transcribe(audio: AudioChunk, options?: TranscribeOptions): Promise<TranscriptResult>;
  openStream(options?: AsrStreamOptions): Promise<AsrSession>;
  listModels(options?: CallOptions): Promise<ModelInfo[]>;
}

// ---- TTS ----
export interface TtsOptions extends CallOptions {
  voice?: string;
  model?: string;
  format?: AudioFormat;
  sampleRate?: number;
  language?: string;
  /** Vendor voice settings pass-through (stability, speed, ...). */
  voiceSettings?: Record<string, number | boolean>;
}
export interface TtsResult extends AudioChunk { usage: UsageReport }
export interface TtsProvider {
  readonly id: string;
  readonly kind: "tts";
  /** True when the vendor accepts text incrementally; otherwise text input is sentence-chunked by the package. */
  readonly textInputStreaming: boolean;
  readonly formats: readonly AudioFormat[];
  synthesize(text: string, options?: TtsOptions): Promise<TtsResult>;
  /** Text may arrive as chunks; audio chunks come out in order. A flush happens when the input iterable ends. */
  synthesizeStream(input: string | AsyncIterable<string>, options?: TtsOptions): AsyncIterable<AudioChunk>;
  listVoices(options?: CallOptions): Promise<VoiceInfo[]>;
  listModels(options?: CallOptions): Promise<ModelInfo[]>;
}

// ---- Realtime ----
export interface RealtimeTool { name: string; description?: string; parameters?: Record<string, unknown> }
export interface RealtimeConnectOptions extends CallOptions {
  model?: string;
  voice?: string;
  instructions?: string;
  language?: string;
  tools?: RealtimeTool[];
  /** Input audio the caller will send; output is always reported with its own spec on each chunk. */
  inputSampleRate?: number;
}
export type RealtimeEvent =
  | { type: "ready" }
  | { type: "audio"; chunk: AudioChunk }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "tool.call"; callId: string; name: string; arguments: unknown }
  | { type: "interrupted" }
  | { type: "turn.done" }
  | { type: "usage"; report: UsageReport }
  | { type: "error"; error: Error }
  | { type: "closed"; reason?: string };
export interface RealtimeSession {
  sendAudio(pcm: Uint8Array): void;
  sendText(text: string): void;
  /** Cancel the model's current response (barge-in). */
  interrupt(): void;
  submitToolResult(callId: string, result: unknown): void;
  close(): Promise<void>;
  readonly events: AsyncIterable<RealtimeEvent>;
}
export interface RealtimeProvider {
  readonly id: string;
  readonly kind: "realtime";
  /** True when the platform emits tool-call events. */
  readonly toolCalls: boolean;
  connect(options?: RealtimeConnectOptions): Promise<RealtimeSession>;
  listModels(options?: CallOptions): Promise<ModelInfo[]>;
}

export type VoiceProviderAny = AsrProvider | TtsProvider | RealtimeProvider;

export interface Logger { debug(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void }
export const noopLogger: Logger = { debug() {}, warn() {} };

export type GetSecret = (name: string) => Promise<string | undefined>;
