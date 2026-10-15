import { spawn, execFileSync } from 'node:child_process';
import { existsSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
export type CheckKind = 'format' | 'lint' | 'typecheck' | 'test';
export interface VerifierCommand { kind: CheckKind; argv: string[]; emptyOutput?: boolean }
export interface VerifierResult { ok: boolean; exitCode: number | null; reason?: string; output: string }
export interface VerifierPort { run(root: string, command: VerifierCommand, options: { signal: AbortSignal; networkAllowed: boolean }): Promise<VerifierResult> }
/** No shell, no inherited credentials/environment, bounded output, process group kill. Unsupported isolation fails closed. */
export function sandboxVerifier(timeoutMs = 60000): VerifierPort {
  return { async run(root, command, options) {
    if (options.signal.aborted) return { ok: false, exitCode: null, reason: 'aborted', output: '' };
    if (!command.argv.length) return { ok: false, exitCode: null, reason: 'missing-command', output: '' };
    const temp = mkdtempSync(join(tmpdir(), 'p1b-verifier-'));
    try {
      const name = command.argv[0]!;
      const program = name === 'node' ? process.execPath : name.includes('/') ? realpathSync(resolve(root, name)) : (process.env.PATH ?? '').split(delimiter).map(p => join(p, name)).find(p => existsSync(p));
      if (!program) return { ok: false, exitCode: null, reason: 'command-unavailable', output: '' };
      let bin: string, argv: string[];
      if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
        const runtime = dirname(realpathSync(process.execPath));
        const programDir = dirname(realpathSync(program));
        const allowed = ['/private/var/db/dyld', '/private/var/db/oah', realpathSync(root), realpathSync(temp), runtime, programDir];
        const outside = allowed.map(p => `(require-not (subpath ${JSON.stringify(p)}))`).join(' ');
        const readDenials = ['/Users', '/Volumes', '/private/var', '/private/tmp', '/home', '/root'].map(p => `(deny file-read-data (require-all (subpath ${JSON.stringify(p)}) ${outside}))`).join('');
        const profile = `(version 1)(allow default)(deny appleevent-send)(deny file-write* (require-all (require-not (subpath ${JSON.stringify(realpathSync(root))})) (require-not (subpath ${JSON.stringify(realpathSync(temp))})) (require-not (literal "/dev/null"))))${readDenials}${options.networkAllowed ? '' : '(deny network*)'}`;
        bin = '/usr/bin/sandbox-exec'; argv = ['-p', profile, program, ...command.argv.slice(1)];
      } else if (process.platform === 'linux' && existsSync('/usr/bin/bwrap')) {
        bin = '/usr/bin/bwrap'; argv = ['--die-with-parent', '--unshare-all', ...(options.networkAllowed ? ['--share-net'] : []), ...['/usr', '/bin', '/lib', '/lib64', '/etc'].filter(existsSync).flatMap(p => ['--ro-bind', p, p]), '--dev', '/dev', '--proc', '/proc', '--bind', root, root, '--bind', temp, temp, '--chdir', root, program, ...command.argv.slice(1)];
      } else return { ok: false, exitCode: null, reason: 'sandbox-unavailable', output: '' };
      return await new Promise<VerifierResult>(resolve => {
        let output = '', reason: string | undefined, timer: NodeJS.Timeout | undefined, killTimer: NodeJS.Timeout | undefined;
        const child = spawn(bin, argv, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: temp, TMPDIR: temp, CI: '1', NO_COLOR: '1', GOPROXY: options.networkAllowed ? 'https://proxy.golang.org' : 'off', GOSUMDB: 'off' } });
        const stop = (why: string) => { if (reason) return; reason = why; try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch {} killTimer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} }, 100); killTimer.unref(); };
        const abort = () => stop('aborted');
        const data = (chunk: Buffer) => { if (output.length < 65536) output += chunk.toString('utf8'); else stop('output-limit'); };
        child.stdout.on('data', data); child.stderr.on('data', data);
        child.once('error', () => { reason = 'spawn-failed'; });
        child.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(killTimer); options.signal.removeEventListener('abort', abort); resolve({ ok: !reason && code === 0 && (!command.emptyOutput || !output.trim()), exitCode: code, ...(reason || signal ? { reason: reason ?? `signal:${signal}` } : {}), output }); });
        timer = setTimeout(() => stop('timeout'), timeoutMs);
        if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
      });
    } catch { return { ok: false, exitCode: null, reason: 'verifier-unavailable', output: '' }; }
    finally { rmSync(temp, { recursive: true, force: true }); }
  } };
}
/** Repository-controlled diff/textconv/fsmonitor hooks must never execute on the host while fingerprinting. */
export const gitText = (root: string, args: string[]): string => execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.excludesFile=/dev/null', '-C', root, ...(args[0] === 'diff' ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' } });
