import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const runtime = args[0] === '--runtime' && args.length === 2 ? args[1] : null;
if (!['docker', 'podman'].includes(runtime)) {
  console.error('usage: node apps/desktop/stub-image/smoke.mjs --runtime docker|podman'); process.exit(2);
}
if (process.env.PLUR1BUS_DESKTOP_E2E_RUNTIME !== runtime) {
  console.log(`SKIP: opt in with PLUR1BUS_DESKTOP_E2E_RUNTIME=${runtime}`); process.exit(0);
}
function cli(argv, timeout = 30_000) {
  const result = spawnSync(runtime, argv, { encoding: 'utf8', timeout });
  if (result.error) throw new Error(`${runtime} unavailable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${runtime} ${argv[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
async function freePort() {
  for (let port = 18700; port <= 18799; port++) {
    const open = await new Promise(resolve => {
      const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (open) return port;
  }
  throw new Error('no free desktop test port in 18700-18799');
}
const id = randomBytes(6).toString('hex');
const container = `p1t-${id}-harness`;
const state = `p1t-${id}-state`;
const models = `p1t-${id}-models`;
let created = false;
const volumes = [];
try {
  cli(['info']);
  const port = await freePort();
  for (const name of [state, models]) {
    cli(['volume', 'create', '--label', `app.plur1bus.test=${id}`, name]);
    volumes.push(name);
  }
  cli(['run', '--detach', '--name', container, '--label', `app.plur1bus.test=${id}`,
    '--user', '10001:10001', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '1024', '--restart', 'unless-stopped',
    '--stop-timeout', '150', '--publish', `127.0.0.1:${port}:18700`,
    '--volume', `${state}:/var/lib/plur1bus`, '--volume', `${models}:/var/lib/plur1bus/models`,
    '--env', 'PLUR1BUS_CONTAINER=1', '--env', 'PLUR1BUS_HOME=/var/lib/plur1bus',
    '--env', 'TZ=UTC', '--env', 'LANG=C.UTF-8', 'p1t-stub-harness:wp02']);
  created = true;
  const published = cli(['port', container, '18700/tcp']);
  if (!published.split('\n').every(line => line.startsWith('127.0.0.1:'))) throw new Error(`non-loopback publish: ${published}`);
  let meta;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/v1/meta`); if (r.ok) { meta = await r.json(); break; } } catch {}
    await delay(250);
  }
  if (meta?.apiVersion !== '1.0.0' || !meta.installationId) throw new Error('mock meta did not become ready');
  const status = JSON.parse(cli(['exec', container, 'plur1bus', 'daemon', 'status', '--json']));
  if (status.schema !== 'daemon.status/1' || status.supervisor !== 'running') throw new Error('wrong daemon status fixture');
  const started = Date.now();
  cli(['stop', '--time', '150', container], 155_000);
  if (Date.now() - started >= 150_000) throw new Error('stop exceeded 150 seconds');
  console.log(`PASS: ${runtime} stub image; loopback meta, fixture exec, stop ${Date.now() - started} ms`);
} catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
finally {
  if (created) { try { cli(['rm', '--force', container]); } catch (e) { console.error(`cleanup: ${e.message}`); process.exitCode = 1; } }
  for (const name of volumes) { try { cli(['volume', 'rm', name]); } catch (e) { console.error(`cleanup: ${e.message}`); process.exitCode = 1; } }
}
