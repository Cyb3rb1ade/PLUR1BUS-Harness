import { FEATURE_NAMES, FeatureLatencyRecorder } from '../../../voice-providers/src/index.ts';
import { createRegistry } from '../metrics/registry.ts';
/** No agent/session/model labels. 12 feature values + other, eight histogram series each: below the 1024 cap. */
export const VOICE_STEPS = [...FEATURE_NAMES, 'asr', 'agent', 'tts', 'speechToAudio'] as const;
export type VoiceStep = typeof VOICE_STEPS[number];
export class VoiceMetrics {
  readonly recorder: FeatureLatencyRecorder;
  readonly #registry = createRegistry();
  readonly #duration = this.#registry.histogram('plur1bus_voice_step_ms', 'Voice feature duration in milliseconds.', { feature: VOICE_STEPS }, [10, 30, 100, 500, 2000]);
  readonly #cost = this.#registry.counter('plur1bus_voice_cost_micros_total', 'Attributed voice cost; unknown costs are omitted.', { feature: VOICE_STEPS });
  readonly #unpriced: Partial<Record<VoiceStep, number>> = {};
  readonly #speech = new Map<string, number>();
  readonly #now: () => number;
  readonly #maxTurns: number;
  readonly #costs: Partial<Record<VoiceStep, number>> = {};
  constructor(now: () => number = Date.now, maxTurns = 500) { this.#now = now; this.#maxTurns = Math.max(1, maxTurns); this.recorder = new FeatureLatencyRecorder({ now, maxTurns }); }
  feature(turnId: string, feature: VoiceStep, ms: number, exceeded = false): void {
    if (!VOICE_STEPS.includes(feature) || !Number.isFinite(ms)) return;
    this.recorder.recordFeature(turnId, feature, ms, exceeded); this.#duration.observe({ feature }, ms);
  }
  cost(feature: string, costMicros: number | undefined): void {
    if (!(VOICE_STEPS as readonly string[]).includes(feature)) return;
    if (costMicros === undefined) { const step = feature as VoiceStep; this.#unpriced[step] = (this.#unpriced[step] ?? 0) + 1; return; }
    if (!Number.isFinite(costMicros) || costMicros < 0) return;
    const step = feature as VoiceStep; this.#costs[step] = (this.#costs[step] ?? 0) + costMicros; this.#cost.inc({ feature }, costMicros);
  }
  speechEnd(id: string): void { this.recorder.markSpeechEnd(id); this.#speech.set(id, this.#now()); while (this.#speech.size > this.#maxTurns) this.#speech.delete(this.#speech.keys().next().value!); }
  firstAudio(id: string): void { this.recorder.markFirstAudio(id); const start = this.#speech.get(id); if (start !== undefined) { this.#speech.delete(id); this.feature(id, 'speechToAudio', this.#now() - start); } }
  report() { return { ...this.recorder.report(), engineFeatures: { reranker: 'engine-fixed' as const, postTurnRefine: 'engine-fixed' as const }, costMicros: { ...this.#costs }, unpricedReports: { ...this.#unpriced } }; }
  render(): string { return this.#registry.render(); }
}
