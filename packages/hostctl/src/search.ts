import { spawn } from 'node:child_process';
import { which, createNodeHostContext } from '../../core/src/host-tools/index.ts';
/** Feed already verified, bounded text over stdin: rg never opens caller paths or follows links. */
export async function textMatcher() {
  const program = await which(createNodeHostContext(), 'rg');
  return { backend: program ? 'ripgrep-verified-stdin' : 'bounded-js', async matches(text: string, query: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted(); if (!program) return text.includes(query);
    return new Promise((resolve, reject) => {
      const child = spawn(program, ['--quiet', '--fixed-strings', '--', query], { shell: false, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      const abort = () => { child.kill(); reject(signal.reason); }; const timer = setTimeout(() => { child.kill(); resolve(text.includes(query)); }, 5000); timer.unref();
      const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      child.once('error', () => { clean(); resolve(text.includes(query)); }); child.once('close', code => { clean(); resolve(code === 0); });
      child.stdin.on('error', () => {}); signal.addEventListener('abort', abort, { once: true }); child.stdin.end(text); if (signal.aborted) abort();
    });
  } };
}
