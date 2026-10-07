import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, safeId } from './files.ts';
import { MediaError, failure, validateRequest } from './types.ts';
import type { ImageAdapter, ImageRequest, ResumeToken, Progress } from './types.ts';
import { estimateCost } from './cost.ts';
import type { BudgetPort } from './cost.ts';
import type { OutputStore, Manifest } from './store.ts';
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface Job { id: string; adapter: string; operation: 'generate' | 'edit'; request: ImageRequest; state: JobState; progress: Progress; createdAt: number; updatedAt: number; checkpoint?: ResumeToken; output?: Manifest; error?: MediaError['code'] }
export interface JobPersistence { put(job: Job): Promise<void>; get(id: string): Promise<Job | null>; list(): Promise<Job[]>; claim(id: string): Promise<() => Promise<void>> }
/** Single writer per job, across processes. Stale claims require explicit recovery after confirming the previous runner exited. */
export class FileJobPersistence implements JobPersistence {
  readonly root: string;
  constructor(root: string) { this.root = root; }
  async put(job: Job): Promise<void> { await atomicJson(join(this.root, `${safeId(job.id)}.json`), job); }
  async get(id: string): Promise<Job | null> {
    try {
      const job = JSON.parse(await readFile(join(this.root, `${safeId(id)}.json`), 'utf8')) as Job;
      const restore = (bytes: unknown): Uint8Array => Buffer.from((bytes as { type?: string; data?: number[] }).type === 'Buffer' ? (bytes as { data: number[] }).data : Object.values(bytes as Record<string, number>));
      for (const image of job.request.referenceImages ?? []) image.bytes = restore(image.bytes);
      if (job.request.mask) job.request.mask.bytes = restore(job.request.mask.bytes);
      return job;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  async list(): Promise<Job[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); const jobs: Job[] = [];
    for (const name of await readdir(this.root)) if (name.endsWith('.json')) { const job = await this.get(name.slice(0, -5)); if (job) jobs.push(job); }
    return jobs;
  }
  async claim(id: string): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); const path = join(this.root, `${safeId(id)}.claim`);
    try { await mkdir(path); } catch { throw new MediaError('backend_unavailable'); }
    return () => rm(path, { recursive: true, force: true });
  }
  /** Call only after the host has established exclusive ownership; never steals a live runner's claim. */
  async recoverClaims(): Promise<void> { for (const name of await readdir(this.root)) if (/^[a-zA-Z0-9_-]+\.claim$/.test(name)) await rm(join(this.root, name), { recursive: true }); }
}
export class JobRunner {
  readonly persistence: JobPersistence; readonly store: OutputStore; private readonly adapters: Map<string, ImageAdapter>; private readonly budget?: BudgetPort;
  private readonly controllers = new Map<string, AbortController>();
  constructor(persistence: JobPersistence, store: OutputStore, adapters: ImageAdapter[], budget?: BudgetPort) { this.persistence = persistence; this.store = store; this.adapters = new Map(adapters.map(a => [a.id, a])); if (budget) this.budget = budget; }
  async enqueue(adapter: string, request: ImageRequest, operation: Job['operation'] = 'generate'): Promise<Job> {
    validateRequest(request); if (!this.adapters.has(adapter)) throw new MediaError('backend_unavailable');
    const now = Date.now(); const job: Job = { id: randomUUID(), adapter, request, operation, state: 'queued', progress: { fraction: 0, stage: 'queued' }, createdAt: now, updatedAt: now };
    await this.persistence.put(job); return job;
  }
  async cancel(id: string): Promise<void> {
    const controller = this.controllers.get(id);
    if (controller) { controller.abort(); return; }
    const release = await this.persistence.claim(id);
    try { const job = await this.persistence.get(id); if (job && job.state === 'queued') { job.state = 'cancelled'; job.updatedAt = Date.now(); await this.persistence.put(job); } } finally { await release(); }
  }
  async run(id: string, signal?: AbortSignal): Promise<void> {
    const release = await this.persistence.claim(id);
    try {
      const job = await this.persistence.get(id);
      if (!job || !['queued', 'running'].includes(job.state)) throw new MediaError('unsupported_parameter');
      const adapter = this.adapters.get(job.adapter); if (!adapter) throw new MediaError('backend_unavailable');
      const resuming = job.state === 'running';
      const existing = await this.store.get(id);
      if (existing) {
        await this.budget?.settle(id, existing.metadata.costUsd ?? null); job.output = existing; job.state = 'succeeded'; job.progress = { fraction: 1 }; job.updatedAt = Date.now(); await this.persistence.put(job); return;
      }
      const controller = new AbortController(); this.controllers.set(id, controller);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let reserved = false;
      const save = async () => { job.updatedAt = Date.now(); await this.persistence.put(job); };
      try {
        combined.throwIfAborted();
        if (resuming && (!job.checkpoint || !adapter.resume)) throw new MediaError('interrupted');
        await this.budget?.reserve(id, estimateCost(job.request, adapter)); reserved = true;
        job.state = 'running'; await save();
        const context = { signal: combined, onCheckpoint: async (token: ResumeToken) => { job.checkpoint = token; await save(); }, onProgress: async (p: Progress) => { if (!Number.isFinite(p.fraction) || p.fraction < 0 || p.fraction > 1) throw new MediaError('invalid_response'); job.progress = p; await save(); }, ...(job.checkpoint ? { resume: job.checkpoint } : {}) };
        const result = resuming ? await adapter.resume!(job.request, context) : await adapter[job.operation](job.request, context);
        combined.throwIfAborted();
        job.output = await this.store.put(id, job.request, result);
        await this.budget?.settle(id, result.metadata.costUsd ?? null); reserved = false;
        job.state = 'succeeded'; job.progress = { fraction: 1 }; await save();
      } catch (e) {
        const error = failure(e, combined); job.error = error.code; job.state = error.code === 'cancelled' ? 'cancelled' : 'failed';
        if (reserved) { try { await this.budget?.settle(id, null); } catch { /* reservation reconciliation belongs to the budget port */ } }
        await save();
      } finally { this.controllers.delete(id); }
    } finally { await release(); }
  }
  async recover(): Promise<void> { for (const job of await this.persistence.list()) if (['queued', 'running'].includes(job.state)) await this.run(job.id); }
}
