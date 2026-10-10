import { randomUUID } from 'node:crypto';
import { createTurnDetector, SentenceChunker, pcm16ToFloat32, resample, type AsrProvider, type AsrSession, type AudioChunk, type TtsProvider, type LocalRealtimeProfile, type TurnDetectorOptions, type LoadedVad } from '../../../voice-providers/src/index.ts';
import { createVoiceTurnProfile, type TurnProfile } from './turn-profile.ts';
import type { VoiceMetrics } from './metrics.ts';
import type { TurnOutcome } from '../session/turn-loop.ts';
export interface TalkAgent {
  start(text: string, profile: TurnProfile): { turnId: string; done: Promise<TurnOutcome> };
  cancel(turnId: string): void;
}
export type TalkEvent = { type: 'barge_in' | 'voice.failed' | 'voice.closed' | 'voice.language_changed' } | import('../../../voice-providers/src/index.ts').FeatureEvent;
export interface TalkOptions {
  asr: AsrProvider; tts: TtsProvider; agent: TalkAgent; profile: LocalRealtimeProfile; metrics: VoiceMetrics;
  privacyPin?: boolean; allowModel?: (provider: string, model: string) => boolean;
  signal: AbortSignal; language?: string; sampleRate?: number;
  vad?: { value: LoadedVad; release(): void };
  /** A trusted host surface owns playback; no provider event or error object is forwarded. */
  receive(chunk: AudioChunk): Promise<void>; stopPlayback?: () => void; event(event: TalkEvent): void;
  timers?: Pick<TurnDetectorOptions, 'setTimeout' | 'clearTimeout'>;
}
export interface TalkSession {
  send(pcm: Uint8Array): void; speech(active: boolean): void;
  idle(): Promise<void>; close(): Promise<void>;
}
/** One ASR stream, one active response. Barge-in aborts synchronously; late audio is dropped even for a provider ignoring abort. */
export async function createTalkSession(o: TalkOptions): Promise<TalkSession> {
  const lifetime = new AbortController(); const signal = AbortSignal.any([o.signal, lifetime.signal]);
  const asr: AsrSession = await o.asr.openStream({ signal, sampleRate: o.sampleRate ?? 16000, ...(o.language ? { language: o.language } : {}) });
  const jobs = new Set<Promise<unknown>>(); let closed = false; let speaking = false; let endAt = Date.now(); let inputId = randomUUID();
  interface Response { id: string; handleId?: string; controller: AbortController; confirm(): void; confirmed: boolean; chunks: string[]; wake?: () => void; finished: boolean; responseId?: string; }
  let current: Response | undefined; let lastAgent: Promise<unknown> | undefined;
  const track = (p: Promise<unknown>) => { jobs.add(p); void p.finally(() => jobs.delete(p)).catch(() => {}); };
  const cancel = () => { const r = current; if (!r) return; current = undefined; r.controller.abort(); r.finished = true; r.wake?.(); r.confirm(); if (r.handleId) o.agent.cancel(r.handleId); o.stopPlayback?.(); };
  const start = (text: string, speculative: boolean, responseId?: string) => {
    cancel(); const controller = new AbortController(); const turnSignal = AbortSignal.any([signal, controller.signal]);
    let release!: () => void; const confirmed = new Promise<void>(resolve => { release = resolve; });
    const r: Response = { id: inputId, controller, confirmed: !speculative, confirm: release, chunks: [], finished: false, ...(responseId ? { responseId } : {}) }; current = r;

    const profile = createVoiceTurnProfile({ profile: o.profile, ...(o.privacyPin ? { privacyPin: true } : {}), turnId: r.id, metrics: o.metrics, signal: turnSignal, confirmed, ...(o.allowModel ? { allowModel: o.allowModel } : {}),
      emit: e => o.event(e), onDelta: text => { if (turnSignal.aborted) return; r.chunks.push(text); if (r.chunks.join('').length > 131072) { cancel(); return; } r.wake?.(); } });
    if (!speculative) release();
    // Cancellation settles asynchronously in the session pipeline. Wait before opening its replacement turn.
    const predecessor = lastAgent;
    const done: Promise<TurnOutcome> = (async () => {
      if (predecessor) await predecessor.catch(() => {});
      turnSignal.throwIfAborted();
      const h = o.agent.start(text, profile); r.handleId = h.turnId; return h.done;
    })();
    lastAgent = done;
    const agentStart = Date.now();
    const completion = done.then(out => { r.finished = true; r.wake?.(); o.metrics.feature(r.id, 'agent', Date.now() - agentStart); if (out.state === 'failed' && !turnSignal.aborted) { controller.abort(); o.event({ type: 'voice.failed' }); } }).catch(() => { const cancelled = turnSignal.aborted; r.finished = true; controller.abort(); r.wake?.(); if (!cancelled) o.event({ type: 'voice.failed' }); });
    track(completion);
    const audio = (async () => {
      await confirmed; turnSignal.throwIfAborted();
      const chunker = new SentenceChunker(o.profile.sentenceChunking);
      const speak = async (sentence: string) => {
        const t0 = Date.now();
        try { for await (const chunk of o.tts.synthesizeStream(sentence, { signal: turnSignal, ...(o.language ? { language: o.language } : {}) })) {
          if (current !== r || turnSignal.aborted) return;
          o.metrics.firstAudio(r.id); detector.push({ type: 'agent_audio_start', ...(r.responseId ? { responseId: r.responseId } : {}) }); await o.receive(chunk);
        } } finally { o.metrics.feature(r.id, 'tts', Date.now() - t0); }
      };
      while (!r.finished || r.chunks.length) {
        if (!r.chunks.length) { await new Promise<void>(resolve => { r.wake = resolve; }); delete r.wake; }
        turnSignal.throwIfAborted();
        for (const delta of r.chunks.splice(0)) for (const sentence of chunker.push(delta)) await speak(sentence);
      }
      for (const sentence of chunker.flush()) await speak(sentence);
    })().catch(() => { if (!turnSignal.aborted) o.event({ type: 'voice.failed' }); }).finally(() => { if (current === r) { detector.push({ type: 'agent_audio_end', ...(r.responseId ? { responseId: r.responseId } : {}) }); current = undefined; } });
    track(audio);
  };
  const detector = createTurnDetector({ ...o.timers, endpointingMs: o.profile.endpointingMs, speculativeTurnStart: o.profile.speculativeTurnStart, ackSound: false, finalWaitMs: 1000,
    emit(e) {
      if (e.type === 'barge_in' || e.type === 'speculative_cancel' || e.type === 'response_timeout') { cancel(); if (e.type === 'barge_in') o.event({ type: 'barge_in' }); }
      else if (e.type === 'speculative_start') start(e.transcript, true);
      else if (e.type === 'turn_end') {
        if (e.speculative && current) { current.responseId = e.responseId; current.confirmed = true; current.confirm(); }
        else start(e.transcript, false, e.responseId);
      }
    } });
  const reader = (async () => { for await (const e of asr.events) {
    if (closed) break;
    if (e.type === 'final') o.metrics.feature(inputId, 'asr', Date.now() - endAt);
    if (e.type === 'partial' || e.type === 'final') detector.push({ type: 'transcript', text: e.text, final: e.type === 'final' });
    else if (e.type === 'error') { cancel(); o.event({ type: 'voice.failed' }); }
  } })().catch(() => { cancel(); o.event({ type: 'voice.failed' }); });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= Promise.resolve().then(async () => {
    if (closed) return; closed = true; signal.removeEventListener('abort', abort);
    cancel(); detector.push({ type: 'reset' }); lifetime.abort(); await asr.close(); await reader;
    o.vad?.release(); await Promise.allSettled([...jobs]); o.event({ type: 'voice.closed' });
  });
  const abort = () => { void close(); }; signal.addEventListener('abort', abort, { once: true });
  const session: TalkSession = {
    send(pcm) {
      if (closed || signal.aborted) throw new Error('voice-closed');
      if (pcm.byteLength % 2 || pcm.byteLength > 128 * 1024) throw new Error('voice-invalid-audio');
      if (o.vad) { o.vad.value.acceptWaveform(resample(pcm16ToFloat32(pcm), o.sampleRate ?? 16000, 16000)); const next = o.vad.value.isSpeech(); if (next !== speaking) session.speech(next); }
      asr.sendAudio(pcm);
    },
    speech(active) {
      if (closed || speaking === active) return; speaking = active;
      if (active) inputId = randomUUID(); else { endAt = Date.now(); o.metrics.speechEnd(inputId); }
      detector.push({ type: active ? 'speech_start' : 'speech_end' });
      if (!active) asr.commit();
    },
    async idle() { while (jobs.size) await Promise.allSettled([...jobs]); }, close,
  };
  if (signal.aborted) await close();
  return session;
}
