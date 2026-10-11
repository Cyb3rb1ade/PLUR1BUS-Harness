export const MEDIA_GENERATE = 'media.generate';
export const MEDIA_EDIT = 'media.edit';
export type ErrorCode = 'content_policy' | 'quota' | 'too_large' | 'unsupported_parameter' | 'backend_unavailable' | 'timeout' | 'cancelled' | 'invalid_response' | 'interrupted';
/** Deliberately stores only a stable code: remote bodies, URLs and credentials never enter errors. */
export class MediaError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { super(`Media operation failed: ${code}`); this.name = 'MediaError'; this.code = code; }
}
export type ImageFormat = 'png' | 'jpeg' | 'webp';
export interface ReferenceImage { bytes: Uint8Array; format: ImageFormat }
export type VideoFormat = 'mp4' | 'webm' | 'mov';
export interface VideoCapabilities { model?: string; textToVideo: boolean; imageToVideo: boolean; videoToVideo: boolean; durationSeconds?: [number, number]; resolutions?: string[]; aspects?: string[]; fps?: number[]; audio?: boolean }
export interface ImageRequest {
  kind?: 'image' | 'video'; durationSeconds?: number; resolution?: string; fps?: number; audio?: boolean;
  videoFormat?: VideoFormat; referenceVideo?: { bytes: Uint8Array; format: VideoFormat };

  prompt: string; negativePrompt?: string; size?: { width: number; height: number }; aspect?: string;
  n?: number; seed?: number; steps?: number; guidance?: number; referenceImages?: ReferenceImage[];
  mask?: ReferenceImage; format?: ImageFormat; embedMetadata?: boolean;
}
export interface Capabilities { generate: boolean; edit: boolean; inpaint: boolean; variation?: boolean; upscale?: boolean; video?: VideoCapabilities }
export interface Progress { fraction: number; stage?: 'queued' | 'running' | 'downloading' }
export interface ResumeToken { id: string; model: string }
export interface GenerationContext {
  signal?: AbortSignal; onProgress?: (progress: Progress) => void | Promise<void>;
  /** Must be durable before polling starts. */
  onCheckpoint?: (token: ResumeToken) => Promise<void>; resume?: ResumeToken;
}
export interface ImageResult {
  processingSignal?: AbortSignal;
  files: { bytes: Uint8Array; format: ImageFormat | VideoFormat; stream?: AsyncIterable<Uint8Array> }[];
  metadata: { adapter: string; model: string; durationMs: number; seed?: number; costUsd?: number; origin?: string; costStatus?: 'known' | 'unknown'; estimatedCostUsd?: number | null };
  partial?: boolean;
}
export interface ImageAdapter {
  readonly id: string; readonly model?: string; capabilities(): Capabilities;
  generate(req: ImageRequest, context?: GenerationContext): Promise<ImageResult>;
  edit(req: ImageRequest, context?: GenerationContext): Promise<ImageResult>;
  variation?(req: ImageRequest, context?: GenerationContext): Promise<ImageResult>;
  upscale?(req: ImageRequest, context?: GenerationContext): Promise<ImageResult>;
  resume?(req: ImageRequest, context: GenerationContext): Promise<ImageResult>;
}
export function validateRequest(req: ImageRequest): void {
  if (req.kind !== undefined && !['image', 'video'].includes(req.kind)) throw new MediaError('unsupported_parameter');
  if (req.kind === 'video') {
    if ((req.n ?? 1) !== 1 || req.mask || req.format || req.steps !== undefined || req.guidance !== undefined) throw new MediaError('unsupported_parameter');
    if (req.durationSeconds !== undefined && (!Number.isFinite(req.durationSeconds) || req.durationSeconds <= 0 || req.durationSeconds > 600)) throw new MediaError('unsupported_parameter');
    if (req.fps !== undefined && (!Number.isInteger(req.fps) || req.fps < 1 || req.fps > 120)) throw new MediaError('unsupported_parameter');
    if (req.videoFormat !== undefined && !['mp4','webm','mov'].includes(req.videoFormat)) throw new MediaError('unsupported_parameter');
    if ((req.referenceVideo?.bytes.byteLength ?? 0) > 50 * 1024 * 1024) throw new MediaError('too_large');
  } else if ([req.durationSeconds, req.resolution, req.fps, req.audio, req.videoFormat, req.referenceVideo].some(v => v !== undefined)) throw new MediaError('unsupported_parameter');
  if (!req.prompt?.trim() || (req.n !== undefined && (!Number.isInteger(req.n) || req.n < 1 || req.n > 10))) throw new MediaError('unsupported_parameter');
  if (req.prompt.length > 32000 || req.referenceImages?.some(i => i.bytes.byteLength > 50 * 1024 * 1024) || (req.mask?.bytes.byteLength ?? 0) > 50 * 1024 * 1024) throw new MediaError('too_large');
  if (req.size && Object.keys(req.size).some(key => key !== 'width' && key !== 'height')) throw new MediaError('unsupported_parameter');
  if (req.size && (![req.size.width, req.size.height].every(v => Number.isInteger(v) && v > 0 && v <= 8192))) throw new MediaError('unsupported_parameter');
  if ([req.seed, req.steps, req.guidance].some(v => v !== undefined && !Number.isFinite(v))) throw new MediaError('unsupported_parameter');
  if (req.steps !== undefined && (!Number.isInteger(req.steps) || req.steps < 1 || req.steps > 1000)) throw new MediaError('unsupported_parameter');
  if (req.format !== undefined && !['png', 'jpeg', 'webp'].includes(req.format)) throw new MediaError('unsupported_parameter');
}
export function failure(error: unknown, signal?: AbortSignal): MediaError {
  if (signal?.aborted) return new MediaError('cancelled');
  if (error instanceof MediaError) return error;
  if (error instanceof Error && error.name === 'TimeoutError') return new MediaError('timeout');
  return new MediaError('backend_unavailable');
}
export function metadataEnabled(values: { global?: boolean; agent?: boolean; call?: boolean }): boolean { return values.call ?? values.agent ?? values.global ?? false; }

/** Additive public names; existing image callers remain source-compatible. */
export interface VideoRequest extends ImageRequest { kind: 'video' }
export type MediaRequest = ImageRequest;
export type MediaResult = ImageResult;
export type MediaAdapter = ImageAdapter;
