// Loopback API child fixture for supervisor/Doctor tests; production HTTP/Core coverage lives in tests/system.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const home = arg('--home');
const file = join(home, 'run', 'api-listen.json');
mkdirSync(join(home, 'run'), { recursive: true, mode: 0o700 });
const server = createServer((req, res) => {
  if (req.url !== '/api/v1/meta') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ version: '1.0.0', capabilities: ['desktop-pair-v1'], pairingRequired: true }));
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(file, JSON.stringify({ address: '127.0.0.1', port: server.address().port, version: '1.0.0', fingerprint: null, pid: process.pid }), { mode: 0o600 });
});
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; server.close(() => { rmSync(file, { force: true }); process.exit(0); }); server.closeAllConnections(); };
process.stdin.on('end', stop); process.stdin.resume();
process.on('SIGTERM', stop); process.on('SIGINT', stop);
