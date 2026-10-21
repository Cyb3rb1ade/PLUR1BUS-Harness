import { join } from 'node:path';
import type { HarnessConfig } from '@plur1bus/config-schema';
import { createFfmpegPorts } from './ffmpeg.ts';
import { mediaError } from './errors.ts';
import type { MediaEmbeddingConfig } from './validate.ts';
import type { MediaSource } from './types.ts';

/** The current host catalogue supports only verified on-device Gemma; never silently choose another encoder. */
export function localMediaSelection(c: MediaEmbeddingConfig): boolean {
  return ['local', 'local-transformers', 'egemma2'].includes(c.provider ?? '') && c.model === 'google/embeddinggemma-2';
}
/** Translate the owned namespace; raw engine.media cannot override host policy. */
export function buildMediaEngineConfig(c: HarnessConfig['memory']['mediaEmbedding'], models: string): Record<string, unknown> {
  return { enabled: c.enabled && localMediaSelection(c) && [128,256,512,768].includes(c.dimensions), provider: 'local-transformers', model: c.model,
    dimensions: c.dimensions, modalities: c.modalities, precision: 'fp32', privacyPin: 'local', cacheDir: models,
    segmentMs: c.video.segmentSec * 1000, maxFrames: Math.min(32,c.video.maxFrames),
    maxAudioSeconds: Math.min(300,c.audio.maxSeconds), backfill: c.backfill };
}
/** Exact Engine 1.19 codec capabilities, injected before createEngine (no attachHost assumption). */
export function createMediaHostCapabilities(o: { home: string; config: () => HarnessConfig }) {
  const ports = createFfmpegPorts({ tempDir: join(o.home,'media','tmp'), allowedRoots: [join(o.home,'media')] });
  const budget = () => localMediaSelection(o.config().memory.mediaEmbedding);
  return { mediaSourceRoot: join(o.home,'media'), mediaBudget: budget, mediaPorts: {
    ...(ports.frames ? { frameExtractor: { async *extract(req: { bytes: Uint8Array; mime: string; intervalMs: number; sceneChanges: boolean }) {
      if (!budget()) throw mediaError('E_MEDIA_UNAVAILABLE','cloud media admission is not bound');
      for await (const frame of ports.frames!.frames({bytes:req.bytes} as MediaSource,{intervalSec:req.intervalMs/1000,sceneDetect:req.sceneChanges,maxFrames:Math.min(32,o.config().memory.mediaEmbedding.video.maxFrames)})) yield { timestampMs:frame.tsMs,bytes:frame.image };
    } } } : {}),
    ...(ports.audio ? { audioDecoder: { async *decode(req: { bytes: Uint8Array; mime: string; sampleRate: number; channels: number; maxSeconds: number; segmentMs: number }) {
      if (!budget()) throw mediaError('E_MEDIA_UNAVAILABLE','cloud media admission is not bound');
      for await (const chunk of ports.audio!.pcm({bytes:req.bytes},{sampleRate:req.sampleRate,mono:true,maxSeconds:req.maxSeconds})) yield {pcm:chunk.samples,startMs:chunk.startMs,sampleRate:req.sampleRate};
    } } } : {}),
  } };
}
