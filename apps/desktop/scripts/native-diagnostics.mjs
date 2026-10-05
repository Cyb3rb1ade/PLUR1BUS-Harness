import {spawn} from 'node:child_process';
import {mkdtemp, rm, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const desktop = fileURLToPath(new URL('..', import.meta.url));
const fields = ['restart_offers_crash', 'modal_plain_text_redacted', 'escape_preserves_offer', 'dismiss_consumes_offer', 'idle_timer_flushes', 'confirmed_quit_takes_diagnostics'];
const reasons = new Set(['DIAGNOSTICS_GUI_DISPATCH_FAILED', 'DIAGNOSTICS_GUI_TIMEOUT', 'DIAGNOSTICS_OBSERVER_TIMEOUT', 'DIAGNOSTICS_EVAL_FAILED', 'DIAGNOSTICS_CRASH_READ_FAILED', 'DIAGNOSTICS_CRASH_MISSING', 'DIAGNOSTICS_MODAL_MISSING', 'DIAGNOSTICS_ESCAPE_FAILED', 'DIAGNOSTICS_ESCAPE_CONSUMED', 'DIAGNOSTICS_DISMISS_FAILED', 'DIAGNOSTICS_LOG_READ_FAILED', 'DIAGNOSTICS_IDLE_TIMER_FAILED']);
function run(command, args, timeout, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {cwd:desktop, stdio:capture ? ['ignore','pipe','pipe'] : 'inherit'});
    let output = ''; let errors = ''; let exceeded = false;
    const timer = setTimeout(() => {exceeded = true; child.kill('SIGKILL');}, timeout);
    if (capture) {
      child.stdout.on('data', data => {output += data; if (output.length > 16384) child.kill('SIGKILL');});
      child.stderr.on('data', data => {errors += data; if (errors.length > 16384) child.kill('SIGKILL');});
    }
    child.on('error', () => {clearTimeout(timer); reject(new Error('NATIVE_DIAGNOSTICS_FAILED'));});
    child.on('close', code => {
      clearTimeout(timer);
      for (const match of errors.matchAll(/\bDIAGNOSTICS_[A-Z_]+\b/g)) if (reasons.has(match[0])) console.error(match[0]);
      if (exceeded) reject(new Error('NATIVE_DIAGNOSTICS_TIMEOUT'));
      else accept({code, output, errors});
    });
  });
}
async function main() {
  const build = await run('cargo', ['build','--manifest-path','Cargo.toml','--locked','--example','production_diagnostics'], 300000);
  if (build.code !== 0) throw new Error('NATIVE_DIAGNOSTICS_FAILED');
  const root = await mkdtemp(join(tmpdir(), 'wp06-native-diagnostics-'));
  try {
    const executable = resolve(desktop, 'target/debug/examples/production_diagnostics' + (process.platform === 'win32' ? '.exe' : ''));
    const panic = await run(executable, [root,'--panic'], 8000, true);
    if (panic.code === 0) throw new Error('NATIVE_CRASH_NOT_TRIGGERED');
    for (const canary of ['wp06NativeCrashCanary','wp06NativeTicket','wp06NativeCookie']) {
      if ((panic.output + panic.errors).includes(canary)) throw new Error('NATIVE_CRASH_REDACTION_FAILED');
    }
    const result = await run(executable, [root], 150000, true);
    if (result.code !== 0) throw new Error('NATIVE_DIAGNOSTICS_FAILED');
    let report;
    try {report = JSON.parse(result.output.trim().split('\n').at(-1));}
    catch {throw new Error('NATIVE_DIAGNOSTICS_REPORT_MISSING');}
    if (Object.keys(report).length !== fields.length || fields.some(field => report[field] !== true)) throw new Error('NATIVE_DIAGNOSTICS_INCOMPLETE');
    console.log(JSON.stringify(report));
  } finally {
    await rm(root, {recursive:true, force:true});
    try {await lstat(root); throw new Error('NATIVE_PROFILE_CLEANUP_FAILED');}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
}
try {await main();}
catch (error) {
  const codes = new Set(['NATIVE_DIAGNOSTICS_FAILED','NATIVE_DIAGNOSTICS_TIMEOUT','NATIVE_DIAGNOSTICS_REPORT_MISSING','NATIVE_DIAGNOSTICS_INCOMPLETE','NATIVE_CRASH_NOT_TRIGGERED','NATIVE_CRASH_REDACTION_FAILED','NATIVE_PROFILE_CLEANUP_FAILED']);
  console.error(codes.has(error.message) ? error.message : 'NATIVE_DIAGNOSTICS_FAILED');
  process.exitCode = 1;
}
