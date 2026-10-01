import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = resolve(root, 'node_modules/@tauri-apps/cli/tauri.js');
const args = process.argv.slice(2);
function child(command, argv, options = {}) {
  return spawn(command, argv, { cwd: root, stdio: 'inherit', ...options });
}
function wait(proc) {
  return new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
let mock;
let mockDone;
let stateDir;
let tauri;
try {
  if (args[0] === 'dev') {
    const built = await wait(child('cargo', ['build', '--locked', '-p', 'plur1bus-mock-harness']));
    if (built !== 0) process.exit(built);
    stateDir = await mkdtemp(resolve(tmpdir(), 'p1t-desktop-dev-'));
    const exe = resolve(root, 'target/debug/plur1bus-mock-harness' + (process.platform === 'win32' ? '.exe' : ''));
    mock = spawn(exe, ['--port', '18700', '--state-dir', stateDir], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    mockDone = wait(mock).catch(() => 1);
    await new Promise((resolve, reject) => {
      mock.once('error', reject);
      mock.once('exit', () => reject(new Error('mock harness exited before becoming ready')));
      mock.stdout.once('data', () => resolve());
    });
    console.log('Desktop dev mock: http://127.0.0.1:18700');
  }
  tauri = child(process.execPath, [cli, ...args]);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => tauri.kill(signal));
  process.exitCode = await wait(tauri);
} catch (error) {
  console.error(`desktop dev: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (mock) { mock.kill('SIGTERM'); await mockDone; }
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
}
