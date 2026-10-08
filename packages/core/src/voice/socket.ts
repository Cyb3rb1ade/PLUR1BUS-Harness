import * as http from 'node:http';
import * as https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { Egress } from '../egress/service.ts';
import { OpenAIError, bounded, type Sensitive } from '../openai-auth/ports.ts';
export interface JsonSocket { send(value: unknown): Promise<void>; close(): Promise<void> }
export interface SocketRequest { url: string; authorization: Sensitive; onMessage(value: unknown): Promise<void>; onClose(): void; signal?: AbortSignal }
export type SocketConnect = (request: SocketRequest) => Promise<JsonSocket>;
/** Authenticated RFC6455 transport: pinned address, original TLS name, masked client frames, bounded messages/queue. */
export function socketConnect(egress: Pick<Egress, 'decide'>): SocketConnect {
  return async r => {
    const url = new URL(r.url); if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash) throw new OpenAIError('invalid-request');
    const address = new URL(url); address.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(r.signal ? [r.signal] : [])]);
    const decision = await bounded(egress.decide(address.href), signal); if (!decision.allowed) throw new OpenAIError('transport-unavailable');
    if (url.protocol === 'ws:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new OpenAIError('transport-unavailable');
    const key = randomBytes(16).toString('base64');
    return new Promise<JsonSocket>((resolve, reject) => {
      let socket: Duplex | undefined, stopped = false, upgraded = false, buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0), fragments: Buffer[] = [], fragmentSize = 0, textMessage = false, pending = 0;
      let work = Promise.resolve();
      const stop = () => { if (stopped) return; stopped = true; socket?.destroy(); request.destroy(); if (upgraded) r.onClose(); else reject(new OpenAIError('transport-failed')); };
      const request = (address.protocol === 'https:' ? https : http).request(address, { method: 'GET', agent: false, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13', authorization: 'Bearer ' + r.authorization.value() }, lookup: (_hostname, options, cb) => { if (typeof options === 'object' && options.all) cb(null, [{ address: decision.address, family: decision.family }]); else cb(null, decision.address, decision.family); } });
      const abort = () => stop(); signal.addEventListener('abort', abort, { once: true });
      request.on('error', stop); request.on('response', response => { response.destroy(); stop(); });
      const frame = (opcode: number, payload: Buffer) => {
        if (!socket || stopped || payload.length > 1024 * 1024) throw new OpenAIError('transport-failed');
        const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10);
        header[0] = 0x80 | opcode; header[1] = 0x80 | (payload.length < 126 ? payload.length : payload.length < 65536 ? 126 : 127);
        if (header.length === 4) header.writeUInt16BE(payload.length, 2); if (header.length === 10) header.writeBigUInt64BE(BigInt(payload.length), 2);
        const mask = randomBytes(4), data = Buffer.from(payload); for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i % 4]!;
        return Buffer.concat([header, mask, data]);
      };
      const accept = (chunk: Buffer) => {
        try {
          buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 2 * 1024 * 1024) throw new Error();
          while (buffer.length >= 2) {
            const first = buffer[0]!, second = buffer[1]!; const fin = !!(first & 128), opcode = first & 15;
            if ((first & 112) || (second & 128)) throw new Error(); let length = second & 127, start = 2;
            if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); start = 4; }
            else if (length === 127) { if (buffer.length < 10) return; const n = buffer.readBigUInt64BE(2); if (n > 1048576n) throw new Error(); length = Number(n); start = 10; }
            if (length > 1048576 || (opcode >= 8 && (!fin || length > 125))) throw new Error(); if (buffer.length < start + length) return;
            const payload = buffer.subarray(start, start + length); buffer = buffer.subarray(start + length);
            if (opcode === 8) { stop(); return; } if (opcode === 9) { socket!.write(frame(10, payload)); continue; } if (opcode === 10) continue;
            if (opcode === 1) { if (textMessage) throw new Error(); textMessage = true; } else if (opcode !== 0 || !textMessage) throw new Error();
            fragments.push(payload); fragmentSize += payload.length; if (fragmentSize > 1048576) throw new Error();
            if (!fin) continue;
            const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(fragments))); fragments = []; fragmentSize = 0; textMessage = false;
            if (++pending > 128) throw new Error();
            work = work.then(() => r.onMessage(message)).catch(stop).finally(() => { pending--; });
          }
        } catch { stop(); }
      };
      request.on('upgrade', (response, stream, head) => {
        const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (response.headers['sec-websocket-accept'] !== expected || response.headers.upgrade?.toLowerCase() !== 'websocket') { stream.destroy(); stop(); return; }
        socket = stream; upgraded = true; signal.removeEventListener('abort', abort);
        stream.on('error', stop); stream.on('close', stop); stream.on('data', accept);
        resolve({ async send(value) { const bytes = frame(1, Buffer.from(JSON.stringify(value))); await new Promise<void>((yes, no) => stream.write(bytes, err => err ? no(new OpenAIError('transport-failed')) : yes())); }, async close() { if (!stopped) { try { stream.write(frame(8, Buffer.alloc(0))); } finally { stop(); } } } });
        if (head.length) accept(head);
      });
      request.end();
    });
  };
}
