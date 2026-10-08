import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { MediaError } from '../types.ts';
/**
 * Supervised JSON-Lines session with `media-coreml --jsonl` (protocol jsonl/1).
 * stdin  : {"id","op":"generate|img2img|list-models",...} and {"op":"cancel","target":"<id>"}
 * stdout : {"id","type":"progress|result|models|error",...}, one JSON object per line.
 * One request runs at a time. A helper that dies fails the in-flight request only and is restarted by the next one.
 * The child gets an empty environment, so no provider key can reach it.
 */
export interface SessionTarget { command: string; args: string[]; graceMs: number }
export interface Aborts { caller: AbortSignal; timeout: AbortSignal }
type Message = Record<string, unknown>;
interface Pending { resolve(m: Message): void; reject(e: MediaError): void; progress(fraction: number): void }
const LINE_LIMIT = 1024 * 1024;
const OPS = ['generate', 'img2img', 'list-models', 'cancel'];
export function mapHelperError(code: unknown): MediaError {
  if (code === 'content_policy') return new MediaError('content_policy');
  if (code === 'cancelled') return new MediaError('cancelled');
  if (code === 'invalid_request' || code === 'model_not_found') return new MediaError('unsupported_parameter');
  return new MediaError('backend_unavailable');
}
/** True when the binary announces the jsonl/1 protocol with every operation this adapter needs. */
export function probeJsonl(command: string, args: string[], timeoutMs = 5000): Promise<boolean> {
  return new Promise(resolve => {
    let out = ''; let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); resolve(ok); };
    const child = spawn(command, [...args, '--capabilities'], { stdio: ['ignore', 'pipe', 'ignore'], env: {}, windowsHide: true });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(false); }, timeoutMs); timer.unref();
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); if (out.length > 65536) { child.kill('SIGKILL'); finish(false); } });
    child.on('error', () => finish(false));
    child.on('close', code => {
      if (code !== 0) return finish(false);
      try { const caps = JSON.parse(out) as { protocol?: unknown; ops?: unknown }; finish(caps.protocol === 'jsonl/1' && Array.isArray(caps.ops) && OPS.every(op => (caps.ops as unknown[]).includes(op))); } catch { finish(false); }
    });
  });
}
export class CoreMLSession {
  private child: ChildProcess | undefined; private readonly pending = new Map<string, Pending>(); private seq = 0; private tail: Promise<unknown> = Promise.resolve();
  private readonly target: SessionTarget;
  constructor(target: SessionTarget) { this.target = target; }
  /** Serialised: requests queue behind each other. */
  request(op: Message, aborts: Aborts, onProgress?: (fraction: number) => void | Promise<void>): Promise<Message> {
    const run = this.tail.then(() => this.exec(op, aborts, onProgress), () => this.exec(op, aborts, onProgress));
    this.tail = run.catch(() => undefined); return run;
  }
  private abortError(aborts: Aborts): MediaError { return new MediaError(aborts.caller.aborted ? 'cancelled' : 'timeout'); }
  private exec(op: Message, aborts: Aborts, onProgress?: (fraction: number) => void | Promise<void>): Promise<Message> {
    const combined = AbortSignal.any([aborts.caller, aborts.timeout]);
    if (combined.aborted) return Promise.reject(this.abortError(aborts));
    const id = String(++this.seq); const child = this.ensureChild();
    return new Promise<Message>((resolve, reject) => {
      let settled = false; let grace: ReturnType<typeof setTimeout> | undefined; let chain: Promise<void> = Promise.resolve(); let callbackError: MediaError | undefined;
      const finish = (fn: () => void) => { if (settled) return; settled = true; if (grace) clearTimeout(grace); combined.removeEventListener('abort', onAbort); this.pending.delete(id); fn(); };
      const onAbort = () => {
        this.write(child, { op: 'cancel', target: id });
        grace = setTimeout(() => { finish(() => reject(this.abortError(aborts))); this.kill(child); }, this.target.graceMs); grace.unref();
      };
      this.pending.set(id, {
        progress: fraction => { chain = chain.then(async () => { if (!callbackError) { try { await onProgress?.(fraction); } catch (e) { callbackError = e instanceof MediaError ? e : new MediaError('invalid_response'); } } }); },
        resolve: m => { void chain.then(() => finish(() => (callbackError ? reject(callbackError) : resolve(m)))); },
        reject: e => { void chain.then(() => finish(() => reject(combined.aborted && e.code !== 'content_policy' ? this.abortError(aborts) : e))); },
      });
      combined.addEventListener('abort', onAbort, { once: true });
      this.write(child, { id, ...op });
    });
  }
  private write(child: ChildProcess, message: Message): void { if (child.stdin?.writable) child.stdin.write(JSON.stringify(message) + '\n'); }
  private ensureChild(): ChildProcess {
    if (this.child) return this.child;
    const child = spawn(this.target.command, [...this.target.args, '--jsonl'], { stdio: ['pipe', 'pipe', 'ignore'], env: {}, windowsHide: true });
    this.child = child; let sinceNewline = 0;
    child.stdout.on('data', (chunk: Buffer) => { const at = chunk.lastIndexOf(10); sinceNewline = at < 0 ? sinceNewline + chunk.length : chunk.length - at - 1; if (sinceNewline > LINE_LIMIT && this.child === child) this.fail(child, new MediaError('invalid_response')); });
    createInterface({ input: child.stdout }).on('line', line => { if (this.child === child) this.onLine(child, line); });
    const gone = () => { if (this.child !== child) return; this.child = undefined; this.rejectAll(new MediaError('backend_unavailable')); };
    child.on('error', gone); child.on('close', gone); child.stdin.on('error', () => { /* exit/close decides the outcome */ });
    return child;
  }
  private onLine(child: ChildProcess, line: string): void {
    let m: Message;
    try { m = JSON.parse(line) as Message; } catch { return this.fail(child, new MediaError('invalid_response')); }
    const pending = typeof m?.id === 'string' ? this.pending.get(m.id) : undefined;
    if (!pending) return this.fail(child, new MediaError('invalid_response'));
    if (m.type === 'progress') { if (typeof m.fraction !== 'number' || !(m.fraction >= 0 && m.fraction <= 1)) return this.fail(child, new MediaError('invalid_response')); pending.progress(m.fraction); }
    else if (m.type === 'result' || m.type === 'models') pending.resolve(m);
    else if (m.type === 'error') pending.reject(mapHelperError(m.code));
    else this.fail(child, new MediaError('invalid_response'));
  }
  private rejectAll(error: MediaError): void { for (const p of [...this.pending.values()]) p.reject(error); }
  private fail(child: ChildProcess, error: MediaError): void { this.rejectAll(error); this.kill(child); }
  private kill(child: ChildProcess): void {
    if (this.child === child) this.child = undefined;
    child.kill('SIGTERM'); const t = setTimeout(() => child.kill('SIGKILL'), 1000); t.unref(); child.once('close', () => clearTimeout(t));
  }
  /** Stops the helper; in-flight requests fail as cancelled. Safe to call repeatedly. */
  async close(): Promise<void> {
    const child = this.child; if (!child) return;
    const closed = new Promise<void>(r => child.once('close', () => r()));
    this.rejectAll(new MediaError('cancelled')); this.kill(child); await closed;
  }
}
