// A real second process for kernel peer-PID tests; credentials arrive only on stdin and never reach output.
import { createConnection } from 'node:net';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
let socket;
const deadline = setTimeout(() => { socket?.destroy(); process.exit(2); }, 5000);
input.once('line', line => {
  const config = JSON.parse(line);
  if (config.publishPid) writeFileSync(join(config.home, 'run/core.pid'), `${process.pid} ${randomUUID()}\n`, { mode: 0o600 });
  socket = createConnection(config.address);
  let buffer = '';
  socket.once('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools.hello',
    params: { token: config.token, ticketKey: config.ticketKey } }) + '\n'));
  socket.on('data', chunk => {
    buffer += chunk.toString();
    const end = buffer.indexOf('\n');
    if (end < 0) return;
    const reply = JSON.parse(buffer.slice(0, end));
    clearTimeout(deadline);
    process.stdout.write(JSON.stringify({ ok: Boolean(reply.result), error: reply.error?.data?.error,
      tokenValid: /^[a-f0-9]{64}$/.test(config.token),
      ticketKeyValid: /^[a-f0-9]{64}$/.test(config.ticketKey) }) + '\n');
    socket.removeAllListeners('data');
  });
  socket.on('error', () => { clearTimeout(deadline); process.exit(2); });
});
input.on('close', () => { clearTimeout(deadline); socket?.destroy(); });
