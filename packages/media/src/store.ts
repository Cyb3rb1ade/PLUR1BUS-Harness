import { createReadStream } from 'node:fs';
import { processVideo, videoFormat, type VideoProcessor, type VideoInfo } from './video.ts';
import { mkdir, readdir, readFile, rename, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safeId } from './files.ts';
import { embedImage } from './adapters/_shared/metadata.ts';
import { MediaError, metadataEnabled, validateRequest } from './types.ts';
import type { ImageRequest, ImageResult } from './types.ts';
export interface Manifest {
  schema: 'media.output/1'; id: string; createdAt: number; prompt: string; kind?: 'image' | 'video'; parameters: Omit<ImageRequest, 'referenceImages' | 'mask' | 'referenceVideo'>;
  referenceHashes: string[]; maskHash?: string; metadata: Omit<ImageResult['metadata'], 'seed' | 'costUsd'> & { seed: number | null; costUsd: number | null; origin: string }; partial: boolean;
  files: { path: string; sha256: string; bytes: number; format: string; durationSeconds?: number; width?: number; height?: number; fps?: number; audio?: boolean; poster?: { path: string; sha256: string; bytes: number } }[];
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class OutputStore {
  readonly root: string; readonly options: { quotaBytes?: number; retentionMs?: number; embedMetadata?: boolean; maxVideoBytes?: number; videoProcessor?: VideoProcessor };
  constructor(root: string, options: OutputStore['options'] = {}) {
    this.root = root; this.options = options;
    if ([options.quotaBytes, options.retentionMs, options.maxVideoBytes].some(v => v !== undefined && (!Number.isFinite(v) || v < 0))) throw new MediaError('unsupported_parameter');
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, '.lock');
    try { await mkdir(lock); } catch { throw new MediaError('backend_unavailable'); }
    try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
  }
  private async manifests(): Promise<Manifest[]> {
    const entries = await readdir(this.root, { withFileTypes: true }); const out: Manifest[] = [];
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) out.push(JSON.parse(await readFile(join(this.root, e.name, 'manifest.json'), 'utf8')) as Manifest);
    return out;
  }
  async delete(id: string): Promise<void> {
    safeId(id);
    await this.locked(async () => { await rm(join(this.root, id), { recursive: true, force: true }); });
  }
  async get(id: string): Promise<Manifest | null> {
    try { return JSON.parse(await readFile(join(this.root, safeId(id), 'manifest.json'), 'utf8')) as Manifest; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  /** Requires exclusive host ownership after the previous process exited. Discards unpublished staging only. */
  async recoverStaging(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root)) if (name === '.lock' || /^\.stage-[a-f0-9-]+$/.test(name)) await rm(join(this.root, name), { recursive: true, force: true });
  }
  async prune(now = Date.now()): Promise<number> {
    return this.locked(async () => {
      let removed = 0;
      for (const m of await this.manifests()) if (now - m.createdAt >= (this.options.retentionMs ?? Infinity)) { await rm(join(this.root, safeId(m.id)), { recursive: true }); removed++; }
      return removed;
    });
  }
  async put(id: string, req: ImageRequest, result: ImageResult, agentMetadata?: boolean): Promise<Manifest> {
    safeId(id); validateRequest(req);
    if (req.kind === 'video') return this.putVideo(id, req, result, agentMetadata);
    if (!result.files.length) throw new MediaError('invalid_response');
    const { referenceImages, mask, ...parameters } = req;
    const manifest: Manifest = { schema: 'media.output/1', id, createdAt: Date.now(), prompt: req.prompt, parameters, referenceHashes: (referenceImages ?? []).map(i => hash(i.bytes)), ...(mask ? { maskHash: hash(mask.bytes) } : {}), metadata: { ...result.metadata, seed: result.metadata.seed ?? null, costUsd: result.metadata.costUsd ?? null, origin: result.metadata.origin ?? 'unknown' }, partial: result.partial ?? false, files: [] };
    const embed = metadataEnabled({ ...(this.options.embedMetadata === undefined ? {} : { global: this.options.embedMetadata }), ...(agentMetadata === undefined ? {} : { agent: agentMetadata }), ...(req.embedMetadata === undefined ? {} : { call: req.embedMetadata }) });
    const files = result.files.map((f, index) => {
      if (!['png', 'jpeg', 'webp'].includes(f.format) || !f.bytes.length) throw new MediaError('invalid_response');
      const bytes = embed ? embedImage(f.bytes, f.format as import('./types.ts').ImageFormat, { prompt: req.prompt, parameters, metadata: result.metadata }) : f.bytes;
      manifest.files.push({ path: `${index}.${f.format}`, sha256: hash(bytes), bytes: bytes.length, format: f.format }); return bytes;
    });
    return this.locked(async () => {
      const current = await this.manifests();
      if (current.some(m => m.id === id)) throw new MediaError('unsupported_parameter');
      const json = JSON.stringify(manifest);
      let used = 0;
      for (const m of current) { used += m.files.reduce((n, f) => n + f.bytes, 0) + Buffer.byteLength(await readFile(join(this.root, m.id, 'manifest.json'), 'utf8')); }
      if (used + files.reduce((n, f) => n + f.length, 0) + Buffer.byteLength(json) > (this.options.quotaBytes ?? Infinity)) throw new MediaError('quota');
      const stage = join(this.root, `.stage-${randomUUID()}`); await mkdir(stage, { mode: 0o700 });
      try {
        for (let i = 0; i < files.length; i++) {
          const file = await open(join(stage, manifest.files[i]!.path), 'wx', 0o600);
          try { await file.writeFile(files[i]!); await file.sync(); } finally { await file.close(); }
        }
        const file = await open(join(stage, 'manifest.json'), 'wx', 0o600);
        try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
        await rename(stage, join(this.root, id)); return manifest;
      } finally { await rm(stage, { recursive: true, force: true }); }
    });
  }
  private async putVideo(id: string, req: ImageRequest, result: ImageResult, agentMetadata?: boolean): Promise<Manifest> {
    if (result.files.length !== 1) throw new MediaError('invalid_response');
    const { referenceImages, referenceVideo, mask: _mask, ...parameters } = req;
    const embed = metadataEnabled({ global: this.options.embedMetadata ?? false, agent: agentMetadata ?? this.options.embedMetadata ?? false, call: req.embedMetadata ?? agentMetadata ?? this.options.embedMetadata ?? false });
    return this.locked(async () => {
      const current = await this.manifests();
      if (current.some(m => m.id === id)) throw new MediaError('unsupported_parameter');
      let used = 0;
      for (const m of current) used += m.files.reduce((n,f) => n + f.bytes + (f.poster?.bytes ?? 0),0) + Buffer.byteLength(await readFile(join(this.root,m.id,'manifest.json')));
      const quota = this.options.quotaBytes ?? Infinity;
      const limit = Math.min(this.options.maxVideoBytes ?? 512 * 1024 * 1024, quota - used);
      const stage = join(this.root, `.stage-${randomUUID()}`); await mkdir(stage,{mode:0o700});
      try {
        const source = join(stage,'download'); const file = await open(source,'wx',0o600);
        let length = 0; let prefix = Buffer.alloc(0);
        try {
          const chunks = result.files[0]!.stream ?? (async function*(){ yield result.files[0]!.bytes; })();
          for await (const chunk of chunks) {
            length += chunk.length; if (length > limit) throw new MediaError(length > (this.options.maxVideoBytes ?? 512 * 1024 * 1024) ? 'too_large' : 'quota');
            if (prefix.length < 4096) prefix = Buffer.concat([prefix,Buffer.from(chunk.subarray(0,4096-prefix.length))]);
            // FileHandle.writeFile consumes every byte; no short-write loss.
            await file.writeFile(chunk);
          }
          await file.sync();
        } finally { await file.close(); }
        const actual = videoFormat(prefix);
        const format = req.videoFormat ?? actual; const path = `0.${format}`, posterPath = '0.poster.png';
        // Private output files exist before ffmpeg opens them, so its defaults cannot widen permissions.
        await writePrivate(join(stage,path)); await writePrivate(join(stage,posterPath));
        const info: VideoInfo = await (this.options.videoProcessor ?? processVideo)(source,join(stage,path),join(stage,posterPath),{format,...(result.processingSignal ? {signal:result.processingSignal} : {}),...(embed ? {prompt:JSON.stringify({prompt:req.prompt,parameters,metadata:result.metadata})} : {})});
        const describe = async (name: string) => {
          const digest = createHash('sha256'); let bytes = 0;
          for await (const chunk of createReadStream(join(stage,name))) { bytes += chunk.length; digest.update(chunk); if (bytes > (this.options.maxVideoBytes ?? 512*1024*1024)) throw new MediaError('too_large'); }
          const handle = await open(join(stage,name),'r'); try { await handle.sync(); } finally { await handle.close(); }
          return {path:name,bytes,sha256:digest.digest('hex')};
        };
        const stored = await describe(path), poster = await describe(posterPath);
        const manifest: Manifest = {schema:'media.output/1',kind:'video',id,createdAt:Date.now(),prompt:req.prompt,parameters,referenceHashes:[...(referenceImages ?? []).map(i=>hash(i.bytes)),...(referenceVideo ? [hash(referenceVideo.bytes)] : [])],metadata:{...result.metadata,seed:result.metadata.seed ?? null,costUsd:result.metadata.costUsd ?? null,costStatus:result.metadata.costUsd === undefined ? 'unknown' : 'known',origin:result.metadata.origin ?? 'unknown'},partial:result.partial ?? false,files:[{...stored,format,...info,poster}]};
        const json = JSON.stringify(manifest);
        if (used + stored.bytes + poster.bytes + Buffer.byteLength(json) > quota) throw new MediaError('quota');
        await rm(source); const handle = await open(join(stage,'manifest.json'),'wx',0o600);
        try { await handle.writeFile(json); await handle.sync(); } finally { await handle.close(); }
        result.processingSignal?.throwIfAborted(); await rename(stage,join(this.root,id)); return manifest;
      } finally { await rm(stage,{recursive:true,force:true}); }
    });
  }

}

async function writePrivate(path: string): Promise<void> { const file = await open(path,'wx',0o600); await file.close(); }
