import { spawn } from 'node:child_process';
import { which, createNodeHostContext } from '../../core/src/host-tools/index.ts';
/** Feed already verified, bounded text over stdin: rg never opens caller paths or follows links. */
export async function textMatcher() {
  const program = await which(createNodeHostContext(), 'rg');
  return { backend: program ? 'ripgrep-verified-stdin' : 'bounded-js', async matches(text: string, query: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted(); if (!program || /[\r\n]/.test(query)) return text.includes(query); // ripgrep reads line by line: a literal that spans lines can only be found here
    return new Promise((resolve, reject) => {
      const child = spawn(program, ['--quiet', '--fixed-strings', '--', query], { shell: false, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      const abort = () => { child.kill(); reject(signal.reason); }; const timer = setTimeout(() => { child.kill(); resolve(text.includes(query)); }, 5000); timer.unref();
      const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      child.once('error', () => { clean(); resolve(text.includes(query)); }); child.once('close', code => { clean(); resolve(code === 0); });
      child.stdin.on('error', () => {}); signal.addEventListener('abort', abort, { once: true }); child.stdin.end(text); if (signal.aborted) abort();
    });
  } };
}
/**
 * Which of many already verified texts contain the literal: a plain, case-sensitive substring test in this process, one answer per text in input order.
 * The texts are in memory already, so a child process would only add a start, a copy of every byte and a parser (measured on 32 MiB: ripgrep
 * 96-198 ms, `includes` 1-31 ms). The literal is never a pattern and never leaves this process; `\r`, `\n`, NUL and lone surrogates are matched
 * by code unit like any other character. The signal is honoured before every text, so a long batch stops promptly.
 */
export async function matchMany(texts: readonly string[], query: string, signal: AbortSignal): Promise<boolean[]> {
  signal.throwIfAborted();
  const hits: boolean[] = [];
  for (const text of texts) { signal.throwIfAborted(); hits.push(text.includes(query)); }
  return hits;
}
