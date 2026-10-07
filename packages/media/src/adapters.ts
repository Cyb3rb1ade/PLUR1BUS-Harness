import { setTimeout as delay } from 'node:timers/promises';
import { HttpTransport, privateHost, checkedUrl, classify } from './http.ts';
import { MediaError, validateRequest, failure } from './types.ts';
import type { ImageAdapter, ImageRequest, ImageResult, GenerationContext, Capabilities, ReferenceImage } from './types.ts';
export type HttpAdapterId = 'openrouter' | 'replicate' | 'fal' | 'together' | 'openai' | 'google' | 'xai' | 'draw-things';
export interface HttpAdapterConfig { id: HttpAdapterId; model: string; baseUrl?: string; apiKey?: string; timeoutMs?: number; pollMs?: number; downloadHosts?: string[]; allowLan?: boolean }
export const defaults: Record<HttpAdapterId, string> = { openrouter: 'https://openrouter.ai/api/v1', replicate: 'https://api.replicate.com/v1', fal: 'https://queue.fal.run', together: 'https://api.together.xyz/v1', openai: 'https://api.openai.com/v1', google: 'https://generativelanguage.googleapis.com/v1beta', xai: 'https://api.x.ai/v1', 'draw-things': 'http://127.0.0.1:7860' };
const dataUrl = (i: ReferenceImage) => `data:image/${i.format};base64,${Buffer.from(i.bytes).toString('base64')}`;
const omitUnsupported = (req: ImageRequest, fields: (keyof ImageRequest)[]) => { if (fields.some(f => req[f] !== undefined)) throw new MediaError('unsupported_parameter'); };
/** Protocol references checked 2026-10-07:
 * OpenRouter chat image modality: https://openrouter.ai/docs/api-reference/chat-completion
 * Replicate prediction lifecycle: https://replicate.com/docs/reference/http
 * fal queue: https://fal.ai/docs/documentation/model-apis/inference/queue (FLUX schnell input profile)
 * Together: https://github.com/togethercomputer/together-typescript/blob/main/src/resources/images.ts
 * OpenAI: https://developers.openai.com/api/docs/guides/image-generation (GPT Image API)
 * Google: https://ai.google.dev/gemini-api/docs/generate-content/image-generation (Gemini)
 * xAI: https://docs.x.ai/developers/model-capabilities/images/generation
 * Draw Things: https://github.com/drawthingsai/draw-things-community/blob/main/Libraries/HTTPAPIServer/Sources/HTTPAPIServer.swift
 * Draw Things ignores masks in HTTPAPI: inpaint is intentionally false. Model-specific gateway profiles are narrow; unknown parameters are refused.
 */
