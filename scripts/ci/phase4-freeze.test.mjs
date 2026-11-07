import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ACTIVATION, GENERATED, checkCommits, collectCommits, frozenPackages, isFrozen, isGenerated, parseTrailers, validateTrailer } from './phase4-freeze.mjs';

const PACKAGES = ['api', 'core', 'module-api', 'providers', 'rpc-schema', 'web'];
const AFTER = '2026-11-09T10:00:00+01:00';
const BEFORE = '2026-11-07T23:59:59Z';
const commit = (over = {}) => ({ sha: 'a'.repeat(40), authorDate: AFTER, message: 'fix(core): something\n', files: ['packages/core/src/core.ts'], ...over });
const check = (commits, extra = {}) => checkCommits(commits, { packages: PACKAGES, ...extra });

test('the frozen set is every packages/* directory except web, so a new package is frozen by default', () => {
  const dirs = [{ name: 'core', isDirectory: () => true }, { name: 'web', isDirectory: () => true },
    { name: 'brand-new', isDirectory: () => true }, { name: 'README.md', isDirectory: () => false }];
  assert.deepEqual(frozenPackages(dirs), ['brand-new', 'core']);
  assert(isFrozen('packages/brand-new/src/x.ts', ['brand-new']));
  assert(isFrozen('packages/core/src/rpc/server.ts', PACKAGES));
  assert(!isFrozen('packages/web/src/app.ts', PACKAGES));
  assert(!isFrozen('apps/desktop/ui/src/main.ts', PACKAGES));
  assert(!isFrozen('packages/core/test/core.test.ts', PACKAGES), 'only src/ is frozen');
  assert(!isFrozen('packages/core/package.json', PACKAGES));
  assert(!isFrozen('packages/core/srcs/x.ts', PACKAGES));
  assert(!isFrozen('crates/plur1bus-core/src/lib.rs', PACKAGES));
});

test('the activation date is the one the owner set', () => {
  assert.equal(ACTIVATION.toISOString(), '2026-11-08T00:00:00.000Z');
});

test('a commit without a trailer that touches packages/core/src fails and names commit, file and the expected trailer', () => {
  const findings = check([commit()]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sha, 'a'.repeat(40));
  assert.deepEqual(findings[0].files, ['packages/core/src/core.ts']);
  assert.match(findings[0].reason, /missing/);
  assert.match(findings[0].expected, /Phase4: (seam|cut|vectors) <WP>/);
  assert.match(findings[0].expected, /running-work <TK\|LP\|RX\|RY>/);
});

test('every allowed trailer form passes', () => {
  const forms = ['seam P4-10', 'cut P4-43', 'vectors P4-02', 'seam P4-12a', 'cut RE-10', 'vectors RE-10/T3', 'seam RE-09/T12b',
    'running-work TK', 'running-work LP', 'running-work RX', 'running-work RY', 'generated'];
  for (const form of forms) {
    const message = `fix: x\n\nbody text\n\nPhase4: ${form}\nCo-Authored-By: someone <a@example.test>\n`;
    assert.deepEqual(check([commit({ message })]), [], form);
  }
});

test('a commit before the activation date passes without a trailer, one at the boundary does not', () => {
  assert.deepEqual(check([commit({ authorDate: BEFORE })]), []);
  assert.deepEqual(check([commit({ authorDate: '2026-11-08T00:59:59+01:00' })]), [], '23:59:59Z is still before');
  assert.equal(check([commit({ authorDate: '2026-11-08T00:00:00Z' })]).length, 1);
  assert.equal(check([commit({ authorDate: 'not a date' })]).length, 1, 'an unparsable date fails closed');
});

test('UI-only and non-frozen changes pass without a trailer', () => {
  const files = ['packages/web/src/app.ts', 'apps/desktop/ui/src/main.ts', 'packages/core/test/core.test.ts', 'docs/ci.md', 'crates/plur1bus/src/main.rs'];
  assert.deepEqual(check([commit({ files })]), []);
  assert.deepEqual(check([commit({ files: [] })]), []);
});

