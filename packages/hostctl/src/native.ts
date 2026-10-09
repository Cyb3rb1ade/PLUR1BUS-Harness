import { spawn } from 'node:child_process';
import { fail, HostctlError } from './errors.ts';
import { killTree } from './processes.ts';
/** Fixed native argv only. Never interpolate target/text into shell or PowerShell source. */
export function native(program: string, args: string[], signal: AbortSignal, input?: string): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false, timedOut = false;
    const abort = () => { void killTree(child).catch(reject); };
    const timer = setTimeout(() => { timedOut = true; abort(); }, 30000); timer.unref(); signal.addEventListener('abort', abort, { once: true });
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    child.once('error', () => finish(new HostctlError('UNAVAILABLE', 'Install the native desktop helper or use an available desktop session.'))); child.once('close', code => finish(signal.aborted ? new HostctlError('ABORTED', 'Native operation cancelled.') : timedOut ? new HostctlError('TIMEOUT', 'Native helper timed out.') : code === 0 ? undefined : new HostctlError('IO_ERROR', 'Native helper failed; check desktop permissions and target support.')));
    child.stdin?.on('error', () => {}); child.stdin?.end(input); if (signal.aborted) abort();
  });
}
export async function trash(target: string, signal: AbortSignal) {
  if (process.platform === 'darwin') return native('/usr/bin/osascript', ['-e', 'on run argv\n set targetFile to POSIX file (item 1 of argv) as alias\n tell application "Finder" to delete targetFile\nend run', target], signal);
  if (process.platform === 'win32') return native('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName Microsoft.VisualBasic; $p=[Console]::In.ReadToEnd(); if ([System.IO.Directory]::Exists($p)) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,"OnlyErrorDialogs","SendToRecycleBin") } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,"OnlyErrorDialogs","SendToRecycleBin") }'], signal, target);
  if (process.platform === 'linux') return native('gio', ['trash', '--', target], signal);
  return fail('UNAVAILABLE', 'Native Trash is not available; no permanent-delete fallback exists.');
}
export async function open(target: string, signal: AbortSignal) {
  if (process.platform === 'darwin') return native('/usr/bin/open', ['--', target], signal);
  if (process.platform === 'win32') return native('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$p=[Console]::In.ReadToEnd(); Start-Process -FilePath $p'], signal, target);
  return native('xdg-open', [target], signal);
}
