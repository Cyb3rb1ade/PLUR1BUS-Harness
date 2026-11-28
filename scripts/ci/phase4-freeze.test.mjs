import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVATION, GENERATED, checkCommits, collectCommits, frozenPackages, isFrozen, isGenerated, parseCorrections, parseTrailers, validateTrailer } from './phase4-freeze.mjs';

const PACKAGES = ['api', 'core', 'module-api', 'providers', 'rpc-schema', 'web'];
const AFTER = '2026-11-09T10:00:00+01:00';
const BEFORE = '2026-11-07T23:59:59Z';
const commit = (over = {}) => ({ sha: 'a'.repeat(40), authorDate: AFTER, message: 'fix(core): something\n', files: ['packages/core/src/core.ts'], ...over });

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
    // `generated` alone is only valid for generator outputs (next test), so it is paired with a frozen file that is one.
    const generated = form === 'generated';
    const files = generated ? ['packages/core/src/gen.ts', 'packages/core/src/core.ts'] : undefined;
    assert.deepEqual(check([commit({ message, ...(files && { files: [files[0]] }) })], generated ? { generated: [files[0]] } : {}), [], form);
  }
});

const DEFECT_PATHS = {
  'P4D-40': ['packages/core/src/a2a/client.ts', 'packages/core/src/composition/http.ts'],
  'P4D-43': ['packages/core/src/policy/paths.ts'],
  'P4D-44': ['packages/core/src/openai-auth/identity.ts'],
  'P4D-45': ['packages/core/src/auth/login.ts', 'packages/core/src/openai-auth/loopback.ts'],
};
const APPROVED_DEFECTS = new Map(Object.entries(DEFECT_PATHS).map(([id, paths]) => [id, new Set(paths)]));
const check = (commits, extra = {}) => checkCommits(commits, { packages: PACKAGES, approvedDefects: APPROVED_DEFECTS, ...extra });
const DEFECT = 'fix: fixture\n\nPhase4: defect P4D-43\n';
const DEFECT_FILE = DEFECT_PATHS['P4D-43'][0];

test('the four owner-approved defect trailers pass on their respective paths', () => {
  for (const [id, files] of Object.entries(DEFECT_PATHS)) {
    const trailer = `defect ${id}`;
    assert.equal(validateTrailer(trailer, APPROVED_DEFECTS), true);
    const message = `fix(core): fixture\n\nPhase4: ${trailer}\n`;
    assert.deepEqual(check([commit({ message, files })]), []);
    for (const file of files) {
      assert.deepEqual(check([commit({ message, files: [file, 'docs/phase4/defects.md'] })]), []);
    }
  }
});

test('a defect trailer refuses every frozen source path outside its approval', () => {
  for (const extra of [
    'packages/core/src/policy/paths-index.ts',
    'packages/core/src/openai-auth/identity.ts',
    'packages/providers/src/index.ts',
    'packages/removed-package/src/index.ts',
  ]) {
    const findings = check([commit({ message: DEFECT, files: [DEFECT_FILE, extra] })]);
    assert.equal(findings.length, 1, extra);
    assert.match(findings[0].reason, /P4D-43.*outside/);
    assert.deepEqual(findings[0].files, [extra]);
  }
});

test('a defect commit requires exactly one Phase4 line in the documented format', () => {
  for (const lines of [
    ['Phase4:defect P4D-43'],
    ['Phase4: defect P4D-43', 'Phase4: defect P4D-43'],
    ['Phase4: defect P4D-43', 'Phase4: defect P4D-44'],
    ['Phase4: vectors P4-02', 'Phase4: defect P4D-43'],
    ['Phase4: defect P4D-43', 'Phase4: generated'],
  ]) {
    const message = ['fix: fixture', '', ...lines, ''].join('\n');
    const findings = check([commit({ message, files: [DEFECT_FILE] })]);
    assert.equal(findings.length, 1, message);
    assert.match(findings[0].reason, /exactly one Phase4: defect P4D-43/);
  }
  const message = DEFECT.replaceAll('\n', '\r\n') + 'Co-Authored-By: Fixture <test@example.test>\r\n';
  assert.deepEqual(check([commit({ message, files: [DEFECT_FILE] })]), []);
});

