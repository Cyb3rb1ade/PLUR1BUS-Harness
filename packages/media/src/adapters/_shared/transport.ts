import { HttpTransport, boundedBytes, classify } from '../../http.ts';
import type { RetryPolicy } from './retry.ts';
import { DEFAULT_RETRY, defaultSleep, retryDelay, retryable } from './retry.ts';
import { MediaError, failure } from '../../types.ts';
import { authError } from './errors.ts';
export interface ResilientOptions { adapter: string; timeoutMs?: number; downloadHosts?: string[]; authKind?: HttpTransport['authKind']; retry?: RetryPolicy }
/**
 * HttpTransport plus bounded retry (429 + idempotent 5xx, honouring Retry-After) and an auth sub-reason for 401/403.
 * Same URL, redirect, size and credential rules as the base class; `image()` is inherited unchanged.
 */
export class ResilientTransport extends HttpTransport {
  readonly #key?: string; readonly #adapter: string; readonly #retry: RetryPolicy;
  constructor(base: string, key: string | undefined, options: ResilientOptions) {
    super(base, key, options.timeoutMs, options.downloadHosts, options.authKind);
    const retry = options.retry ?? {};
    const attempts = retry.maxAttempts ?? DEFAULT_RETRY.maxAttempts;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10 || [retry.baseMs, retry.maxMs].some(v => v !== undefined && (!Number.isFinite(v) || v < 0)) || retry.maxMs === 0) throw new MediaError('unsupported_parameter');
    if (key) this.#key = key; this.#adapter = options.adapter; this.#retry = retry;
  }
  override async json(path: string, body: unknown, signal: AbortSignal, method = body === undefined ? 'GET' : 'POST'): Promise<Record<string, unknown>> {
    const url = new URL(this.base.toString().replace(/\/$/, '') + '/' + path.replace(/^\//, ''));
    if (url.origin !== this.base.origin) throw new MediaError('unsupported_parameter');
    const headers: Record<string, string> = {};
    if (this.#key) { if (this.authKind === 'google') headers['x-goog-api-key'] = this.#key; else headers.authorization = `${this.authKind} ${this.#key}`; }
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart) headers['content-type'] = 'application/json';
    const attempts = this.#retry.maxAttempts ?? DEFAULT_RETRY.maxAttempts; const sleep = this.#retry.sleep ?? defaultSleep;
    try {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(url, { method, headers, redirect: 'error', signal, ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) });
        let parsed: unknown; let unreadable = false;
        try { parsed = JSON.parse(Buffer.from(await boundedBytes(response)).toString('utf8')); } catch (e) { if (e instanceof MediaError) throw e; unreadable = true; parsed = {}; }
        if (response.ok && !unreadable && !(parsed as Record<string, unknown> | null)?.error) {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MediaError('invalid_response');
          return parsed as Record<string, unknown>;
        }
        if (response.ok && unreadable) throw new MediaError('invalid_response');
        if (!response.ok && attempt + 1 < attempts && retryable(method, response.status)) {
          const wait = retryDelay(attempt, this.#retry, response.headers.get('retry-after'));
          if (wait !== undefined) { await sleep(wait, signal); continue; }
        }
        const mapped = classify(response.status, parsed);
        if (response.status === 401) throw authError('auth_invalid', this.#adapter);
        if (response.status === 403 && mapped.code !== 'content_policy') throw authError('auth_forbidden', this.#adapter);
        throw mapped;
      }
    } catch (e) { throw failure(e, signal.aborted && signal.reason?.name !== 'TimeoutError' ? signal : undefined); }
  }
}
