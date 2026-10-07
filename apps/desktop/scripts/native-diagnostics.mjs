import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {removeExitedProfile} from './owned-process.mjs';
import {jobDiagnostic, jobSafeToDelete} from './fixture-job.mjs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const desktop = fileURLToPath(new URL('..', import.meta.url));
const fields = ['restart_offers_crash', 'modal_plain_text_redacted', 'escape_preserves_offer', 'dismiss_consumes_offer', 'idle_timer_flushes', 'confirmed_quit_takes_diagnostics'];
const reasons = new Set(['DIAGNOSTICS_GUI_DISPATCH_FAILED', 'DIAGNOSTICS_GUI_TIMEOUT', 'DIAGNOSTICS_OBSERVER_TIMEOUT', 'DIAGNOSTICS_EVAL_FAILED', 'DIAGNOSTICS_CRASH_READ_FAILED', 'DIAGNOSTICS_CRASH_MISSING', 'DIAGNOSTICS_MODAL_MISSING', 'DIAGNOSTICS_ESCAPE_FAILED', 'DIAGNOSTICS_ESCAPE_CONSUMED', 'DIAGNOSTICS_DISMISS_FAILED', 'DIAGNOSTICS_LOG_READ_FAILED', 'DIAGNOSTICS_IDLE_TIMER_FAILED']);
for (const stage of ['PAGE_STARTED', 'PAGE_FINISHED', 'OBSERVER_STARTED', 'MODAL_ABSENT', 'MODAL_CLOSED', 'MODAL_PRE_ABSENT', 'MODAL_HEADER_ABSENT', 'MODAL_BACKTRACE_ABSENT', 'MODAL_NOT_PLAIN_TEXT', 'MODAL_SECRET_DETECTED', 'CRASH_IPC_ONE_OFFER', 'CRASH_IPC_OTHER_COUNT', 'CRASH_IPC_READ_FAILED', 'CRASH_IPC_OTHER_FAILED']) reasons.add('DIAGNOSTICS_' + stage);
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
      if (code !== 0 || exceeded) for (const line of errors.split('\n')) { const diagnostic = jobDiagnostic(line.trim()); if (diagnostic) console.error(diagnostic); }
      for (const match of errors.matchAll(/\bDIAGNOSTICS_[A-Z_]+\b/g)) if (reasons.has(match[0])) console.error(match[0]);
      if (exceeded) reject(new Error('NATIVE_DIAGNOSTICS_TIMEOUT'));
      else accept({code, output, errors, jobDisposed: errors.split('\n').some(line => jobSafeToDelete(line.trim()))});
    });
  });
}
async function main() {
  const build = await run('cargo', ['build','--manifest-path','Cargo.toml','--locked','--example','production_diagnostics', ...(process.platform === 'win32' ? ['--example','production_job'] : [])], 300000);
  if (build.code !== 0) throw new Error('NATIVE_DIAGNOSTICS_FAILED');
  const root = await mkdtemp(join(tmpdir(), 'wp06-native-diagnostics-'));
  let safeToDelete = process.platform !== 'win32';
  try {
    const executable = resolve(desktop, 'target/debug/examples/production_diagnostics' + (process.platform === 'win32' ? '.exe' : ''));
    const panic = await run(executable, [root,'--panic'], 8000, true);
    if (panic.code === 0) throw new Error('NATIVE_CRASH_NOT_TRIGGERED');
    for (const canary of ['wp06NativeCrashCanary','wp06NativeTicket','wp06NativeCookie']) {
      if ((panic.output + panic.errors).includes(canary)) throw new Error('NATIVE_CRASH_REDACTION_FAILED');
    }
    const job = resolve(desktop, 'target/debug/examples/production_job.exe');
    const result = await run(process.platform === 'win32' ? job : executable, process.platform === 'win32' ? ['production_diagnostics', root] : [root], 150000, true);
    safeToDelete ||= result.jobDisposed;
    if (result.code !== 0) throw new Error(`NATIVE_DIAGNOSTICS_CHILD_FAILED exitCode=${result.code}`);
    if (!safeToDelete) throw new Error('NATIVE_DIAGNOSTICS_JOB_DISPOSAL_UNCONFIRMED');
    let report;
    try {report = JSON.parse(result.output.trim().split('\n').at(-1));}
    catch {throw new Error('NATIVE_DIAGNOSTICS_REPORT_MISSING');}
    if (Object.keys(report).length !== fields.length || fields.some(field => report[field] !== true)) throw new Error('NATIVE_DIAGNOSTICS_INCOMPLETE');
    console.log(JSON.stringify(report));
  } finally {
    if (safeToDelete) await removeExitedProfile(root);
    else console.error('FIXTURE_JOB_PROFILE_RETAINED disposition=unconfirmed');
  }
}
try {await main();}
catch (error) {
  const codes = new Set(['NATIVE_DIAGNOSTICS_FAILED','NATIVE_DIAGNOSTICS_TIMEOUT','NATIVE_DIAGNOSTICS_REPORT_MISSING','NATIVE_DIAGNOSTICS_INCOMPLETE','NATIVE_CRASH_NOT_TRIGGERED','NATIVE_CRASH_REDACTION_FAILED','NATIVE_PROFILE_CLEANUP_FAILED','NATIVE_DIAGNOSTICS_JOB_DISPOSAL_UNCONFIRMED']);
  const observed = /^(?:OWNED_PROFILE_[A-Z_]+|NATIVE_DIAGNOSTICS_CHILD_FAILED) [A-Za-z0-9_= -]+$/.test(error.message);
  console.error(codes.has(error.message) || observed ? error.message : 'NATIVE_DIAGNOSTICS_FAILED');
  process.exitCode = 1;
}
