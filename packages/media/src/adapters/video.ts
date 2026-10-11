import { MediaError, validateRequest, failure } from '../types.ts';
import type { ImageRequest, ImageResult, GenerationContext, VideoCapabilities } from '../types.ts';
import { ResilientTransport } from './_shared/transport.ts';
import { defaultSleep } from './_shared/retry.ts';
import { sanitizeRequest } from './_shared/images.ts';
import { sanitizeVideo } from '../video.ts';
import { estimateCost } from '../cost.ts';
import { parseModelRef, parseInputSchema, mapReplicateInput } from './replicate-schema.ts';
import type { InputSchema } from './replicate-schema.ts';
import type { HttpAdapterConfig } from '../adapters.ts';
import { defaults } from '../adapters.ts';
export interface VideoProfile extends VideoCapabilities { model?: string; inputSchema?: InputSchema }
/** Protocol references and availability: docs/media-adapters.md, checked 2026-10-10. Model ids come only from configuration. */
export class HttpVideoAdapter {
  readonly config: HttpAdapterConfig; readonly id: string; readonly model: string; private readonly http: ResilientTransport;
  constructor(config: HttpAdapterConfig) {
    const {apiKey: _key,...publicConfig} = config; this.config = publicConfig; this.id = config.id; this.model = config.video?.model ?? config.model;
    if (!this.model || /[?#]/.test(this.model) || this.model.split('/').some(p => !p || p === '.' || p === '..')) throw new MediaError('unsupported_parameter');
    this.http = new ResilientTransport(config.baseUrl ?? defaults[config.id], config.apiKey, {adapter:config.id,authKind:config.id === 'google' ? 'google' : config.id === 'fal' ? 'Key' : 'Bearer',...(config.retry ? {retry:config.retry} : {}),...(config.downloadHosts ? {downloadHosts:config.downloadHosts} : {})});
  }
  capabilities(): VideoCapabilities {
    if (!['google','openrouter','xai','replicate','fal'].includes(this.id) || !this.config.video) return {textToVideo:false,imageToVideo:false,videoToVideo:false};
    return {...this.config.video, videoToVideo: this.id === 'openrouter' ? false : this.config.video.videoToVideo};
  }
  async execute(input: ImageRequest, context: GenerationContext = {}, edit = false): Promise<ImageResult> {
    validateRequest(input); const cap = this.capabilities();
    if (input.kind !== 'video' || (!edit && !cap.textToVideo) || (input.referenceImages?.length && !cap.imageToVideo) || (input.referenceVideo && !cap.videoToVideo) || (edit && !input.referenceVideo && !input.referenceImages?.length)) throw new MediaError('unsupported_parameter');
    if (input.referenceVideo && input.referenceImages?.length || (input.referenceImages?.length ?? 0) > 1 || input.size || input.steps || input.guidance || input.mask || input.format) throw new MediaError('unsupported_parameter');
    if (input.durationSeconds !== undefined && cap.durationSeconds && (input.durationSeconds < cap.durationSeconds[0] || input.durationSeconds > cap.durationSeconds[1]) || input.resolution && cap.resolutions && !cap.resolutions.includes(input.resolution) || input.aspect && cap.aspects && !cap.aspects.includes(input.aspect) || input.fps !== undefined && (!cap.fps || !cap.fps.includes(input.fps)) || input.audio !== undefined && !cap.audio) throw new MediaError('unsupported_parameter');
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 3600000), signal = context.signal ? AbortSignal.any([context.signal,timeout]) : timeout;
    let external: string | undefined; const started = Date.now();
    try {
      signal.throwIfAborted();
      const req = { ...sanitizeRequest(input) };
      if (req.referenceVideo) req.referenceVideo = await sanitizeVideo(req.referenceVideo.bytes,this.config.videoProcessor,signal);
      const data = (ref: {bytes:Uint8Array;format:string}, kind: string) => `data:${kind}/${ref.format === 'mov' ? 'quicktime' : ref.format};base64,${Buffer.from(ref.bytes).toString('base64')}`;
      let response: Record<string,any>;
      if (context.resume) {
        if (context.resume.model !== this.model || !this.validId(context.resume.id)) throw new MediaError('unsupported_parameter');
        external = context.resume.id; response = {};
      } else {
        let path: string, body: unknown;
        if (this.id === 'google') {
          if (req.fps !== undefined || req.audio !== undefined || req.seed !== undefined) throw new MediaError('unsupported_parameter');
          path = `models/${encodeURIComponent(this.model)}:predictLongRunning`;
          body = {instances:[{prompt:req.prompt,...(req.referenceImages?.[0] ? {image:{inlineData:{data:Buffer.from(req.referenceImages[0].bytes).toString('base64'),mimeType:`image/${req.referenceImages[0].format}`}}} : {}),...(req.referenceVideo ? {video:{inlineData:{data:Buffer.from(req.referenceVideo.bytes).toString('base64'),mimeType:`video/${req.referenceVideo.format === 'mov' ? 'quicktime' : req.referenceVideo.format}`}}} : {})}],parameters:{numberOfVideos:1,...(req.durationSeconds === undefined ? {} : {durationSeconds:req.durationSeconds}),...(req.resolution ? {resolution:req.resolution} : {}),...(req.aspect ? {aspectRatio:req.aspect} : {}),...(req.negativePrompt ? {negativePrompt:req.negativePrompt} : {})}};
        } else if (this.id === 'openrouter') {
          if (req.referenceVideo || req.fps !== undefined || req.negativePrompt) throw new MediaError('unsupported_parameter');
          const catalog = await this.http.json('videos/models',undefined,signal);
          const model = (catalog.data as Record<string,any>[] | undefined)?.find(m => m.id === this.model);
          if (!model) throw new MediaError('unsupported_parameter');
          for (const [key,value] of [['supported_durations',req.durationSeconds],['supported_resolutions',req.resolution],['supported_aspect_ratios',req.aspect]] as const) if (value !== undefined && Array.isArray(model[key]) && !model[key].includes(value)) throw new MediaError('unsupported_parameter');
          path = 'videos'; body = {model:this.model,prompt:req.prompt,...(req.durationSeconds === undefined ? {} : {duration:req.durationSeconds}),...(req.resolution ? {resolution:req.resolution} : {}),...(req.aspect ? {aspect_ratio:req.aspect} : {}),...(req.audio === undefined ? {} : {generate_audio:req.audio}),...(req.seed === undefined ? {} : {seed:req.seed}),...(req.referenceImages?.[0] ? {frame_images:[{type:'image_url',frame_type:'first_frame',image_url:{url:data(req.referenceImages[0],'image')}}]} : {})};
        } else if (this.id === 'xai') {
          if (req.fps !== undefined || req.audio !== undefined || req.negativePrompt || req.seed !== undefined) throw new MediaError('unsupported_parameter');
          path = req.referenceVideo ? 'videos/edits' : 'videos/generations';
          body = {model:this.model,prompt:req.prompt,...(req.referenceVideo ? {video:{url:data(req.referenceVideo,'video')}} : {}),...(req.referenceImages?.[0] ? {image:{url:data(req.referenceImages[0],'image')}} : {}),...(req.durationSeconds === undefined ? {} : {duration:req.durationSeconds}),...(req.resolution ? {resolution:req.resolution} : {}),...(req.aspect ? {aspect_ratio:req.aspect} : {})};
        } else {
          let schema = this.config.video?.inputSchema;
          const ref = this.id === 'replicate' ? parseModelRef(this.model) : undefined;
          if (this.id === 'replicate') {
            if (!ref) throw new MediaError('unsupported_parameter');
            schema = parseInputSchema(await this.http.json(`models/${ref.owner}/${ref.name}${ref.version ? `/versions/${ref.version}` : ''}`,undefined,signal));
          }
          if (!schema) throw new MediaError('unsupported_parameter');
          const mapped = mapReplicateInput(req,schema,!!req.referenceImages?.length);
          const set = (names: string[], value: unknown) => {
            if (value === undefined) return; const key = names.find(n=>Object.hasOwn(schema!,n)); if (!key) throw new MediaError('unsupported_parameter');
            const prop = schema![key]!;
            if (prop.enum && !prop.enum.includes(value) || typeof value === 'number' && (prop.minimum !== undefined && value < prop.minimum || prop.maximum !== undefined && value > prop.maximum)) throw new MediaError('unsupported_parameter');
            mapped[key] = value;
          };
          set(['duration','duration_seconds','seconds'],req.durationSeconds); set(['resolution'],req.resolution); set(['fps','frame_rate'],req.fps); set(['generate_audio','audio'],req.audio); set(['video_url','video','input_video'],req.referenceVideo ? data(req.referenceVideo,'video') : undefined);
          path = this.id === 'fal' ? this.model : ref!.version ? 'predictions' : `models/${ref!.owner}/${ref!.name}/predictions`;
          body = this.id === 'fal' ? mapped : {input:mapped,...(ref!.version ? {version:ref!.version} : {})};
        }
        response = await this.http.json(path,body,signal);
        const id = response[this.id === 'google' ? 'name' : ['openrouter','replicate'].includes(this.id) ? 'id' : 'request_id'];
        if (typeof id !== 'string' || !this.validId(id)) throw new MediaError('invalid_response');
        external = id; await context.onCheckpoint?.({id,model:this.model});
      }
      if (['failed','FAILED','expired'].includes(response.status)) throw failureCode(response.error);
      while (!this.done(response)) {
        await context.onProgress?.({fraction:typeof response.progress === 'number' ? Math.min(0.85,Math.max(0,response.progress / 100)) : 0.2,stage:response.status === 'queued' || response.status === 'IN_QUEUE' ? 'queued' : 'running'});
        await (this.config.pollWait ?? defaultSleep)(this.config.pollMs ?? 5000,signal);
        response = await this.http.json(this.pollPath(external),undefined,signal);
        if (['failed','FAILED','expired'].includes(response.status)) throw failureCode(response.error);
        if (['canceled','cancelled','CANCELLED'].includes(response.status)) throw new MediaError('cancelled');
        if (response.error) throw failureCode(response.error);
      }
      if (this.id === 'fal') response = await this.http.json(`${this.queueModel()}/requests/${external}`,undefined,signal);
      if (response.response?.generateVideoResponse?.raiMediaFilteredCount || response.video?.respect_moderation === false || response.has_nsfw_concepts?.some(Boolean)) throw new MediaError('content_policy');
      const value = this.id === 'openrouter' ? `${this.http.base.toString().replace(/\/$/,'')}/videos/${external}/content` : this.id === 'google' ? response.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri : this.id === 'replicate' ? (Array.isArray(response.output) ? response.output[0] : response.output) : response.video?.url;
      if (typeof value !== 'string') throw new MediaError('invalid_response');
      const cost = response.cost ?? response.usage?.cost; if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) throw new MediaError('invalid_response');
      await context.onProgress?.({fraction:0.9,stage:'downloading'});
      return {files:[{bytes:new Uint8Array(),format:'mp4',stream:this.http.stream(value,signal,['google','openrouter'].includes(this.id))}],processingSignal:signal,metadata:{adapter:this.id,model:this.model,durationMs:Date.now()-started,origin:this.http.base.origin,...(typeof cost === 'number' ? {costUsd:cost} : {}),costStatus:typeof cost === 'number' ? 'known' : 'unknown',estimatedCostUsd:estimateCost({...req,durationSeconds:req.durationSeconds ?? 8},{id:this.id,model:this.model}).usd}};
    } catch(e) {
      // Only documented cancel endpoints; Google/xAI/OpenAI have no generation cancel API in the checked docs.
      if (signal.aborted && external && ['replicate','fal'].includes(this.id)) await this.http.json(this.id === 'replicate' ? `predictions/${external}/cancel` : `${this.queueModel()}/requests/${external}/cancel`,{},AbortSignal.timeout(5000),this.id === 'fal' ? 'PUT' : 'POST').catch(()=>{});
      if (timeout.aborted && !context.signal?.aborted) throw new MediaError('timeout');
      throw failure(e,context.signal?.aborted ? context.signal : undefined);
    }
  }
  private validId(id: string): boolean { return this.id === 'google' ? /^(?:models\/[A-Za-z0-9._-]+\/)?operations\/[A-Za-z0-9_-]+$/.test(id) : /^[A-Za-z0-9_-]+$/.test(id); }
  private queueModel(): string { return this.model.split('/').slice(0,2).join('/'); }
  private pollPath(id: string): string { return this.id === 'google' ? id : this.id === 'replicate' ? `predictions/${id}` : this.id === 'fal' ? `${this.queueModel()}/requests/${id}/status` : `videos/${id}`; }
  private done(r: Record<string,any>): boolean { return r.done === true || ['succeeded','completed','done','COMPLETED'].includes(r.status); }
}
function failureCode(error: unknown): MediaError { return new MediaError(/safety|moderation|content.policy|responsible.ai/i.test(JSON.stringify(error)) ? 'content_policy' : 'backend_unavailable'); }
