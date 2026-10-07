import { mkdir, readdir, readFile, rename, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safeId } from './files.ts';
import { embedPng } from './png.ts';
import { MediaError, metadataEnabled, validateRequest } from './types.ts';
import type { ImageRequest, ImageResult } from './types.ts';
export interface Manifest {
  schema: 'media.output/1'; id: string; createdAt: number; prompt: string; parameters: Omit<ImageRequest, 'referenceImages' | 'mask'>;
  referenceHashes: string[]; maskHash?: string; metadata: Omit<ImageResult['metadata'], 'seed' | 'costUsd'> & { seed: number | null; costUsd: number | null; origin: string }; partial: boolean;
  files: { path: string; sha256: string; bytes: number; format: string }[];
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class OutputStore {
  readonly root: string; readonly options: { quotaBytes?: number; retentionMs?: number; embedMetadata?: boolean };
  constructor(root: string, options: OutputStore['options'] = {}) {
    this.root = root; this.options = options;
    if ([options.quotaBytes, options.retentionMs].some(v => v !== undefined && (!Number.isFinite(v) || v < 0))) throw new MediaError('unsupported_parameter');
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
    if (!result.files.length) throw new MediaError('invalid_response');
    const { referenceImages, mask, ...parameters } = req;
    const manifest: Manifest = { schema: 'media.output/1', id, createdAt: Date.now(), prompt: req.prompt, parameters, referenceHashes: (referenceImages ?? []).map(i => hash(i.bytes)), ...(mask ? { maskHash: hash(mask.bytes) } : {}), metadata: { ...result.metadata, seed: result.metadata.seed ?? null, costUsd: result.metadata.costUsd ?? null, origin: result.metadata.origin ?? 'unknown' }, partial: result.partial ?? false, files: [] };
    const embed = metadataEnabled({ ...(this.options.embedMetadata === undefined ? {} : { global: this.options.embedMetadata }), ...(agentMetadata === undefined ? {} : { agent: agentMetadata }), ...(req.embedMetadata === undefined ? {} : { call: req.embedMetadata }) });
    const files = result.files.map((f, index) => {
      if (!['png', 'jpeg', 'webp'].includes(f.format) || !f.bytes.length) throw new MediaError('invalid_response');
      if (embed && f.format !== 'png') throw new MediaError('unsupported_parameter');
      const bytes = embed ? embedPng(f.bytes, { prompt: req.prompt, parameters, metadata: result.metadata }) : f.bytes;
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
}
