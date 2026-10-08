import { execFileSync } from 'node:child_process';
import { REPO } from './common.mjs';
const [from, to = 'HEAD', title = to] = process.argv.slice(2);
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
for (const ref of [from, to].filter(r => r && r !== "--initial")) git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
const range = from && from !== '--initial' ? `${from}..${to}` : to;
const groups = new Map();
for (const entry of git(['log', '--format=%h%x09%s', '--reverse', range, '--']).split('\n')) {
  const [hash, subject] = entry.split('\t');
  const m = /^(\w+)(?:\([^)]+\))?(!)?:\s+(.+)$/.exec(subject ?? '');
  if (!m) continue;
  const heading = m[2] ? 'Breaking changes' : ({ feat: 'Features', fix: 'Fixes', perf: 'Performance', docs: 'Documentation', ci: 'CI', build: 'Build' }[m[1]] ?? 'Maintenance');
  const text = m[3].replace(/#(\d+)/g, `[#\$1](https://github.com/${REPO}/pull/\$1)`);
  if (!groups.has(heading)) groups.set(heading, []);
  groups.get(heading).push(`- ${text} (${hash})`);
}
console.log(`## ${title}\n\n${[...groups].map(([name, rows]) => `### ${name}\n\n${rows.join('\n')}`).join('\n\n')}`);
