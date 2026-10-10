import { EventEmitter } from 'node:events';
import type http from 'node:http';
import type { LookupFunction } from 'node:net';
export interface FakeReply { status?: number; headers?: http.IncomingHttpHeaders; body?: unknown; raw?: Buffer }
/** Socket-free HTTP fixture. Executes the production pinned lookup and bounded response reader. */
export function fakeHttp(reply: (url: URL, headers: Record<string, string>) => FakeReply) {
  const calls: { url: string; headers: Record<string, string>; address: string | undefined }[] = [];
  const request = ((url: URL, options: { headers: Record<string, string>; lookup?: LookupFunction }, callback: (res: unknown) => void) => {
    const call = { url: url.toString(), headers: options.headers, address: undefined as string | undefined }; calls.push(call);
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    req.destroy = () => {};
    req.end = () => { queueMicrotask(() => {
      const send = () => {
        const r = reply(url, options.headers), res = new EventEmitter() as EventEmitter & { statusCode: number; headers: http.IncomingHttpHeaders; destroy(): void };
        res.statusCode = r.status ?? 200; res.headers = { 'content-type': 'application/json', ...r.headers }; res.destroy = () => {};
        callback(res);
        res.emit('data', r.raw ?? Buffer.from(JSON.stringify(r.body ?? {}))); res.emit('end');
      };
      if (options.lookup) options.lookup(url.hostname, { all: false }, (err, address) => { if (err) req.emit('error', err); else { call.address = typeof address === "string" ? address : address[0]?.address; send(); } });
      else send();
    }); };
    return req;
  }) as unknown as typeof http.request;
  return { request, calls };
}
