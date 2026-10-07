import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { MediaError, validateRequest, failure } from './types.ts';
import type { ImageAdapter, ImageRequest, ImageResult, GenerationContext } from './types.ts';
export interface CoreMLConfig { id: 'coreml-local'; model: string; helperPath: string; helperArgs?: string[]; modelDir?: string; timeoutMs?: number }
/** Native protocol source: apple/ml-stable-diffusion (MIT), checked 2026-10-07. No MochiDiffusion code is used. */
export class CoreMLAdapter implements ImageAdapter {
  readonly id = 'coreml-local'; readonly model: string; readonly config: CoreMLConfig;
  constructor(config: CoreMLConfig) { this.model = config.model; this.config = config; if (!config.helperPath || !config.model || !Number.isFinite(config.timeoutMs ?? 300000) || (config.timeoutMs ?? 300000) <= 0) throw new MediaError('unsupported_parameter'); }
  capabilities() { return { generate: true, edit: false, inpaint: false }; }
  edit(_req: ImageRequest, _context?: GenerationContext): Promise<ImageResult> { return Promise.reject(new MediaError('unsupported_parameter')); }
  private async invoke(operation: string, request: ImageRequest | undefined, context: GenerationContext, outputDir: string): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 300000); const signal = context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
    try {
      signal.throwIfAborted();
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        // Intentionally no inherited environment: provider keys never enter the helper process.
        const child = spawn(this.config.helperPath, this.config.helperArgs ?? [], { stdio: ['pipe', 'pipe', 'ignore'], env: {}, windowsHide: true });
        let result: Record<string, unknown> | undefined; let invalid = false; let total = 0; let killTimer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref(); };
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (data: Buffer) => { total += data.length; if (total > 1024 * 1024) { invalid = true; abort(); } });
        const lines = createInterface({ input: child.stdout });
        let callbacks = Promise.resolve();
        lines.on('line', line => {
          if (total > 1024 * 1024) { invalid = true; abort(); return; }
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            if (message.type === 'progress') {
              if (typeof message.fraction !== 'number' || message.fraction < 0 || message.fraction > 1) throw new MediaError('invalid_response');
              callbacks = callbacks.then(async () => { await context.onProgress?.({ fraction: message.fraction as number, stage: 'running' }); });
              callbacks.catch(() => { invalid = true; abort(); });
            } else if (message.type === 'result' || message.type === 'models' || message.type === 'error') { if (result) throw new MediaError('invalid_response'); result = message; }
            else throw new MediaError('invalid_response');
          } catch { invalid = true; abort(); }
        });
        child.on('error', () => { signal.removeEventListener('abort', abort); if (killTimer) clearTimeout(killTimer); reject(new MediaError('backend_unavailable')); });
        child.on('close', code => {
          signal.removeEventListener('abort', abort); if (killTimer) clearTimeout(killTimer); lines.close();
          void callbacks.then(() => {
            if (signal.aborted) { reject(new MediaError(context.signal?.aborted ? 'cancelled' : 'timeout')); return; }
            if (invalid) { reject(new MediaError('invalid_response')); return; }
            if (result?.type === 'error') { reject(new MediaError(result.code === 'content_policy' ? 'content_policy' : 'backend_unavailable')); return; }
            if (code !== 0 || !result) { reject(new MediaError('backend_unavailable')); return; }
            resolve(result);
          }, () => reject(new MediaError('invalid_response')));
        });
        child.stdin.on('error', () => { /* close/error determines outcome */ });
        child.stdin.end(JSON.stringify({ operation, model: this.model, modelDir: this.config.modelDir ?? join(homedir(), 'MochiDiffusion', 'models'), outputDir, request }) + '\n');
      });
    } catch (e) { throw failure(e, context.signal); }
  }
  async listModels(context: GenerationContext = {}): Promise<string[]> {
    const result = await this.invoke('list', undefined, context, '');
    if (!Array.isArray(result.models) || !result.models.every(m => typeof m === 'string')) throw new MediaError('invalid_response');
    return result.models as string[];
  }
  async generate(req: ImageRequest, context: GenerationContext = {}): Promise<ImageResult> {
    validateRequest(req);
    if (req.seed !== undefined && (!Number.isInteger(req.seed) || req.seed < 0 || req.seed > 0xffffffff)) throw new MediaError('unsupported_parameter');
    if (req.referenceImages?.length || req.mask || req.aspect || req.size || (req.format && req.format !== 'png')) throw new MediaError('unsupported_parameter');
    const output = await mkdtemp(join(tmpdir(), 'plur1bus-media-')); const start = Date.now();
    try {
      const result = await this.invoke('generate', req, context, output);
      if (!Array.isArray(result.files) || !result.files.length || result.files.length > 10) throw new MediaError('invalid_response');
      const files = [];
      for (const path of result.files) {
        if (typeof path !== 'string' || !/^[0-9]+\.png$/.test(path)) throw new MediaError('invalid_response');
        const file = join(output, path); const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new MediaError('too_large');
        files.push({ bytes: await readFile(file), format: 'png' as const });
      }
      return { files, metadata: { adapter: this.id, model: this.model, durationMs: Date.now() - start, costUsd: 0, origin: 'local', ...(typeof result.seed === 'number' ? { seed: result.seed } : {}) }, partial: files.length < (req.n ?? 1) };
    } catch (e) { throw failure(e, context.signal); } finally { await rm(output, { recursive: true, force: true }); }
  }
}
