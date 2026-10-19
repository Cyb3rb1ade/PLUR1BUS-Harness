import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** Unified diff suitable for copying from CI; normalize only checkout line endings. */
export function docDiff(path, current, expected) {
  const lf = text => text.replace(/\r\n/g, '\n');
  if (lf(current) === lf(expected)) return '';
  const dir = mkdtempSync(join(tmpdir(), 'p1b-doc-diff-'));
  try {
    const before = join(dir, 'before'), after = join(dir, 'after');
    writeFileSync(before, lf(current)); writeFileSync(after, lf(expected));
    const diff = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', before, after], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const hunk = diff.stdout?.indexOf('@@');
    if (diff.status === 1 && hunk >= 0) return `--- a/${path}\n+++ b/${path}\n${diff.stdout.slice(hunk)}`;
    return `Expected contents of ${path}:\n${lf(expected)}`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