export class HttpImageAdapter implements ImageAdapter {
  readonly id: HttpAdapterId; readonly model: string; readonly config: HttpAdapterConfig; private readonly http: HttpTransport;
  constructor(config: HttpAdapterConfig) {
    this.id = config.id; this.model = config.model; this.config = config;
    if (!config.model || /[?#]/.test(config.model) || config.model.split('/').some(p => p === '.' || p === '..' || !p)) throw new MediaError('unsupported_parameter');
    const base = config.baseUrl ?? defaults[config.id]; const url = checkedUrl(base);
    if (config.id === 'draw-things' && (!privateHost(url.hostname) || config.apiKey || (url.hostname !== 'localhost' && !['127.0.0.1', '[::1]'].includes(url.hostname) && !config.allowLan))) throw new MediaError('unsupported_parameter');
    this.http = new HttpTransport(base, config.apiKey, config.timeoutMs, config.downloadHosts, config.id === 'fal' ? 'Key' : config.id === 'google' ? 'google' : 'Bearer');
    if (config.pollMs !== undefined && (!Number.isFinite(config.pollMs) || config.pollMs < 1)) throw new MediaError('unsupported_parameter');
  }
  capabilities(): Capabilities { return { generate: true, edit: ['openai', 'google', 'openrouter', 'draw-things'].includes(this.id), inpaint: this.id === 'openai' }; }
  generate(req: ImageRequest, context: GenerationContext = {}): Promise<ImageResult> { return this.batch(req, context, false); }
  edit(req: ImageRequest, context: GenerationContext = {}): Promise<ImageResult> {
    if (!this.capabilities().edit || !req.referenceImages?.length) return Promise.reject(new MediaError('unsupported_parameter'));
    return this.batch(req, context, true);
  }
  resume(req: ImageRequest, context: GenerationContext): Promise<ImageResult> {
    if (!['replicate', 'fal'].includes(this.id) || !context.resume || context.resume.model !== this.model || !/^[a-zA-Z0-9_-]+$/.test(context.resume.id)) return Promise.reject(new MediaError('unsupported_parameter'));
    return this.perform(req, context, false);
  }
  private async batch(req: ImageRequest, context: GenerationContext, edit: boolean): Promise<ImageResult> {
    validateRequest(req);
    // Chat/Gemini endpoints do not expose a reliable image-count field. Submit one image per call.
    if (!['openrouter', 'google'].includes(this.id) || (req.n ?? 1) === 1) return this.perform(req, context, edit);
    const start = Date.now(); const files: ImageResult['files'] = []; let metadata: ImageResult['metadata'] | undefined; let cost = 0; let knownCost = true;
    for (let i = 0; i < req.n!; i++) {
      try {
        const output = await this.perform({ ...req, n: 1 }, { ...context, onProgress: async p => { await context.onProgress?.({ ...p, fraction: (i + p.fraction) / req.n! }); } }, edit);
        files.push(...output.files); const { costUsd: _costUsd, ...rest } = output.metadata; metadata = rest;
        if (output.metadata.costUsd === undefined) knownCost = false; else cost += output.metadata.costUsd;
      } catch (e) {
        if (!files.length || !(e instanceof MediaError) || !['backend_unavailable', 'timeout'].includes(e.code) || context.signal?.aborted) throw e;
        return { files, metadata: { ...metadata!, ...(knownCost ? { costUsd: cost } : {}), durationMs: Date.now() - start }, partial: true };
      }
    }
    return { files, metadata: { ...metadata!, ...(knownCost ? { costUsd: cost } : {}), durationMs: Date.now() - start }, partial: files.length < req.n! };
  }
  private payload(req: ImageRequest, edit: boolean): { path: string; body: unknown } {
    const n = req.n ?? 1; const refs = req.referenceImages ?? [];
    if (req.mask && !this.capabilities().inpaint) throw new MediaError('unsupported_parameter');
    if (!edit && (refs.length || req.mask)) throw new MediaError('unsupported_parameter');
    if (this.id === 'openai') {
      omitUnsupported(req, ['seed', 'steps', 'guidance', 'negativePrompt', 'aspect']);
      const body = { model: this.model, prompt: req.prompt, n, output_format: req.format ?? 'png', ...(req.size ? { size: `${req.size.width}x${req.size.height}` } : {}) };
      if (!edit) return { path: 'images/generations', body };
      const form = new FormData(); for (const [k, v] of Object.entries(body)) form.set(k, String(v));
      for (const i of refs) form.append('image[]', new Blob([Buffer.from(i.bytes)], { type: `image/${i.format}` }), `image.${i.format}`);
      if (req.mask) form.set('mask', new Blob([Buffer.from(req.mask.bytes)], { type: `image/${req.mask.format}` }), `mask.${req.mask.format}`);
      return { path: 'images/edits', body: form };
    }
    if (this.id === 'openrouter') {
      omitUnsupported(req, ['seed', 'steps', 'guidance', 'negativePrompt', 'size', 'format']);
      return { path: 'chat/completions', body: { model: this.model, modalities: ['image', 'text'], messages: [{ role: 'user', content: [{ type: 'text', text: req.prompt }, ...refs.map(i => ({ type: 'image_url', image_url: { url: dataUrl(i) } }))] }], ...(req.aspect ? { image_config: { aspect_ratio: req.aspect } } : {}) } };
    }
    if (this.id === 'google') {
      omitUnsupported(req, ['seed', 'steps', 'guidance', 'negativePrompt', 'size', 'format']);
      return { path: `models/${encodeURIComponent(this.model)}:generateContent`, body: { contents: [{ parts: [{ text: req.prompt }, ...refs.map(i => ({ inlineData: { mimeType: `image/${i.format}`, data: Buffer.from(i.bytes).toString('base64') } }))] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(req.aspect ? { imageConfig: { aspectRatio: req.aspect } } : {}) } } };
    }
    if (this.id === 'xai') {
      omitUnsupported(req, ['seed', 'steps', 'guidance', 'negativePrompt', 'size', 'format']);
      return { path: 'images/generations', body: { model: this.model, prompt: req.prompt, n, response_format: 'b64_json', ...(req.aspect ? { aspect_ratio: req.aspect } : {}) } };
    }
    if (this.id === 'draw-things') {
      omitUnsupported(req, ['aspect', 'format']);
      if (refs.length > 1) throw new MediaError('unsupported_parameter');
      return { path: `sdapi/v1/${edit ? 'img2img' : 'txt2img'}`, body: { model: this.model, prompt: req.prompt, negative_prompt: req.negativePrompt ?? '', batch_size: n, ...(req.size ?? {}), ...(req.seed === undefined ? {} : { seed: req.seed }), ...(req.steps === undefined ? {} : { steps: req.steps }), ...(req.guidance === undefined ? {} : { cfg_scale: req.guidance }), ...(edit ? { init_images: refs.map(i => Buffer.from(i.bytes).toString('base64')) } : {}) } };
    }
    if (this.id === 'together') {
      omitUnsupported(req, ['aspect']); if (req.format === 'webp') throw new MediaError('unsupported_parameter');
      return { path: 'images/generations', body: { model: this.model, prompt: req.prompt, n, response_format: 'base64', output_format: req.format ?? 'png', ...(req.size ?? {}), ...(req.seed === undefined ? {} : { seed: req.seed }), ...(req.steps === undefined ? {} : { steps: req.steps }), ...(req.guidance === undefined ? {} : { guidance_scale: req.guidance }), ...(req.negativePrompt === undefined ? {} : { negative_prompt: req.negativePrompt }) } };
    }
    // Gateway profile: FLUX schnell. Other model schemas must get a separate explicit profile.
    omitUnsupported(req, this.id === 'replicate' ? ['negativePrompt', 'guidance', 'size'] : ['negativePrompt', 'aspect']);
    if (this.id === 'fal' && req.format === 'webp') throw new MediaError('unsupported_parameter');
    const input = { prompt: req.prompt, ...(req.seed === undefined ? {} : { seed: req.seed }), ...(req.steps === undefined ? {} : { num_inference_steps: req.steps }), ...(req.aspect ? { aspect_ratio: req.aspect } : {}), output_format: req.format ?? 'png' };
    if (this.id === 'replicate') return { path: `models/${this.model}/predictions`, body: { input: { ...input, output_format: req.format === 'jpeg' ? 'jpg' : req.format ?? 'png', num_outputs: n } } };
    return { path: this.model, body: { ...input, num_images: n, enable_safety_checker: true, ...(req.size ? { image_size: req.size } : {}), ...(req.guidance === undefined ? {} : { guidance_scale: req.guidance }) } };
  }
  private async poll(id: string, signal: AbortSignal, context: GenerationContext): Promise<Record<string, unknown>> {
    const path = this.id === 'replicate' ? `predictions/${id}` : `${this.model}/requests/${id}`;
    while (true) {
      const status = await this.http.json(this.id === 'fal' ? `${path}/status` : path, undefined, signal);
      if (status.status === 'canceled') throw new MediaError('cancelled');
      if (status.status === 'failed') throw classify(500, status);
      if (status.status === 'succeeded') return status;
      if (status.status === 'COMPLETED') return this.http.json(path, undefined, signal);
      await context.onProgress?.({ fraction: 0.5, stage: 'running' }); await delay(this.config.pollMs ?? 1000, undefined, { signal });
    }
  }
  private async perform(req: ImageRequest, context: GenerationContext, edit: boolean): Promise<ImageResult> {
    validateRequest(req); const payload = this.payload(req, edit); const started = Date.now();
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 120000); const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    let externalId: string | undefined;
    try {
      signal.throwIfAborted(); await context.onProgress?.({ fraction: 0, stage: 'running' });
      let json: Record<string, unknown>;
      if (context.resume) { externalId = context.resume.id; json = await this.poll(externalId, signal, context); }
      else {
        json = await this.http.json(payload.path, payload.body, signal);
        if (this.id === 'replicate' || this.id === 'fal') {
          const id = json[this.id === 'replicate' ? 'id' : 'request_id']; if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new MediaError('invalid_response');
          externalId = id; await context.onCheckpoint?.({ id, model: this.model });
          if (this.id === 'replicate' && json.status === 'succeeded') { /* synchronous completion */ }
          else json = await this.poll(id, signal, context);
        }
      }
      if ((json.promptFeedback as { blockReason?: unknown } | undefined)?.blockReason || (Array.isArray(json.candidates) && json.candidates.some((c: { finishReason?: string }) => ['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'IMAGE_PROHIBITED_CONTENT'].includes(c.finishReason ?? ''))) || json.respect_moderation === false || (Array.isArray(json.data) && json.data.some((item: { respect_moderation?: boolean }) => item.respect_moderation === false)) || (Array.isArray(json.has_nsfw_concepts) && json.has_nsfw_concepts.some(Boolean))) throw new MediaError('content_policy');
      const values: string[] = [];
      if (this.id === 'openrouter') {
        const choices = json.choices as { message?: { images?: { image_url?: { url?: string } }[] }; finish_reason?: string }[] | undefined;
        if (choices?.some(c => c.finish_reason === 'content_filter')) throw new MediaError('content_policy');
        for (const c of choices ?? []) for (const image of c.message?.images ?? []) if (image.image_url?.url) values.push(image.image_url.url);
      } else if (this.id === 'google') {
        const candidates = json.candidates as { content?: { parts?: { inlineData?: { data: string; mimeType: string } }[] } }[] | undefined;
        for (const c of candidates ?? []) for (const p of c.content?.parts ?? []) if (p.inlineData) values.push(`data:${p.inlineData.mimeType};base64,${p.inlineData.data}`);
      } else if (this.id === 'replicate') {
        if (Array.isArray(json.output)) values.push(...json.output.filter((v): v is string => typeof v === 'string'));
        else if (typeof json.output === 'string') values.push(json.output);
      } else if (this.id === 'fal') {
        for (const image of (json.images ?? []) as { url: string }[]) values.push(image.url);
      } else if (this.id === 'draw-things') values.push(...(json.images ?? []) as string[]);
      else for (const item of (json.data ?? []) as { b64_json?: string; url?: string }[]) { const v = item.b64_json ?? item.url; if (v) values.push(v); }
      if (!values.length || values.length > 10) throw new MediaError('invalid_response');
      await context.onProgress?.({ fraction: 0.9, stage: 'downloading' });
      const files = []; for (const value of values) files.push(await this.http.image(value, req.format ?? (this.id === 'xai' ? 'jpeg' : 'png'), signal));
      return { files, metadata: { adapter: this.id, model: this.model, durationMs: Date.now() - started, ...(typeof json.seed === 'number' ? { seed: json.seed } : req.seed === undefined ? {} : { seed: req.seed }), origin: this.http.base.origin, ...(typeof (json.usage as { cost?: unknown } | undefined)?.cost === 'number' ? { costUsd: (json.usage as { cost: number }).cost } : {}) }, partial: files.length < (req.n ?? 1) };
    } catch (error) {
      if (signal.aborted && externalId) {
        // Best effort remote cancellation, independently bounded; never bypass moderation or resubmit.
        try { await this.http.json(this.id === 'replicate' ? `predictions/${externalId}/cancel` : `${this.model}/requests/${externalId}/cancel`, {}, AbortSignal.timeout(2000), this.id === 'fal' ? 'PUT' : 'POST'); } catch { /* preserve original failure */ }
      }
      if (timeout.aborted && !context.signal?.aborted) throw new MediaError('timeout');
      throw failure(error, context.signal);
    }
  }
}
