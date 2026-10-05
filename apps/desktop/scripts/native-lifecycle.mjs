import { spawn } from 'node:child_process';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = fileURLToPath(new URL('..', import.meta.url));
const fields = ['second_instance_focus', 'spa_focus', 'close_hides', 'close_minimizes', 'shell_focus', 'quit_modal_default', 'quit_cancel_preserves_app', 'quit_confirm_exits'];
const fixtureReasons = new Set(['FIXTURE_CANCEL_APPROVED', 'FIXTURE_CLOSE_HIDES_OBSERVED', 'FIXTURE_CLOSE_MINIMIZES_OBSERVED', 'FIXTURE_EARLY_APPROVAL', 'FIXTURE_EXECUTABLE_FAILED', 'FIXTURE_GUI_DISPATCH_FAILED', 'FIXTURE_GUI_TIMEOUT', 'FIXTURE_OBSERVER_TIMEOUT', 'FIXTURE_QUIT_CANCEL_PRESERVES_APP_OBSERVED', 'FIXTURE_QUIT_MODAL_DEFAULT_OBSERVED', 'FIXTURE_SECOND_INSTANCE_FAILED', 'FIXTURE_SECOND_INSTANCE_FOCUS_OBSERVED', 'FIXTURE_SECOND_INSTANCE_REJECTED', 'FIXTURE_SECOND_INSTANCE_TIMEOUT', 'FIXTURE_SECOND_INSTANCE_WAIT_FAILED', 'FIXTURE_SETUP', 'FIXTURE_SHELL_FOCUS_OBSERVED', 'FIXTURE_SHELL_NOT_VISIBLE', 'FIXTURE_SHELL_VISIBLE', 'FIXTURE_SINGLETON_BYPASSED', 'FIXTURE_SPA_FOCUS_OBSERVED', 'FIXTURE_SPA_NOT_FOCUSED', 'FIXTURE_START']);
// Forward only the fixed read-only native focus schema; discard all other child text.
function focusDiagnostic(line) {
  const prefix = 'WP6_FOCUS_DIAGNOSTIC ';
  if (!line.startsWith(prefix) || line.length > 4096) return;
  try {
    const d = JSON.parse(line.slice(prefix.length));
    const keys = (v, names) => v && Object.keys(v).sort().join(',') === [...names].sort().join(',');
    const uint = v => Number.isSafeInteger(v) && v >= 0;
    if (!keys(d, ['stage', 'elapsedMs', 'foregroundHwnd', 'foregroundPid', 'foregroundThread', 'processId', 'foregroundProcessKind', 'foregroundQueueAvailable', 'foregroundActiveHwnd', 'foregroundKeyboardFocusHwnd', 'foregroundRootOwnerHwnd', 'foregroundWindowKind', 'windows']) ||
      !['before-focus', 'after-focus-call', 'after-focus-observation'].includes(d.stage) ||
      !['elapsedMs', 'foregroundHwnd', 'foregroundPid', 'foregroundThread', 'processId', 'foregroundActiveHwnd', 'foregroundKeyboardFocusHwnd', 'foregroundRootOwnerHwnd'].every(k => uint(d[k])) ||
      !['unavailable', 'dialog', 'chromium', 'console', 'core-window', 'desktop-shell', 'other'].includes(d.foregroundWindowKind) ||
      !['unavailable', 'explorer', 'powershell', 'terminal', 'browser', 'webview', 'logon', 'dwm', 'spa-fixture', 'spa-driver', 'transport-fixture', 'lifecycle-fixture', 'diagnostics-fixture', 'build-host', 'shell-host', 'error-dialog', 'fixture-test', 'other'].includes(d.foregroundProcessKind) || typeof d.foregroundQueueAvailable !== 'boolean' || !Array.isArray(d.windows) || d.windows.length !== 2 || !d.windows.every((w, i) =>
        keys(w, ['label', 'hwnd', 'visible', 'minimized', 'foreground', 'pid', 'thread', 'tauriFocused', 'queueAvailable', 'activeHwnd', 'keyboardFocusHwnd', 'keyboardFocusWithin']) &&
        w.label === ['shell', 'spa'][i] && ['hwnd', 'pid', 'thread', 'activeHwnd', 'keyboardFocusHwnd'].every(k => uint(w[k])) &&
        ['visible', 'minimized', 'foreground', 'queueAvailable', 'keyboardFocusWithin'].every(k => typeof w[k] === 'boolean') &&
        (w.tauriFocused === null || typeof w.tauriFocused === 'boolean'))) return;
    console.error(prefix + JSON.stringify(d));
  } catch { /* Malformed child diagnostics are never forwarded. */ }
}
function run(command, args, timeout, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: desktop, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = ''; let exceeded = false; let stderrPending = '';
    const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, timeout);
    if (capture) {
      child.stdout.on('data', data => { output += data; if (output.length > 8192) child.kill('SIGKILL'); });
      child.stderr.on('data', data => {
        stderrPending += data.toString();
        const lines = stderrPending.split('\n'); stderrPending = lines.pop();
        if (stderrPending.length > 4096) stderrPending = '';
        for (const line of lines) {
          focusDiagnostic(line.trim());
          for (const code of line.matchAll(/\bFIXTURE_[A-Z_]+\b/g)) {
            if (fixtureReasons.has(code[0])) console.error(code[0]);
          }
        }
      });
    }
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (exceeded || code !== 0) reject(new Error(exceeded ? 'NATIVE_LIFECYCLE_TIMEOUT' : 'NATIVE_LIFECYCLE_FAILED'));
      else accept(output);
    });
  });
}
async function main() {
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

}
try { await main(); }
catch (error) {
  const codes = new Set(['NATIVE_LIFECYCLE_TIMEOUT', 'NATIVE_LIFECYCLE_FAILED', 'NATIVE_LIFECYCLE_REPORT_MISSING', 'NATIVE_LIFECYCLE_INCOMPLETE', 'NATIVE_PROFILE_CLEANUP_FAILED']);
  console.error(codes.has(error.message) ? error.message : 'NATIVE_LIFECYCLE_FAILED');
  process.exitCode = 1;
}
