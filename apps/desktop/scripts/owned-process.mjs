import { spawn } from 'node:child_process';
import { rm, lstat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// 'close' follows process exit and pipe closure. Never delete a child's profile
// from the 'exit' event while inherited handles can still be draining.
export function runOwnedChild(command, args, options, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

export async function removeExitedProfile(root, io = { rm, lstat, delay }) {
  // Windows may release WebView/helper handles shortly after process close.
  // Only sharing-related errors get the fixed 10 x 100ms deletion reserve.
  for (let attempt = 0; ; attempt++) {
    try { await io.rm(root, { recursive: true, force: true, maxRetries: 0 }); break; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code) || attempt === 10) {
        const code = ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(error.code) ? error.code : 'OTHER';
        throw new Error(`OWNED_PROFILE_DELETE_FAILED code=${code} retries=${attempt}`);
      }
      await io.delay(100);
    }
  }
  try { await io.lstat(root); }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error('OWNED_PROFILE_VERIFY_FAILED code=OTHER'); }
  throw new Error('OWNED_PROFILE_RETAINED exists=true');
}
