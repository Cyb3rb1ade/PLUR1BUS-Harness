import { spawn } from 'node:child_process';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = fileURLToPath(new URL('..', import.meta.url));
const fields = ['spa_focus', 'close_hides', 'close_minimizes', 'shell_focus', 'quit_modal_default', 'quit_cancel_preserves_app', 'quit_confirm_exits'];
function run(command, args, timeout, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: desktop, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = ''; let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, timeout);
    if (capture) {
      child.stdout.on('data', data => { output += data; if (output.length > 8192) child.kill('SIGKILL'); });
      child.stderr.on('data', () => {}); // Never forward arbitrary renderer/native errors.
    }
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (exceeded || code !== 0) reject(new Error(exceeded ? 'NATIVE_LIFECYCLE_TIMEOUT' : 'NATIVE_LIFECYCLE_FAILED'));
      else accept(output);
    });
  });
}
await run('cargo', ['build', '--manifest-path', 'Cargo.toml', '--locked', '--example', 'production_lifecycle'], 300000);
const root = await mkdtemp(join(tmpdir(), 'wp06-native-lifecycle-driver-'));
try {
  const executable = resolve(desktop, 'target/debug/examples/production_lifecycle' + (process.platform === 'win32' ? '.exe' : ''));
  const output = await run(executable, [root], 55000, true);
  const lines = output.trim().split('\n');
  let report;
  try { report = JSON.parse(lines.at(-1)); }
  catch { throw new Error('NATIVE_LIFECYCLE_REPORT_MISSING'); }
  if (Object.keys(report).length !== fields.length || fields.some(field => report[field] !== true)) throw new Error('NATIVE_LIFECYCLE_INCOMPLETE');
  console.log(JSON.stringify(report));
} finally {
  await rm(root, { recursive: true, force: true });
  try { await lstat(root); throw new Error('NATIVE_PROFILE_CLEANUP_FAILED'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
