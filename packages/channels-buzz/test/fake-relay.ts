import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
export async function fakeRelay() {
  const connections = new Set<Duplex>(), requests: unknown[] = [], headers: unknown[] = []; let opens = 0;
  const frame = (value: unknown) => { const b = Buffer.from(JSON.stringify(value)), h = Buffer.alloc(b.length < 126 ? 2 : 4); h[0] = 129; h[1] = b.length < 126 ? b.length : 126; if (h.length === 4) h.writeUInt16BE(b.length,2); return Buffer.concat([h,b]); };
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    opens++; headers.push(req.headers); connections.add(socket); socket.on('error', () => {}); socket.on('close', () => connections.delete(socket));
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer,chunk]);
      while (buffer.length >= 6) {
        const opcode = buffer[0]! & 15; let length = buffer[1]! & 127, start = 2;
        if (length === 126) { if (buffer.length < 8) return; length = buffer.readUInt16BE(2); start = 4; }
        if (length === 127) { if (buffer.length < 14) return; length = Number(buffer.readBigUInt64BE(2)); start = 10; }
        if (buffer.length < start + 4 + length) return;
        const mask = buffer.subarray(start,start+4), payload = Buffer.from(buffer.subarray(start+4,start+4+length)); for (let i=0;i<payload.length;i++) payload[i] = payload[i]! ^ mask[i%4]!;
        buffer = buffer.subarray(start+4+length); if (opcode === 8) { socket.end(); return; }
        const value = JSON.parse(payload.toString()); requests.push(value);
        if (Array.isArray(value) && value[0] === 'EVENT') socket.write(frame(['OK', value[1].id, true, '']));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  return { url: 'ws://127.0.0.1:' + (server.address() as {port:number}).port + '/', requests, headers, opens: () => opens,
    emit(value: unknown) { for (const socket of connections) socket.write(frame(value)); },
    async close() { for (const socket of connections) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