test('generated files are exempt, but a frozen file next to them still needs the trailer', () => {
  const list = ['packages/rpc-schema/src/generated-shim.ts'];
  assert(isGenerated('packages/rpc-schema/generated/types.ts'));
  assert(isGenerated('packages/rpc-schema/generated/names.json'));
  assert(isGenerated('packages/web/src/palette/settings-index.ts'));
  assert(!isGenerated('packages/rpc-schema/src/build.mjs'));
  assert(GENERATED.length > 0);
  assert.deepEqual(check([commit({ files: list })], { generated: list }), []);
  assert.equal(check([commit({ files: [...list, 'packages/core/src/core.ts'] })], { generated: list }).length, 1);
  const findings = check([commit({ files: [...list, 'packages/core/src/core.ts'] })], { generated: list });
  assert.deepEqual(findings[0].files, ['packages/core/src/core.ts'], 'only the non-generated file is listed');
});

test('malformed trailers fail', () => {
  const bad = ['seam', 'seam P4-1', 'seam P4-100', 'seam P4-10ab', 'seam P4-10A', 'seam p4-10', 'seam RE-1', 'seam RE-10/T', 'seam RE-10/3',
    'seam RE-10/T3/T4', 'cut', 'vectors WP', 'running-work', 'running-work TX', 'running-work tk', 'running-work TK LP', 'generated yes',
    'refactor P4-10', 'seam P4-10 extra', '', 'seam  P4-10'];
  for (const form of bad) {
    const findings = check([commit({ message: `fix: x\n\nPhase4: ${form}\n` })]);
    assert.equal(findings.length, 1, `[${form}]`);
    assert.match(findings[0].reason, /malformed/, `[${form}]`);
  }
});

test('one valid trailer does not excuse a malformed one, and the key is matched exactly', () => {
  assert.equal(check([commit({ message: 'x\n\nPhase4: seam P4-10\nPhase4: seam nope\n' })]).length, 1);
  assert.deepEqual(check([commit({ message: 'x\n\nPhase4: seam P4-10\nPhase4: generated\n' })]), []);
  assert.equal(check([commit({ message: 'x\n\nphase4: seam P4-10\n' })]).length, 1, 'lower-case key is not the trailer');
  assert.equal(check([commit({ message: 'x\n\nPhase 4: seam P4-10\n' })]).length, 1);
  assert.equal(check([commit({ message: 'x\n\nPhase4 seam P4-10\n' })]).length, 1);
});

test('each commit is judged on its own', () => {
  const ok = commit({ sha: '1'.repeat(40), message: 'a\n\nPhase4: cut P4-43\n' });
  const bad = commit({ sha: '2'.repeat(40), message: 'b\n' });
  const findings = check([ok, bad]);
  assert.deepEqual(findings.map(f => f.sha), ['2'.repeat(40)]);
});

test('parseTrailers and validateTrailer', () => {
  assert.deepEqual(parseTrailers('x\n\nPhase4: seam P4-10\nPhase4:generated\nOther: y\r\n'), ['seam P4-10', 'generated']);
  assert.deepEqual(parseTrailers('no trailer\n'), []);
  assert.equal(validateTrailer('vectors RE-10/T3b'), true);
  assert.equal(validateTrailer('seam P4-10 '), false);
});

