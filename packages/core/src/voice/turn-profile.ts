import { AsyncLocalStorage } from 'node:async_hooks';
import { createFeatureRunner, type FeatureName, type FeatureEvent, type LocalRealtimeProfile } from '../../../voice-providers/src/index.ts';
import type { VoiceMetrics } from './metrics.ts';
/** Internal additive pipeline parameter; never accepted from untrusted RPC params. */
export interface TurnProfile {
  readonly localRealtime: LocalRealtimeProfile;
  /** Future public engine options, carried to TurnMemory; currently advisory, never claimed to be applied. */
  readonly engineOptions: { recall: { reranker: boolean; state: 'engine-fixed' }; capture: { runtime: { deferPostTurnLlm: boolean }; state: 'engine-fixed' } };
  readonly privacyPin?: boolean;
  readonly signal?: AbortSignal;
  readonly allowModel?: (provider: string, model: string) => boolean;
  readonly confirmed?: Promise<void>;
  onDelta?: (text: string) => void;
  run<T>(feature: FeatureName, fn: (signal: AbortSignal) => Promise<T>, fallback: T, signal: AbortSignal): Promise<T>;
  after(feature: FeatureName, fn: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal): Promise<void>;
  drain(signal?: AbortSignal): Promise<void>;
}
export const voiceTurnContext = new AsyncLocalStorage<TurnProfile>();
export function createVoiceTurnProfile(o: { profile: LocalRealtimeProfile; turnId: string; metrics: VoiceMetrics; privacyPin?: boolean; emit?: (event: FeatureEvent) => void; signal?: AbortSignal; allowModel?: (provider: string, model: string) => boolean; confirmed?: Promise<void>; onDelta?: (text: string) => void }): TurnProfile {
  const runner = createFeatureRunner({ profile: o.profile, turnId: o.turnId, emit: event => {
    if ('durationMs' in event) o.metrics.feature(o.turnId, event.feature, event.durationMs);
    if (event.type === 'feature.budget_exceeded') o.metrics.feature(o.turnId, event.feature, event.elapsedMs, true);
    o.emit?.(event);
  } });
  const profile: TurnProfile = {
    localRealtime: o.profile, ...(o.privacyPin ? { privacyPin: true } : {}), engineOptions: { recall: { reranker: o.profile.features.reranker.mode === 'on', state: 'engine-fixed' }, capture: { runtime: { deferPostTurnLlm: o.profile.features.postTurnRefine.mode === 'deferred' }, state: 'engine-fixed' } }, ...(o.signal ? { signal: o.signal } : {}), ...(o.allowModel ? { allowModel: o.allowModel } : {}), ...(o.confirmed ? { confirmed: o.confirmed } : {}), ...(o.onDelta ? { onDelta: o.onDelta } : {}),
    async run(feature, fn, fallback, signal) {
      // Disabled profiles retain the exact original error and abort semantics.
      if (!o.profile.enabled) return fn(signal);
      if (o.profile.features[feature].mode === 'deferred') { runner.defer(feature, s => voiceTurnContext.run(profile, () => fn(s))); return fallback; }
      const r = await runner.runWithBudget(feature, s => voiceTurnContext.run(profile, () => fn(s)), signal);
      signal.throwIfAborted(); return r.ok ? r.value : fallback;
    },
    async after(feature, fn, signal) {
      if (!o.profile.enabled) { await fn(signal); return; }
      const mode = o.profile.features[feature].mode;
      if (mode === 'deferred') runner.defer(feature, s => voiceTurnContext.run(profile, () => fn(s)));
      else if (mode === 'on') await profile.run(feature, fn, undefined, signal);
    },
    async drain(signal) { await runner.drainDeferred(signal); },
  };
  return profile;
}
/** The pinned engine freezes reranker/runtime at construction. Keep host reads unchanged until per-call support exists. */
export function voiceEngineConfig<T extends Record<string, unknown>>(config: T): T { return config; }

export async function waitForVoiceConfirmation(profile: TurnProfile, signal: AbortSignal): Promise<void> {
  if (!profile.confirmed) return;
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason ?? new Error('aborted')); signal.addEventListener('abort', abort, { once: true }); });
  try { await Promise.race([profile.confirmed, cancelled]); } finally { signal.removeEventListener('abort', abort); }
}
