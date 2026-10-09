import { execFile } from 'node:child_process';
import { realpath, stat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { FOREIGN_CREDENTIAL_STORES, createCredentialDenyPort, credentialAccess } from './profiles.ts';
import { OpenAIError, Sensitive, object, text, bounded } from './ports.ts';
export interface FederatedSource { file?: string; command?: string; args?: string[]; environment?: Record<string, string>; timeoutMs?: number }
async function supplierFile(path: string) {
  const roots = FOREIGN_CREDENTIAL_STORES.flatMap(store => [join(homedir(), '.' + store.app), ...(process.env[store.env] ? [process.env[store.env]!] : []), ...(store.app === 'hermes' && process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'hermes')] : [])]);
  const canonical = await Promise.all(roots.map(async root => realpath(root).catch(() => resolve(root))));
  const deny = createCredentialDenyPort({ roots: canonical, keychainItems: [], canonicalize: realpath });
  return credentialAccess(deny, path, async () => {
    const name = await realpath(path), info = await stat(name); if (!info.isFile() || info.size > 65536) throw new OpenAIError('auth-required');
    const file = await open(name, 'r');
    try { const buffer = Buffer.alloc(65537); const read = await file.read(buffer, 0, buffer.length, 0); if (read.bytesRead > 65536) throw new OpenAIError('auth-required'); return buffer.subarray(0, read.bytesRead).toString('utf8'); }
    finally { await file.close(); }
  });
}
/** External suppliers are trusted configuration; execute a binary directly with an explicit environment. */
export class FederatedCredential {
  readonly #source: FederatedSource; readonly #clock: () => number; readonly #skew: number;
  #token: Sensitive | undefined; #expiry = 0; #flight: Promise<Sensitive> | undefined;
  constructor(source: FederatedSource, clock: () => number, skewMs = 120000) {
    if (!!source.file === !!source.command || !Number.isFinite(skewMs) || skewMs < 0 || Object.keys(source.environment ?? {}).some(k => !/^[A-Z_][A-Z0-9_]*$/.test(k))) throw new OpenAIError('invalid-request');
    this.#source = structuredClone(source); this.#clock = clock; this.#skew = skewMs;
  }
  async lease(): Promise<Sensitive> {
    if (this.#token && this.#expiry - this.#skew > this.#clock()) return this.#token;
    if (this.#flight) return this.#flight;
    this.#flight = (async () => {
      try {
        const source = this.#source;
        const raw = source.file ? await bounded(supplierFile(source.file), AbortSignal.timeout(source.timeoutMs ?? 10000)) : await new Promise<string>((resolve, reject) => {
          execFile(source.command!, source.args ?? [], { shell: false, env: source.environment ?? {}, timeout: source.timeoutMs ?? 10000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
        });
        if (Buffer.byteLength(raw) > 64 * 1024) throw new Error();
        const data = object(JSON.parse(raw)), expiry = data.expires_at;
        if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry * 1000 <= this.#clock() + this.#skew) throw new Error();
        this.#token = new Sensitive(text(data.access_token)); this.#expiry = expiry * 1000; return this.#token;
      } catch { this.#token = undefined; throw new OpenAIError('auth-required'); }
    })().finally(() => { this.#flight = undefined; }); return this.#flight;
  }
  close() { this.#token = undefined; this.#expiry = 0; }
}