test('even outside frozen source a defect declaration is checked and must cover frozen source', () => {
  for (const files of [
    [],
    ['docs/ci.md'],
    ['packages/core/test/core.test.ts'],
    ['packages/web/src/app.ts'],
    ['packages/core/src/generated.ts'],
  ]) {
    const options = { generated: ['packages/core/src/generated.ts'] };
    assert.match(check([commit({ message: DEFECT, files })], options)[0]?.reason ?? '', /requires a frozen source path/);
    assert.match(check([commit({ message: DEFECT.replace('P4D-43', 'P4D-46'), files })], options)[0]?.reason ?? '', /defect not approved/);
    assert.match(check([commit({ message: DEFECT.replace('defect P4D', 'defect  P4D'), files })], options)[0]?.reason ?? '', /malformed Phase4 trailer/);
    assert.deepEqual(check([commit({ message: 'x\n\nPhase4:generated\n', files })], options), []);
  }
});

test('an unapproved defect is reported even alongside an otherwise valid trailer', () => {
  const id = 'P4D-46';
  assert.equal(validateTrailer(`defect ${id}`, APPROVED_DEFECTS), false);
  const findings = check([commit({ message: `fix(core): something\n\nPhase4: vectors P4-02\nPhase4: defect ${id}\n` })]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].reason, /defect not approved: P4D-46/);
  assert.match(findings[0].expected, /defect <P4D-NN>/);
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

test('the generated trailer is no bypass: it is valid only when every frozen file is a generator output', () => {
  const only = commit({ message: 'regen\n\nPhase4: generated\n', files: ['packages/core/src/x.ts'] });
  const fail = check([only]);
  assert.equal(fail.length, 1);
  assert.match(fail[0].reason, /generated trailer, but these frozen files are not generator outputs/);
  assert.deepEqual(fail[0].files, ['packages/core/src/x.ts']);
  const list = ['packages/core/src/gen.ts', 'packages/rpc-schema/src/gen/'];
  const mixed = commit({ message: 'regen\n\nPhase4: generated\n', files: ['packages/core/src/gen.ts', 'packages/rpc-schema/src/gen/a.ts', 'packages/core/src/x.ts'] });
  assert.deepEqual(check([mixed], { generated: list })[0].files, ['packages/core/src/x.ts']);
  assert.deepEqual(check([{ ...mixed, files: mixed.files.slice(0, 2) }], { generated: list }), [], 'only generator outputs');
  assert.deepEqual(check([commit({ message: 'x\n\nPhase4: generated\nPhase4: seam P4-10\n', files: ['packages/core/src/x.ts'] })]), [], 'another valid value justifies the commit');
  assert.deepEqual(check([commit({ message: 'x\n\nPhase4: running-work RY\nPhase4: generated\n', files: ['packages/core/src/x.ts'] })]), []);
});

test('malformed trailers fail', () => {
  const bad = ['seam', 'seam P4-1', 'seam P4-100', 'seam P4-10ab', 'seam P4-10A', 'seam p4-10', 'seam RE-1', 'seam RE-10/T', 'seam RE-10/3',
    'seam RE-10/T3/T4', 'cut', 'vectors WP', 'running-work', 'running-work TX', 'running-work tk', 'running-work TK LP', 'generated yes',
    'refactor P4-10', 'seam P4-10 extra', '', 'seam  P4-10', 'defect', 'defect P4-40', 'defect P4D-040', 'defect P4D-40 extra'];
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

const MISTYPED = 'feat: x\n\nPhase4: running-work\n';
const correction = (over = {}) => ({ sha: 'a'.repeat(40), trailer: 'running-work RY', reason: 'the package letters were left out', ...over });

test('a recorded correction stands in for the Phase4 lines of exactly that commit', () => {
  const mistyped = commit({ message: MISTYPED });
  assert.match(check([mistyped])[0].reason, /malformed/, 'without a correction the commit fails');
  const corrections = parseCorrections([correction()]);
  assert.deepEqual(check([mistyped], { corrections }), []);
  assert.deepEqual(check([commit({ message: 'feat: no trailer at all\n' })], { corrections }), [], 'a missing line is corrected the same way');
  const other = commit({ sha: 'b'.repeat(40), message: MISTYPED });
  assert.deepEqual(check([mistyped, other], { corrections }).map(f => f.sha), ['b'.repeat(40)], 'another commit with the same message still fails');
});

test('a corrected commit is judged like any other: generated still has to match the files', () => {
  const corrections = parseCorrections([correction({ trailer: 'generated' })]);
  const findings = check([commit({ message: MISTYPED })], { corrections });
  assert.equal(findings.length, 1);
  assert.match(findings[0].reason, /not generator outputs/);
  assert.deepEqual(check([commit({ message: MISTYPED, files: ['packages/core/src/gen.ts'] })], { corrections, generated: ['packages/core/src/gen.ts'] }), []);
});

test('the correction list accepts only full commit ids, plain work trailers and a reason', () => {
  assert.deepEqual([...parseCorrections([correction(), correction({ sha: 'b'.repeat(40), trailer: 'seam RE-10/T3' })])],
    [['a'.repeat(40), 'running-work RY'], ['b'.repeat(40), 'seam RE-10/T3']]);
  assert.equal(parseCorrections([]).size, 0);
  const bad = [{}, null, 'x', [correction({ sha: 'a'.repeat(39) })], [correction({ sha: 'A'.repeat(40) })], [correction({ sha: `${'a'.repeat(40)} ` })],
    [correction({ sha: undefined })], [correction({ trailer: 'running-work' })], [correction({ trailer: 'defect P4D-43' })],
    [correction({ trailer: 'Phase4: running-work RY' })], [correction({ trailer: undefined })], [correction({ reason: ' ' })],
    [correction({ reason: undefined })], [correction(), correction()], [null], ['x'], [[]], [correction({ paths: ['packages/core/src/core.ts'] })]];
  for (const entries of bad) assert.throws(() => parseCorrections(entries), /phase4-trailer-corrections\.json/, JSON.stringify(entries));
});

// The list is judged from the PR base, so the pull request that changes it is not checked against it by the guard.
// This test is what keeps a list the guard cannot read out of the base, where it would fail every pull request.
test('the shipped correction list parses', () => {
  const shipped = JSON.parse(readFileSync(new URL('./phase4-trailer-corrections.json', import.meta.url), 'utf8'));
  assert.equal(parseCorrections(shipped).get('0e79cff1c483f9d46c2381a48d1d9c55a62df963'), 'running-work RY');
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

function runGuard(cwd, args, env = {}) {
  const script = new URL('./phase4-freeze.mjs', import.meta.url);
  try {
    return { code: 0, out: execFileSync(process.execPath, [fileURLToPath(script), ...args], {
      cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, BASE_SHA: '', HEAD_SHA: '', ...env },
    }) };
  } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
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
  const run = (args, env) => runGuard(r.dir, args, env);
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

const EXCEPTION_FILE = 'scripts/ci/phase4-freeze-exceptions.json';

test('the command line rejects a defect approved only on the PR branch', () => {
  const r = repo();
  try {
    r.put(DEFECT_FILE, 'base');
    const withoutList = r.save('base without exception list', BEFORE);
    r.put(EXCEPTION_FILE, JSON.stringify([{ id: 'P4D-40', paths: DEFECT_PATHS['P4D-40'] }]));
    const withoutDefect = r.save('base with only another approval', AFTER);
    r.put(EXCEPTION_FILE, JSON.stringify([{ id: 'P4D-43', paths: [DEFECT_FILE] }]));
    r.save('PR updates the exception list', AFTER);
    r.put(DEFECT_FILE, 'modified');
    const head = r.save(DEFECT, AFTER);

    for (const base of [withoutList, withoutDefect]) {
      const result = runGuard(r.dir, ['--base', base, '--head', head]);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /defect not approved: P4D-43/);
    }
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('the command line accepts a defect approved on the base branch', () => {
  const r = repo();
  try {
    r.put(DEFECT_FILE, 'base');
    r.put(EXCEPTION_FILE, JSON.stringify([{ id: 'P4D-49', paths: [DEFECT_FILE] }]));
    const base = r.save('approve fixture defect on base', BEFORE);
    r.git(['rm', EXCEPTION_FILE]);
    r.put(DEFECT_FILE, 'modified');
    const head = r.save('fix: fixture\n\nPhase4: defect P4D-49', AFTER);

    const result = runGuard(r.dir, [], { BASE_SHA: base, HEAD_SHA: head });
    assert.equal(result.code, 0, result.out);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

const CORRECTION_FILE = 'scripts/ci/phase4-trailer-corrections.json';

// The pull request carries a pushed commit with a mistyped line. Only the base may say what the line should have been.
function mistypedBranch() {
  const r = repo();
  // The base already has a list, for some other commit: the guard must read that one, not the one in the checkout.
  r.put(CORRECTION_FILE, JSON.stringify([correction({ sha: 'f'.repeat(40) })]));
  r.put('packages/core/src/core.ts', 'a');
  const base = r.save('base', BEFORE);
  r.git(['checkout', '-q', '-b', 'pr']);
  r.put('packages/core/src/core.ts', 'b');
  const mistyped = r.save(MISTYPED, AFTER);
  return { ...r, base, mistyped };
}

test('the command line rejects a correction recorded only on the PR branch', () => {
  const r = mistypedBranch();
  try {
    r.put(CORRECTION_FILE, JSON.stringify([correction({ sha: 'f'.repeat(40) }), correction({ sha: r.mistyped })]));
    const head = r.save('PR corrects its own commit', AFTER);
    const result = runGuard(r.dir, ['--base', r.base, '--head', head]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /malformed Phase4 trailer: "running-work"/);
    assert(result.out.includes(r.mistyped), 'names the commit');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('the command line accepts a correction recorded on the base branch, for that commit only', () => {
  const r = mistypedBranch();
  try {
    r.put('packages/core/src/core.ts', 'c');
    const second = r.save(MISTYPED, AFTER);
    r.git(['checkout', '-q', 'main']);
    r.put(CORRECTION_FILE, JSON.stringify([correction({ sha: r.mistyped })]));
    const corrected = r.save('record the correction on the base', AFTER);

    const result = runGuard(r.dir, [], { BASE_SHA: corrected, HEAD_SHA: r.mistyped });
    assert.equal(result.code, 0, result.out);
    const next = runGuard(r.dir, [], { BASE_SHA: corrected, HEAD_SHA: second });
    assert.equal(next.code, 1, next.out);
    assert(next.out.includes(second) && !next.out.includes(r.mistyped), 'only the commit without a correction is reported');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('the command line fails closed on a correction list it cannot accept', () => {
  // The head commit is fine on its own, so only the list can fail the run.
  const r = repo();
  try {
    r.put('packages/core/src/core.ts', 'a');
    const start = r.save('base', BEFORE);
    r.git(['checkout', '-q', '-b', 'pr']);
    r.put('packages/core/src/core.ts', 'b');
    const head = r.save('feat: x\n\nPhase4: running-work RY\n', AFTER);
    assert.equal(runGuard(r.dir, ['--base', start, '--head', head]).code, 0);
    r.git(['checkout', '-q', 'main']);
    const refused = (base, label) => {
      const result = runGuard(r.dir, ['--base', base, '--head', head]);
      assert.equal(result.code, 1, `${label}\n${result.out}`);
      assert.match(result.out, /^phase4-freeze: scripts\/ci\/phase4-trailer-corrections\.json: /m, label);
      assert.doesNotMatch(result.out, /violate/);
    };
    for (const text of ['{', `\uFEFF${JSON.stringify([correction()])}`, JSON.stringify([correction({ trailer: 'defect P4D-43' })]), JSON.stringify({ ['a'.repeat(40)]: 'running-work RY' })]) {
      r.put(CORRECTION_FILE, text);
      refused(r.save('a broken correction list', AFTER), text);
    }
    r.git(['rm', '-q', CORRECTION_FILE]);
    r.put(`${CORRECTION_FILE}/list.json`, JSON.stringify([correction()]));
    refused(r.save('a directory in place of the list', AFTER), 'directory');
    // A symbolic link is stored as its target text. `[]` would read as an empty list if the guard took it for the file.
    r.git(['rm', '-rq', CORRECTION_FILE]);
    let linked = true;
    mkdirSync(dirname(join(r.dir, CORRECTION_FILE)), { recursive: true });
    try { symlinkSync('[]', join(r.dir, CORRECTION_FILE)); }
    catch (error) { if (error.code !== 'EPERM') throw error; linked = false; } // Windows without the symlink right
    if (linked) refused(r.save('a symbolic link in place of the list', AFTER), 'symlink');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
