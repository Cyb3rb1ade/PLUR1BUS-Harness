import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import type { Egress } from '../egress/service.ts';
import { ProviderError } from '../../../providers/src/index.ts';
import { promptContext } from './context.ts';

/** Translate precise builder breakpoints after the adapter has produced the Anthropic body. Never cache volatile recall. */
export function anthropicBreakpoints(body: Record<string, unknown>): Record<string, unknown> {
  const prompt = promptContext.getStore();
  if (!prompt) return body;
  const tools = body.tools as Record<string, unknown>[] | undefined;
  const system = body.system as Record<string, unknown>[] | undefined;
  const messages = body.messages as { role: string; content: Record<string, unknown>[] }[] | undefined;
  const blocks = messages?.flatMap(m => m.content) ?? [];
  const stable = prompt.segments.filter(s => s.zone === 'system' || s.zone === 'memory');
  for (const a of [...(tools ?? []), ...(system ?? []), ...blocks]) delete a.cache_control;
  let cursor = 0;
  const positions = new Map<number, Record<string, unknown>>();
  prompt.segments.forEach((s, i) => {
    if (s.zone !== 'conversation') return;
    for (; cursor < blocks.length; cursor++) {
      const b = blocks[cursor]!;
      const match = s.kind === 'tool_use' ? b.type === 'tool_use' && b.id === s.id : s.kind === 'tool_result' ? b.type === 'tool_result' && b.tool_use_id === s.id : b.type === 'text' && b.text === s.text;
      if (match) { positions.set(i, b); cursor++; break; }
    }
  });
  for (const bp of prompt.breakpoints) {
    const s = prompt.segments[bp.segment]!;
    let block: Record<string, unknown> | undefined;
    if (s.zone === 'tools') block = tools?.at(-1);
    else if (s.zone === 'system' || s.zone === 'memory') block = system?.[stable.indexOf(s)];
    else if (s.zone === 'conversation') block = positions.get(bp.segment);
    if (block) block.cache_control = { type: 'ephemeral', ...(bp.ttl === '1h' ? { ttl: '1h' } : {}) };
  }
  return body;
}

/** POST/GET streaming fetch with the existing egress decision, pinned DNS and original TLS name. Redirects never carry credentials. */
export function providerFetch(egress: Pick<Egress, 'decide'>, format: string, transport?: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const signal = init?.signal;
    signal?.throwIfAborted();
    let body = init?.body;
    if (format === 'anthropic_messages' && typeof body === 'string') body = JSON.stringify(anthropicBreakpoints(JSON.parse(body) as Record<string, unknown>));
    // Injected transports are for recorded fixtures: they perform no DNS or network, but receive the exact final wire body.
    if (transport) return transport(input, { ...init, ...(body === undefined ? {} : { body }), redirect: 'error' });
    const d = await egress.decide(url.toString());
    signal?.throwIfAborted();
    if (!d.allowed) throw new ProviderError('invalid_request', 'provider egress denied');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (body != null && typeof body !== 'string')) throw new ProviderError('invalid_request', 'unsupported provider request');
    return new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = {}; new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
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
