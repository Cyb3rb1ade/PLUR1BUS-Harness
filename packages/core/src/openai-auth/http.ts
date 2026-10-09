import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { providerFetch } from '../composition/http.ts';
import type { Egress } from '../egress/service.ts';
import { OpenAIError, bounded, object, type HttpPort } from './ports.ts';
/** The same egress admission/DNS pinning used for inference, with bounded JSON payloads and no redirects. */
export function createOpenAIHttp(o: { egress: Pick<Egress, 'decide'>; fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number }): HttpPort {
  const fetcher = providerFetch(o.egress, 'openai', o.fetch);
  return { async request(r) {
    const signal = AbortSignal.any([AbortSignal.timeout(o.timeoutMs ?? 30000), ...(r.signal ? [r.signal] : [])]);
    try {
      const headers = new Headers(r.headers); headers.set('accept', 'application/json');
      if (r.authorization) headers.set('authorization', 'Bearer ' + r.authorization.value());
      let body = r.form ? new URLSearchParams(r.form).toString() : r.json ? JSON.stringify(r.json) : undefined;
      if (body) headers.set('content-type', r.form ? 'application/x-www-form-urlencoded' : 'application/json');
      const realtimeSdp = r.sdp !== undefined && new URL(r.url).pathname.endsWith('/realtime/calls');
      if (realtimeSdp) { const marker = randomUUID(); const { transport: _transport, ...session } = r.json ?? {}; body = '--' + marker + '\r\nContent-Disposition: form-data; name="sdp"\r\n\r\n' + r.sdp + '\r\n--' + marker + '\r\nContent-Disposition: form-data; name="session"\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify({ ...session, type: 'realtime' }) + '\r\n--' + marker + '--\r\n'; headers.set('content-type', 'multipart/form-data; boundary=' + marker); }
      const response = await bounded(fetcher(r.url, { method: r.method, headers, signal, ...(body ? { body } : {}), redirect: 'error' }), signal);
      if (!response.body) throw new OpenAIError('endpoint-rejected');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const read = await bounded(reader.read(), signal); if (read.done) break; size += read.value.byteLength; if (size > (o.maxBytes ?? 256 * 1024)) throw new OpenAIError('endpoint-rejected'); chunks.push(read.value); } }
      finally { await reader.cancel().catch(() => {}); }
      const raw = Buffer.concat(chunks).toString('utf8');
      const data = realtimeSdp && response.ok ? { id: (response.headers.get('location') ?? '').split('/').at(-1), sdp: raw } : object(JSON.parse(raw));
      const result = { status: response.status, body: data, headers: response.headers };
      Object.defineProperty(result, inspect.custom, { value: () => ({ status: result.status, body: '[redacted]' }) });
      Object.defineProperty(result, 'toJSON', { value: () => ({ status: result.status, body: '[redacted]' }) });
      return result;
    } catch (e) { throw e instanceof OpenAIError ? e : new OpenAIError('transport-failed'); }
  } };
}
