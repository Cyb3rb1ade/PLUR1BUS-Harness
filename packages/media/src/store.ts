/** Private atomic generated outputs and raw uploads, with separate manifests and shared quota/retention. */
import { createReadStream } from 'node:fs';
import { processVideo, videoFormat, type VideoProcessor, type VideoInfo } from './video.ts';
import { mkdir, readdir, readFile, rename, rm, open, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safeId } from './files.ts';
import { embedImage } from './adapters/_shared/metadata.ts';
import { assertDimensions, sniffFormat } from './adapters/_shared/images.ts';
import { MediaError, failure, metadataEnabled, validateRequest } from './types.ts';
import type { ImageRequest, ImageResult } from './types.ts';
export interface Manifest {
  schema: 'media.output/1'; id: string; createdAt: number; prompt: string; kind?: 'image' | 'video'; parameters: Omit<ImageRequest, 'referenceImages' | 'mask' | 'referenceVideo'>;
  referenceHashes: string[]; maskHash?: string; metadata: Omit<ImageResult['metadata'], 'seed'> & { seed: number | null; origin: string }; partial: boolean;
  files: { path: string; sha256: string; bytes: number; format: string; durationSeconds?: number; width?: number; height?: number; fps?: number; audio?: boolean; poster?: { path: string; sha256: string; bytes: number } }[];
}
/** Raw, unchanged channel media; identity and authorization are owned by the authenticated host (MM-3a). */
export interface UploadedManifest {
  schema: 'media.upload/1'; id: string; createdAt: number; kind: 'image' | 'audio' | 'video'; mimeType: string;
  filename?: string; file: { path: string; sha256: string; bytes: number; format: string };
}
/** A published upload and its trusted absolute file path; remote filenames are display metadata only. */
export interface UploadedMedia { manifest: UploadedManifest; file: string }
/** Untrusted bytes and an optional display name; provenance and owners must be supplied by the host separately. */
export interface UploadRequest {
  kind: UploadedManifest['kind']; mimeType: string; data: Uint8Array; filename?: string;
}
/** Additive observer hooks: upload publication is explicitly owned by the host, after it publishes the owner binding. */
export interface OutputStoreListener {
  onPut?(manifest: Manifest): void; onDelete?(id: string): void; onDeleteUploaded?(id: string): void;
}
/** Default bound for waiting on a lock held by another put/delete/prune. */
const LOCK_WAIT_MS = 5_000;
// MM-3a keeps channel uploads bounded independently of generation/video processing settings.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_MANIFEST_BYTES = 4096;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class OutputStore {
  readonly root: string; readonly options: { quotaBytes?: number; retentionMs?: number; embedMetadata?: boolean; maxVideoBytes?: number; videoProcessor?: VideoProcessor; lockWaitMs?: number };
  readonly #listeners = new Set<OutputStoreListener>();
  /** Observe puts and deletes (e.g. media indexing); returns the unsubscribe function. */
  addListener(listener: OutputStoreListener): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #notify(call: (l: OutputStoreListener) => void): void { for (const l of this.#listeners) { try { call(l); } catch { /* observers must not fail the store */ } } }
  constructor(root: string, options: OutputStore['options'] = {}) {
    this.root = root; this.options = options;
    if ([options.quotaBytes, options.retentionMs, options.maxVideoBytes, options.lockWaitMs].some(v => v !== undefined && (!Number.isFinite(v) || v < 0))) throw new MediaError('unsupported_parameter');
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, '.lock');
    // A held lock is waited for with capped exponential backoff; a lock that outlives the bound is a clear backend_unavailable.
    const deadline = Date.now() + (this.options.lockWaitMs ?? LOCK_WAIT_MS); let delay = 5;
    for (;;) {
      try { await mkdir(lock); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw new MediaError('backend_unavailable');
        await new Promise(r => setTimeout(r, Math.min(delay, Math.max(1, deadline - Date.now()))));
        delay = Math.min(delay * 2, 100);
      }
    }
    // Only stable codes leave the store: raw fs/parse/stream errors carry paths, URLs and fragments of remote or stored text.
    try { return await fn(); } catch (e) { throw e instanceof MediaError ? e : failure(e); } finally { await rm(lock, { recursive: true, force: true }); }
  }
  private async manifests(): Promise<Manifest[]> {
    const entries = await readdir(this.root, { withFileTypes: true }); const out: Manifest[] = [];
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) out.push(JSON.parse(await readFile(join(this.root, e.name, 'manifest.json'), 'utf8')) as Manifest);
    return out;
  }
  private async uploadRoot(create = false): Promise<string | null> {
    const root = join(this.root, '.uploads');
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      if (!(await lstat(root)).isDirectory()) throw new MediaError('backend_unavailable');
      return root;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  private async uploadedManifests(): Promise<UploadedManifest[]> {
    const root = await this.uploadRoot();
    if (!root) return [];
    const out: UploadedManifest[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) out.push(await this.readUploadedManifest(entry.name, root));
    }
    return out;
  }
  private async readUploadedManifest(id: string, root: string): Promise<UploadedManifest> {
    const directory = join(root, safeId(id)), path = join(directory, 'manifest.json');
    if (!(await lstat(directory)).isDirectory()) throw new MediaError('backend_unavailable');
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_UPLOAD_MANIFEST_BYTES) throw new MediaError('backend_unavailable');
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!validUploadedManifest(raw, id)) throw new MediaError('backend_unavailable');
    return raw;
  }
  private async usedBytes(current: Manifest[]): Promise<number> {
    let used = 0;
    for (const m of current) used += m.files.reduce((n, f) => n + f.bytes + (f.poster?.bytes ?? 0), 0)
      + (await lstat(join(this.root, m.id, 'manifest.json'))).size;
    for (const m of await this.uploadedManifests()) {
      const file = await lstat(join(this.root, '.uploads', m.id, m.file.path));
      if (!file.isFile() || file.size !== m.file.bytes) throw new MediaError('backend_unavailable');
      used += file.size + (await lstat(join(this.root, '.uploads', m.id, 'manifest.json'))).size;
    }
    return used;
  }
  /** Publishes at most 25 MiB of matching supported media, atomically and privately, without transforming any bytes. */
  async putUploaded(request: UploadRequest): Promise<UploadedMedia> {
    if (!(request.data instanceof Uint8Array) || !request.data.byteLength) throw new MediaError('unsupported_parameter');
    if (request.data.byteLength > MAX_UPLOAD_BYTES) throw new MediaError('too_large');
    // Copy before awaiting the lock: a caller must not mutate the validated bytes while publication waits.
    const data = Buffer.from(request.data), format = uploadFormat(request.kind, request.mimeType, data);
    const filename = displayFilename(request.filename);
    const manifest: UploadedManifest = { schema: 'media.upload/1', id: randomUUID(), createdAt: Date.now(),
      kind: request.kind, mimeType: request.mimeType, ...(filename ? { filename } : {}),
      file: { path: `0.${format}`, sha256: hash(data), bytes: data.length, format } };
    return this.locked(async () => {
      const used = await this.usedBytes(await this.manifests()), json = JSON.stringify(manifest);
      if (used + data.length + Buffer.byteLength(json) > (this.options.quotaBytes ?? Infinity)) throw new MediaError('quota');
      const root = (await this.uploadRoot(true))!, stage = join(this.root, `.stage-${randomUUID()}`);
      await mkdir(stage, { mode: 0o700 });
      try {
        const file = await open(join(stage, manifest.file.path), 'wx', 0o600);
        try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
        const metadata = await open(join(stage, 'manifest.json'), 'wx', 0o600);
        try { await metadata.writeFile(json); await metadata.sync(); } finally { await metadata.close(); }
        await rename(stage, join(root, manifest.id));
        return { manifest, file: resolve(root, manifest.id, manifest.file.path) };
      } finally { await rm(stage, { recursive: true, force: true }); }
    });
  }
  /** Reads only the upload namespace and verifies its bounded manifest, private file identity, size and SHA-256. */
  async getUploaded(id: string): Promise<UploadedMedia | null> {
    safeId(id);
    try {
      const root = await this.uploadRoot();
      if (!root) return null;
      try { await lstat(join(root, id)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
      const manifest = await this.readUploadedManifest(id, root), file = resolve(root, id, manifest.file.path);
      const info = await lstat(file);
      if (!info.isFile() || info.size !== manifest.file.bytes || hash(await readFile(file)) !== manifest.file.sha256)
        throw new MediaError('backend_unavailable');
      return { manifest, file };
    } catch (e) { throw failure(e); }
  }
  /** Deletes one upload without touching generated outputs; the host observes the distinct upload deletion hook. */
  async deleteUploaded(id: string): Promise<void> {
    safeId(id);
    await this.locked(async () => {
      const root = await this.uploadRoot();
      if (root) await rm(join(root, id), { recursive: true, force: true });
    });
    this.#notify(l => l.onDeleteUploaded?.(id));
  }
  async delete(id: string): Promise<void> {
    safeId(id);
    await this.locked(async () => { await rm(join(this.root, id), { recursive: true, force: true }); });
    this.#notify(l => l.onDelete?.(id));
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
      for (const m of await this.manifests()) if (now - m.createdAt >= (this.options.retentionMs ?? Infinity)) { await rm(join(this.root, safeId(m.id)), { recursive: true }); removed++; this.#notify(l => l.onDelete?.(m.id)); }
      for (const m of await this.uploadedManifests()) if (now - m.createdAt >= (this.options.retentionMs ?? Infinity)) { await rm(join(this.root, '.uploads', safeId(m.id)), { recursive: true }); removed++; this.#notify(l => l.onDeleteUploaded?.(m.id)); }
      return removed;
    });
  }
  async put(id: string, req: ImageRequest, result: ImageResult, agentMetadata?: boolean): Promise<Manifest> {
    safeId(id); validateRequest(req);
    if (req.kind === 'video') return this.putVideo(id, req, result, agentMetadata);
    if (!result.files.length) throw new MediaError('invalid_response');
    const { referenceImages, mask, ...parameters } = req;
    const manifest: Manifest = { schema: 'media.output/1', id, createdAt: Date.now(), prompt: req.prompt, parameters, referenceHashes: (referenceImages ?? []).map(i => hash(i.bytes)), ...(mask ? { maskHash: hash(mask.bytes) } : {}), metadata: { ...result.metadata, seed: result.metadata.seed ?? null, origin: result.metadata.origin ?? 'unknown' }, partial: result.partial ?? false, files: [] };
    const embed = metadataEnabled({ ...(this.options.embedMetadata === undefined ? {} : { global: this.options.embedMetadata }), ...(agentMetadata === undefined ? {} : { agent: agentMetadata }), ...(req.embedMetadata === undefined ? {} : { call: req.embedMetadata }) });
    const files = result.files.map((f, index) => {
      if (!['png', 'jpeg', 'webp'].includes(f.format) || !f.bytes.length) throw new MediaError('invalid_response');
      if (!embed && sniffFormat(f.bytes) !== f.format) throw new MediaError('invalid_response');
      const bytes = embed ? embedImage(f.bytes, f.format as import('./types.ts').ImageFormat, { prompt: req.prompt, parameters, metadata: result.metadata }) : f.bytes;
      manifest.files.push({ path: `${index}.${f.format}`, sha256: hash(bytes), bytes: bytes.length, format: f.format }); return bytes;
    });
    const published = await this.locked(async () => {
      const current = await this.manifests();
      if (current.some(m => m.id === id)) throw new MediaError('unsupported_parameter');
      const json = JSON.stringify(manifest);
      const used = await this.usedBytes(current);
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
    this.#notify(l => l.onPut?.(published));
    return published;
  }
  private async putVideo(id: string, req: ImageRequest, result: ImageResult, agentMetadata?: boolean): Promise<Manifest> {
    if (result.files.length !== 1) throw new MediaError('invalid_response');
    const { referenceImages, referenceVideo, mask: _mask, ...parameters } = req;
    const embed = metadataEnabled({ global: this.options.embedMetadata ?? false, agent: agentMetadata ?? this.options.embedMetadata ?? false, call: req.embedMetadata ?? agentMetadata ?? this.options.embedMetadata ?? false });
    const published = await this.locked(async () => {
      const current = await this.manifests();
      if (current.some(m => m.id === id)) throw new MediaError('unsupported_parameter');
      const used = await this.usedBytes(current);
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
          // 'r+', not 'r': FlushFileBuffers needs write access, so fsync on a read-only handle fails with EPERM on Windows.
          const handle = await open(join(stage,name),'r+'); try { await handle.sync(); } finally { await handle.close(); }
          return {path:name,bytes,sha256:digest.digest('hex')};
        };
        const stored = await describe(path), poster = await describe(posterPath);
        const manifest: Manifest = {schema:'media.output/1',kind:'video',id,createdAt:Date.now(),prompt:req.prompt,parameters,referenceHashes:[...(referenceImages ?? []).map(i=>hash(i.bytes)),...(referenceVideo ? [hash(referenceVideo.bytes)] : [])],metadata:{...result.metadata,seed:result.metadata.seed ?? null,origin:result.metadata.origin ?? 'unknown'},partial:result.partial ?? false,files:[{...stored,format,...info,poster}]};
        const json = JSON.stringify(manifest);
        if (used + stored.bytes + poster.bytes + Buffer.byteLength(json) > quota) throw new MediaError('quota');
        await rm(source); const handle = await open(join(stage,'manifest.json'),'wx',0o600);
        try { await handle.writeFile(json); await handle.sync(); } finally { await handle.close(); }
        result.processingSignal?.throwIfAborted(); await rename(stage,join(this.root,id)); return manifest;
      } catch (e) { throw failure(e, result.processingSignal?.aborted ? result.processingSignal : undefined); }
      finally { await rm(stage,{recursive:true,force:true}); }
    });
    this.#notify(l => l.onPut?.(published));
    return published;
  }

}

async function writePrivate(path: string): Promise<void> { const file = await open(path,'wx',0o600); await file.close(); }

const UPLOAD_TYPES: Record<string, readonly [UploadedManifest['kind'], string]> = {
  'image/png': ['image', 'png'], 'image/jpeg': ['image', 'jpeg'], 'image/webp': ['image', 'webp'],
  'image/gif': ['image', 'gif'], 'audio/wav': ['audio', 'wav'], 'audio/x-wav': ['audio', 'wav'],
  'audio/mpeg': ['audio', 'mp3'], 'audio/mp3': ['audio', 'mp3'], 'audio/ogg': ['audio', 'ogg'],
  'audio/flac': ['audio', 'flac'], 'audio/aac': ['audio', 'aac'], 'audio/mp4': ['audio', 'm4a'],
  'audio/x-m4a': ['audio', 'm4a'], 'audio/webm': ['audio', 'webm'], 'video/mp4': ['video', 'mp4'],
  'video/quicktime': ['video', 'mov'], 'video/webm': ['video', 'webm'], 'video/ogg': ['video', 'ogv'],
};
function displayFilename(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new MediaError('unsupported_parameter');
  return value.slice(0, 160).replace(/[/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '_').trim();
}
function uploadFormat(kind: UploadRequest['kind'], mimeType: string, bytes: Buffer): string {
  const type = Object.hasOwn(UPLOAD_TYPES, mimeType) ? UPLOAD_TYPES[mimeType] : undefined;
  if (!type || type[0] !== kind || !matchesUploadMagic(type[1], bytes)) throw new MediaError('unsupported_parameter');
  if (type[1] === 'png' || type[1] === 'jpeg' || type[1] === 'webp') assertDimensions(bytes, type[1]);
  return type[1];
}
// These are container/header checks, never decoders: ingress neither generates nor transcodes user media (MM-3a).
function matchesUploadMagic(format: string, bytes: Buffer): boolean {
  if (['png', 'jpeg', 'webp'].includes(format)) return sniffFormat(bytes) === format;
  if (format === 'gif') return bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  if (format === 'wav') return bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.readUInt32LE(4) + 8 <= bytes.length;
  if (format === 'flac') return bytes.length >= 42 && bytes.toString('ascii', 0, 4) === 'fLaC';
  if (format === 'aac') return bytes.length >= 7 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0;
  if (format === 'mp3') {
    let offset = 0;
    if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'ID3') {
      if (bytes.subarray(6, 10).some(b => b > 127)) return false;
      offset = 10 + bytes.subarray(6, 10).reduce((n, b) => n * 128 + b, 0);
    }
    return bytes.length >= offset + 4 && bytes[offset] === 0xff && (bytes[offset + 1]! & 0xe0) === 0xe0
      && (bytes[offset + 1]! & 6) !== 0 && (bytes[offset + 2]! & 0xf0) !== 0
      && (bytes[offset + 2]! & 0xf0) !== 0xf0 && (bytes[offset + 2]! & 0x0c) !== 0x0c;
  }
  if (format === 'ogg' || format === 'ogv') {
    if (bytes.length < 28 || bytes.toString('ascii', 0, 4) !== 'OggS' || bytes[4] !== 0) return false;
    const start = 27 + bytes[26]!, packet = bytes.subarray(start, start + 8).toString('latin1');
    return format === 'ogv' ? packet.startsWith('\x80theora')
      : packet.startsWith('OpusHead') || packet.startsWith('\x01vorbis') || packet.startsWith('\x7fFLAC');
  }
  if (format === 'webm') return bytes.length >= 12 && bytes.readUInt32BE(0) === 0x1a45dfa3
    && bytes.subarray(4, 4096).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
  if (bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp'
    || bytes.readUInt32BE(0) < 16 || bytes.readUInt32BE(0) > bytes.length) return false;
  const brand = bytes.toString('ascii', 8, 12);
  if (format === 'mov') return brand === 'qt  ';
  if (format === 'm4a') return ['M4A ', 'M4B ', 'M4P '].includes(brand);
  return ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'].includes(brand);
}
function validUploadedManifest(value: unknown, id: string): value is UploadedManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>, file = m.file;
  if (!file || typeof file !== 'object') return false;
  const f = file as Record<string, unknown>;
  const type = typeof m.mimeType === 'string' && Object.hasOwn(UPLOAD_TYPES, m.mimeType)
    ? UPLOAD_TYPES[m.mimeType] : undefined;
  return m.schema === 'media.upload/1' && m.id === id && typeof m.createdAt === 'number'
    && Number.isFinite(m.createdAt) && m.createdAt >= 0 && !!type && type[0] === m.kind && type[1] === f.format
    && f.path === `0.${type[1]}` && typeof f.bytes === 'number' && Number.isInteger(f.bytes)
    && f.bytes > 0 && f.bytes <= MAX_UPLOAD_BYTES && typeof f.sha256 === 'string' && /^[a-f0-9]{64}$/.test(f.sha256)
    && (m.filename === undefined || (typeof m.filename === 'string' && displayFilename(m.filename) === m.filename));
}
