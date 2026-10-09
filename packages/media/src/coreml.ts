import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { MediaError, validateRequest, failure } from './types.ts';
import type { ImageAdapter, ImageRequest, ImageResult, GenerationContext, Capabilities } from './types.ts';
import { CoreMLSession, probeJsonl } from './adapters/coreml-jsonl.ts';
import { DetailedMediaError } from './adapters/_shared/errors.ts';
import type { ErrorReason } from './adapters/_shared/errors.ts';
import { sanitizeRequest, verifyOutput } from './adapters/_shared/images.ts';
export type ComputeUnits = 'cpuAndNeuralEngine' | 'all' | 'cpuAndGPU';
export interface CoreMLConfig {
  id: 'coreml-local'; model: string; helperPath: string; helperArgs?: string[]; modelDir?: string; timeoutMs?: number;
  /** Default: chosen by the helper from the model's attention variant (split-einsum: Neural Engine, original: GPU). */
  computeUnits?: ComputeUnits; scheduler?: string; /** img2img strength in (0, 1]; default 0.75. */ strength?: number;
  /** `auto` probes `--capabilities` once; `oneshot` pins the MG-1 protocol (no edit, no mid-run cancel). */ protocol?: 'auto' | 'oneshot' | 'jsonl';
  /** How long a helper may take to honour a cancel before it is killed. Default 2000. */ cancelGraceMs?: number;
  /** Test seam; defaults to the running process. */ platform?: { os: string; arch: string };
}
/** Native protocol source: apple/ml-stable-diffusion (MIT), checked 2026-10-07. No MochiDiffusion code is used. */
const COMPUTE_UNITS: ComputeUnits[] = ['cpuAndNeuralEngine', 'all', 'cpuAndGPU'];
export class CoreMLAdapter implements ImageAdapter {
  readonly id = 'coreml-local'; readonly model: string; readonly config: CoreMLConfig;
  private session: CoreMLSession | undefined; private mode: Promise<'jsonl' | 'oneshot'> | undefined;
  constructor(config: CoreMLConfig) {
    this.model = config.model; this.config = config;
    if (!config.helperPath || !config.model || !Number.isFinite(config.timeoutMs ?? 300000) || (config.timeoutMs ?? 300000) <= 0) throw new MediaError('unsupported_parameter');
    const bad = (config.computeUnits !== undefined && !COMPUTE_UNITS.includes(config.computeUnits)) || (config.scheduler !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(config.scheduler))
      || (config.strength !== undefined && !(config.strength > 0 && config.strength <= 1)) || (config.protocol !== undefined && !['auto', 'oneshot', 'jsonl'].includes(config.protocol))
      || (config.cancelGraceMs !== undefined && !(config.cancelGraceMs >= 0 && config.cancelGraceMs <= 60000));
    if (bad) throw new MediaError('unsupported_parameter');
  }
  capabilities(): Capabilities { return { generate: true, edit: (this.config.protocol ?? 'auto') !== 'oneshot', inpaint: false }; }
  /** Core ML needs macOS on Apple silicon; elsewhere the adapter exists but reports itself unavailable. */
  availability(): { available: true } | { available: false; reason: ErrorReason } {
    const p = this.config.platform ?? { os: process.platform, arch: process.arch };
    return p.os === 'darwin' && p.arch === 'arm64' ? { available: true } : { available: false, reason: 'coreml_unavailable_platform' };
  }
  private requireAvailable(): void {
    if (!this.availability().available) throw new DetailedMediaError('backend_unavailable', 'coreml_unavailable_platform', 'Core ML image generation needs macOS on Apple silicon.');
  }
  private protocol(): Promise<'jsonl' | 'oneshot'> {
    const wanted = this.config.protocol ?? 'auto';
    this.mode ??= wanted === 'auto' ? probeJsonl(this.config.helperPath, this.config.helperArgs ?? []).then(ok => ok ? 'jsonl' as const : 'oneshot' as const) : Promise.resolve(wanted);
    return this.mode;
  }
  private jsonl(): CoreMLSession {
    this.session ??= new CoreMLSession({ command: this.config.helperPath, args: this.config.helperArgs ?? [], graceMs: this.config.cancelGraceMs ?? 2000 });
    return this.session;
  }
  /** Stops a running JSON-Lines helper. The next request starts a fresh one. */
  async close(): Promise<void> { await this.session?.close(); }
  private async collect(result: Record<string, unknown>, output: string): Promise<{ files: { bytes: Uint8Array; format: 'png' }[] }> {
    if (!Array.isArray(result.files) || !result.files.length || result.files.length > 10) throw new MediaError('invalid_response');
    const files = [];
    for (const path of result.files) {
      if (typeof path !== 'string' || !/^[0-9]+\.png$/.test(path)) throw new MediaError('invalid_response');
      const file = join(output, path); const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new MediaError('too_large');
      const verified = verifyOutput({ bytes: await readFile(file), format: 'png' }); if (verified.format !== 'png') throw new MediaError('invalid_response');
      files.push({ bytes: verified.bytes, format: 'png' as const });
    }
    return { files };
  }
  private checked(req: ImageRequest): void {
    validateRequest(req);
    if (req.seed !== undefined && (!Number.isInteger(req.seed) || req.seed < 0 || req.seed > 0xffffffff)) throw new MediaError('unsupported_parameter');
    if (req.aspect || req.size || (req.format && req.format !== 'png')) throw new MediaError('unsupported_parameter');
  }
  async edit(input: ImageRequest, context: GenerationContext = {}): Promise<ImageResult> {
    this.checked(input); this.requireAvailable();
    if (input.referenceImages?.length !== 1 || input.mask) throw new MediaError('unsupported_parameter');
    const req = sanitizeRequest(input); // EXIF/GPS never reaches the helper
    if (await this.protocol() !== 'jsonl') throw new MediaError('unsupported_parameter');
    return this.runJsonl('img2img', req, context);
  }
  private async runJsonl(op: 'generate' | 'img2img', req: ImageRequest, context: GenerationContext): Promise<ImageResult> {
    const output = await mkdtemp(join(tmpdir(), 'plur1bus-media-')); const start = Date.now();
    try {
      const ref = req.referenceImages?.[0]; let inputPath: string | undefined;
      if (ref) { inputPath = join(output, `input.${ref.format}`); await writeFile(inputPath, ref.bytes, { mode: 0o600 }); }
      const aborts = { caller: context.signal ?? new AbortController().signal, timeout: AbortSignal.timeout(this.config.timeoutMs ?? 300000) };
      const result = await this.jsonl().request({
        op, model: this.model, modelsDir: this.config.modelDir ?? join(homedir(), 'MochiDiffusion', 'models'), outputDir: output, ...(this.config.computeUnits ? { computeUnits: this.config.computeUnits } : {}), ...(inputPath ? { inputPath } : {}),
        request: { prompt: req.prompt, ...(req.negativePrompt === undefined ? {} : { negativePrompt: req.negativePrompt }), ...(req.n === undefined ? {} : { n: req.n }), ...(req.seed === undefined ? {} : { seed: req.seed }), ...(req.steps === undefined ? {} : { steps: req.steps }), ...(req.guidance === undefined ? {} : { guidance: req.guidance }), ...(this.config.scheduler ? { scheduler: this.config.scheduler } : {}), ...(op === 'img2img' ? { strength: this.config.strength ?? 0.75 } : {}) },
      }, aborts, f => context.onProgress?.({ fraction: f, stage: 'running' }));
      const { files } = await this.collect(result, output);
      return { files, metadata: { adapter: this.id, model: this.model, durationMs: Date.now() - start, costUsd: 0, origin: 'local', ...(typeof result.seed === 'number' ? { seed: result.seed } : {}) }, partial: files.length < (req.n ?? 1) };
    } catch (e) { throw failure(e, context.signal); } finally { await rm(output, { recursive: true, force: true }); }
  }
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
    this.requireAvailable();
    if (await this.protocol() === 'jsonl') {
      const aborts = { caller: context.signal ?? new AbortController().signal, timeout: AbortSignal.timeout(this.config.timeoutMs ?? 300000) };
      try {
        const listed = await this.jsonl().request({ op: 'list-models', modelsDir: this.config.modelDir ?? join(homedir(), 'MochiDiffusion', 'models') }, aborts);
        if (!Array.isArray(listed.models) || !listed.models.every(m => typeof m === 'string')) throw new MediaError('invalid_response');
        return listed.models as string[];
      } catch (e) { throw failure(e, context.signal); }
    }
    const result = await this.invoke('list', undefined, context, '');
    if (!Array.isArray(result.models) || !result.models.every(m => typeof m === 'string')) throw new MediaError('invalid_response');
    return result.models as string[];
  }
  async generate(req: ImageRequest, context: GenerationContext = {}): Promise<ImageResult> {
    this.checked(req); this.requireAvailable();
    if (req.referenceImages?.length || req.mask) throw new MediaError('unsupported_parameter');
    if (await this.protocol() === 'jsonl') return this.runJsonl('generate', req, context);
    const output = await mkdtemp(join(tmpdir(), 'plur1bus-media-')); const start = Date.now();
    try {
      const result = await this.invoke('generate', req, context, output);
      const { files } = await this.collect(result, output);
      return { files, metadata: { adapter: this.id, model: this.model, durationMs: Date.now() - start, costUsd: 0, origin: 'local', ...(typeof result.seed === 'number' ? { seed: result.seed } : {}) }, partial: files.length < (req.n ?? 1) };
    } catch (e) { throw failure(e, context.signal); } finally { await rm(output, { recursive: true, force: true }); }
  }
}
