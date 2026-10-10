import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import { defaultWsFactory, type FetchLike, type WsFactory, VoiceProviderError } from '../../../voice-providers/src/index.ts';
import type { Egress } from '../egress/service.ts';
/** Use the existing guarded streaming HTTP client; binary multipart audio is kept intact. Redirects are refused. */
export function voiceFetch(egress: Egress): FetchLike {
  return async (url, init) => {
    const headers: Record<string, string> = {}; new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    let body: Buffer | undefined;
    if (init.body != null) { const request = new Request(url, init); body = Buffer.from(await request.arrayBuffer()); request.headers.forEach((v, k) => { headers[k] = v; }); }
    const u = new URL(url); const d = await egress.decide(url); init.signal?.throwIfAborted();
    if (!d.allowed || !['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new VoiceProviderError('config', 'voice egress denied');
    if (body) headers['content-length'] = String(body.length);
    return new Promise<Response>((resolve, reject) => {
      const request = (u.protocol === 'https:' ? https : http).request(u, { agent: false, method: init.method ?? 'GET', headers, ...(init.signal ? { signal: init.signal } : {}), lookup: (_host, options, cb) => {
        if (typeof options === 'object' && options.all) cb(null, [{ address: d.address, family: d.family }]); else cb(null, d.address, d.family);
      } }, response => {
        const status = response.statusCode ?? 500;
        if (status >= 300 && status < 400) { response.destroy(); request.destroy(); reject(new VoiceProviderError('config', 'voice redirects refused')); return; }
        const headers = new Headers(); for (const [k, v] of Object.entries(response.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        try {
          const stream = status === 204 || status === 205 ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
          if (stream === null) response.resume();
          resolve(new Response(stream, { status, headers }));
        } catch { response.destroy(); reject(new VoiceProviderError('bad_response', 'voice response invalid')); }
      });
      request.on('error', reject); if (body) request.write(body); request.end();
    });
  };
}
export function voiceSockets(egress: Pick<Egress, 'decide'>): WsFactory {
  return async (url, init) => {
    const u = new URL(url); u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    const d = await egress.decide(u.href); init.signal?.throwIfAborted();
    if (!d.allowed) throw new VoiceProviderError('config', 'voice egress denied');
    return defaultWsFactory(url, { ...init, lookup: (_host, options, cb) => {
      if (typeof options === 'object' && options.all) cb(null, [{ address: d.address, family: d.family }]); else cb(null, d.address, d.family);
    } });
  };
}

/** AWS SDK handler: signed payload and headers use the same egress pin as other voice traffic. */
export function pollyRequestHandler(egress: Egress) {
  const fetch = voiceFetch(egress);
  return { async handle(request: { protocol: string; hostname: string; port?: number; path: string; query?: Record<string, string | string[]>; method: string; headers: Record<string, string>; body?: string | Uint8Array }, options: { abortSignal?: AbortSignal } = {}) {
    const url = new URL(request.protocol + '//' + request.hostname + (request.port ? ':' + request.port : '') + request.path);
    for (const [k, values] of Object.entries(request.query ?? {})) for (const v of Array.isArray(values) ? values : [values]) url.searchParams.append(k, v);
    const body = request.body instanceof Uint8Array ? new Blob([Buffer.from(request.body)]) : request.body;
    const r = await fetch(url.href, { method: request.method, headers: request.headers, ...(body !== undefined ? { body } : {}), ...(options.abortSignal ? { signal: options.abortSignal } : {}) });
    const headers: Record<string, string> = {}; r.headers.forEach((v,k) => { headers[k] = v; });
    return { response: { statusCode: r.status, headers, body: r.body ? Readable.fromWeb(r.body as import('node:stream/web').ReadableStream<Uint8Array>) : Readable.from([]) } };
  } };
}
