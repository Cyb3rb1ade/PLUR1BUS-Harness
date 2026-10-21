import { spawn } from 'node:child_process';
import { which, createNodeHostContext } from '../../core/src/host-tools/index.ts';
const BATCH_BUDGET_MS = 10_000, BATCH_OUTPUT_CAP = 1 << 20;
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
  },
  /**
   * Which of many verified texts contain the literal, in one ripgrep start instead of one per text. The texts go over stdin as NUL-separated
   * records (a decoded text never holds NUL, so a match cannot straddle two of them) and ripgrep reports
   * the 1-based number of every record that matched. A literal with `\r` or `\n` never goes to ripgrep, as in `matches` (docs/hostctl.md).
   * Anything unexpected (no ripgrep, a literal ripgrep cannot be given, exit code 2, output
   * beyond the cap, an index out of range, the time budget) is answered by the same plain substring test, so the result never depends on
   * the backend.
   */
  async matchMany(texts: readonly string[], query: string, signal: AbortSignal): Promise<boolean[]> {
    signal.throwIfAborted();
    const plain = () => texts.map(text => text.includes(query));
    if (!program || texts.length === 0 || query === '' || query.includes('\0') || /[\r\n]/.test(query) || !query.isWellFormed() || texts.some(text => text.includes('\0'))) return plain();
    return new Promise((resolve, reject) => {
      const child = spawn(program, ['--no-config', '--null-data', '--fixed-strings', '--line-number', '--only-matching', '--no-filename', '--color', 'never', '--', query], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const chunks: Buffer[] = []; let size = 0, settled = false;
      const abort = () => { child.kill(); settle(() => reject(signal.reason)); };
      const timer = setTimeout(() => { child.kill(); settle(() => resolve(plain())); }, BATCH_BUDGET_MS); timer.unref();
      const settle = (done: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); done(); };
      child.stdout!.on('data', (chunk: Buffer) => { size += chunk.length; if (size > BATCH_OUTPUT_CAP) { child.kill(); settle(() => resolve(plain())); } else chunks.push(chunk); });
      child.once('error', () => settle(() => resolve(plain())));
      child.once('close', code => settle(() => {
        if (code === 1) return resolve(texts.map(() => false));
        if (code !== 0) return resolve(plain());
        const hits = texts.map(() => false); let found = 0;
        for (const record of Buffer.concat(chunks).toString('utf8').split('\0')) {
          const m = /^(\d+):/.exec(record); if (!m) continue;
          const index = Number(m[1]) - 1; if (!(index >= 0 && index < texts.length)) return resolve(plain());
          hits[index] = true; found++;
        }
        resolve(found > 0 ? hits : plain());
      }));
      child.stdin!.on('error', () => {}); signal.addEventListener('abort', abort, { once: true }); child.stdin!.end(texts.join('\0')); if (signal.aborted) abort();
    });
  } };
}