// A real repository: the range is base..head, merge commits are skipped, renames count on both sides.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'phase4-freeze-'));
  const git = (args, env = {}) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  git(['init', '-q', '-b', 'main']);
  const put = (path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  const save = (message, date, ...paths) => {
    git(['add', '-A']);
    git(['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: AFTER });
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, git, put, save };
}

test('collectCommits and the check agree on a real range', () => {
  const r = repo();
  try {
    r.put('packages/core/src/core.ts', 'a');
    const base = r.save('base', BEFORE);
    r.put('packages/core/src/core.ts', 'b');
    const bare = r.save('fix core without trailer', AFTER);
    r.put('packages/web/src/app.ts', 'ui');
    r.save('ui only', AFTER);
    r.put('packages/api/src/routes.ts', 'c');
    const tagged = r.save('cut api\n\nPhase4: cut P4-43', AFTER);
    r.put('packages/core/src/old.ts', 'd');
    r.save('old but rebased\n', BEFORE);
    const head = r.git(['rev-parse', 'HEAD']);
    const commits = collectCommits({ base, head, cwd: r.dir });
    assert.equal(commits.length, 4);
    assert(commits.some(c => c.sha === tagged));
    const findings = checkCommits(commits, { packages: ['api', 'core'] });
    assert.deepEqual(findings.map(f => f.sha), [bare]);
    assert.deepEqual(findings[0].files, ['packages/core/src/core.ts']);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('a commit that only moves a frozen file is caught on both sides of the rename', () => {
  const r = repo();
  try {
    r.put('packages/core/src/a.ts', 'same content, long enough to be detected as a rename');
    const base = r.save('base', BEFORE);
    mkdirSync(join(r.dir, 'docs'));
    r.git(['mv', 'packages/core/src/a.ts', 'docs/a.ts']);
    r.save('move out', AFTER);
    const commits = collectCommits({ base, head: 'HEAD', cwd: r.dir });
    assert.deepEqual(commits[0].files, ['docs/a.ts', 'packages/core/src/a.ts']);
    assert.equal(checkCommits(commits, { packages: ['core'] }).length, 1);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('merge commits are not judged, and commits merged in from the base are not in the range', () => {
  const r = repo();
  try {
    r.put('packages/core/src/core.ts', 'a');
    r.save('base', BEFORE);
    r.git(['checkout', '-q', '-b', 'pr']);
    r.put('docs/x.md', 'pr work');
    r.save('docs', AFTER);
    r.git(['checkout', '-q', 'main']);
    r.put('packages/core/src/core.ts', 'main moved');
    const mainTip = r.save('main fix without trailer', AFTER);
    r.git(['checkout', '-q', 'pr']);
    r.git(['merge', '-q', '--no-ff', '-m', 'merge main', 'main'], { GIT_AUTHOR_DATE: AFTER, GIT_COMMITTER_DATE: AFTER });
    const commits = collectCommits({ base: mainTip, head: 'HEAD', cwd: r.dir });
    assert.deepEqual(commits.map(c => c.message.trim()), ['docs']);
    assert.deepEqual(checkCommits(commits, { packages: ['core'] }), []);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('the command line: exit 1 with a readable message on a violation, exit 0 otherwise or without a range', () => {
  const r = repo();
  const script = new URL('./phase4-freeze.mjs', import.meta.url).pathname;
  const run = (args, env = {}) => {
    try {
      return { code: 0, out: execFileSync('node', [script, ...args], { cwd: r.dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, BASE_SHA: '', HEAD_SHA: '', ...env } }) };
    } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
  };
  try {
    r.put('packages/core/src/core.ts', 'a');
    const base = r.save('base', BEFORE);
    r.put('packages/core/src/core.ts', 'b');
    const bad = r.save('fix core', AFTER);
    const failed = run(['--base', base, '--head', 'HEAD']);
    assert.equal(failed.code, 1);
    assert(failed.out.includes(bad), 'names the commit');
    assert(failed.out.includes('packages/core/src/core.ts'), 'names the file');
    assert(failed.out.includes('Phase4:'), 'names the trailer');
    assert.equal(run([], { BASE_SHA: base, HEAD_SHA: bad }).code, 1, 'env works like the args');
    assert.equal(run(['--base', bad, '--head', 'HEAD']).code, 0, 'empty range');
    const none = run([]);
    assert.equal(none.code, 0);
    assert.match(none.out, /no commit range/);
    assert.equal(run(['--base', 'does-not-exist', '--head', 'HEAD']).code, 1, 'an unresolvable range fails closed');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
