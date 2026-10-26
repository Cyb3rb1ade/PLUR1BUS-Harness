import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import type { Egress } from '../egress/service.ts';
import { ProviderError, type CacheRoute } from '../../../providers/src/index.ts';
import { anthropicMarkers, emitProviderCache } from './cache-emit.ts';
import { promptContext } from './context.ts';

/** The builder's breakpoints on an Anthropic body, for the rendered prompt in scope; the body is returned untouched without one. */
export function anthropicBreakpoints(body: Record<string, unknown>): Record<string, unknown> {
  const prompt = promptContext.getStore();
  return prompt ? anthropicMarkers(body, prompt) : body;
}

/** The adapter's wire body as an object; anything else is refused locally (typed, nothing sent) instead of a raw SyntaxError. */
function wireBody(body: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { parsed = undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ProviderError('invalid_request', 'provider request body is not a JSON object', { code: 'request_refused_locally' });
  return parsed as Record<string, unknown>;
}

const CACHE_WIRES = new Set(['anthropic_messages', 'chat_completions', 'codex_responses']);

/**
 * POST/GET streaming fetch with the existing egress decision, pinned DNS and original TLS name. Redirects never carry credentials.
 * Inside a turn (a rendered prompt in scope) the body gets the provider's cache fields for `route` (RE-D22, `cache-emit.ts`).
 */
export function providerFetch(egress: Pick<Egress, 'decide'>, format: string, transport?: typeof fetch, route: CacheRoute = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const signal = init?.signal;
    signal?.throwIfAborted();
    let body = init?.body;
    let headersInit = init?.headers;
    const prompt = promptContext.getStore();
    if (typeof body === 'string' && (format === 'anthropic_messages' || (prompt && CACHE_WIRES.has(format)))) {
      const parsed = wireBody(body);
      if (prompt) {
        const given = new Headers(init?.headers);
        const extra: Record<string, string> = {};
        emitProviderCache(format, parsed, { has: name => given.has(name) || name.toLowerCase() in extra, set: (name, value) => { extra[name.toLowerCase()] = value; } }, route, prompt);
        if (Object.keys(extra).length > 0) { const all: Record<string, string> = {}; given.forEach((value, key) => { all[key] = value; }); headersInit = { ...all, ...extra }; }
      }
      body = JSON.stringify(parsed);
    }
    // Injected transports are for recorded fixtures: they perform no DNS or network, but receive the exact final wire body.
    if (transport) return transport(input, { ...init, ...(body === undefined ? {} : { body }), ...(headersInit === init?.headers || headersInit === undefined ? {} : { headers: headersInit }), redirect: 'error' });
    const d = await egress.decide(url.toString());
    signal?.throwIfAborted();
    if (!d.allowed) throw new ProviderError('invalid_request', 'provider egress denied', { code: 'egress_denied' });
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (body != null && typeof body !== 'string')) throw new ProviderError('invalid_request', 'unsupported provider request', { code: 'request_refused_locally' });
    return new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = {}; new Headers(headersInit).forEach((value, key) => { headers[key] = value; });
      if (typeof body === 'string') headers['content-length'] = String(Buffer.byteLength(body));
      const request = (url.protocol === 'https:' ? https : http).request(url, { method: init?.method ?? 'GET', headers, agent: false, ...(signal ? { signal } : {}), lookup: (_hostname, options, cb) => {
        if (typeof options === 'object' && options.all) cb(null, [{ address: d.address, family: d.family }]); else cb(null, d.address, d.family);
      } }, response => {
        const status = response.statusCode ?? 500;
        if (status >= 300 && status < 400) { response.destroy(); request.destroy(); reject(new ProviderError('invalid_request', 'provider redirects refused')); return; }
        const h = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) h.set(key, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers: h }));
      });
      request.on('error', reject);
      if (typeof body === 'string') request.write(body);
      request.end();
    });
  }) as typeof fetch;
}
