#!/usr/bin/env node
// Phase 4 freeze guard (D129, ADR-019). The TypeScript core is frozen while it moves to Rust: a commit that changes
// `src/` of a non-UI TypeScript package must say why with a `Phase4: <kind> <arg>` trailer. The PR base records approved TypeScript fixes.
//
//   Phase4: seam <WP> | cut <WP> | vectors <WP> | running-work <TK|LP|RX|RY> | generated | defect <P4D-NN>
//
// <WP> is `P4-\d\d[a-z]?` or `RE-\d\d(/T\d+[a-z]?)?`. The range is BASE_SHA..HEAD_SHA (env, as `changes.mjs` gets it) or
// `--base X --head Y`; without a range (push, schedule) there is nothing to judge and the script exits 0.
import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Commits authored before this instant are not judged, so PRs that were open when the guard landed keep passing.
// The author date survives a rebase, the committer date does not.
export const ACTIVATION = new Date('2026-11-08T00:00:00Z');

// `packages/web` is the UI and stays TypeScript. Every other `packages/*` is frozen, a new one by default.
export const UI_PACKAGES = ['web'];

// Outputs of `pnpm gen`, listed explicitly (a trailing slash is a directory). A change to one is the regeneration after a
// schema change, never a hand edit. Today none of them lives under a frozen `src/`; the list is here so that a generator
// that starts writing into `src/` is exempted by naming it, not by loosening the rule.
export const GENERATED = [
  'packages/rpc-schema/generated/', // src/build.mjs: types.ts, names.json
  'packages/rpc-schema/fixtures/capabilities/', // src/build.mjs: one file per x-server
  'packages/config-schema/fixtures/', // src/gen-defaults.mjs
  'packages/log-schema/fixtures/vectors.json', // src/gen-fixtures.mjs
  'packages/providers/fixtures/cache-profile-vectors.json', // src/cache-profile-vectors.ts
  'packages/web/src/palette/settings-index.ts', // scripts/gen-settings-index.mjs (UI, not frozen anyway)
];

const WP = String.raw`(?:P4-\d\d[a-z]?|RE-\d\d(?:/T\d+[a-z]?)?)`;
const TRAILER = new RegExp(String.raw`^(?:(?:seam|cut|vectors) ${WP}|running-work (?:TK|LP|RX|RY)|generated)$`);
const DEFECT_TRAILER = /^defect (P4D-\d{2})$/;
const EXCEPTION_FILE = 'scripts/ci/phase4-freeze-exceptions.json';
const NO_APPROVED_DEFECTS = new Map();
export const EXPECTED = 'Phase4: seam <WP> | cut <WP> | vectors <WP> | running-work <TK|LP|RX|RY> | generated | defect <P4D-NN>   (<WP> = P4-NN[a], RE-NN or RE-NN/TN[a]; defects must be approved in phase4-freeze-exceptions.json on the PR base)';

export function frozenPackages(entries) {
  return entries.filter(e => e.isDirectory() && !UI_PACKAGES.includes(e.name)).map(e => e.name).sort();
}

export const isFrozen = (path, packages) => {
  const m = /^packages\/([^/]+)\/src\//.exec(path);
  return m !== null && (packages === undefined || packages.includes(m[1])) && !UI_PACKAGES.includes(m[1]);
};

export const isGenerated = (path, list = GENERATED) => list.some(g => (g.endsWith('/') ? path.startsWith(g) : path === g));

const trailerLines = message => message.split(/\r?\n/).filter(line => line.startsWith('Phase4:'));
const trailerValue = line => line.slice('Phase4:'.length).replace(/^ /, '');

// Values of every `Phase4:` line (key matched exactly) in the message.
export function parseTrailers(message) {
  return trailerLines(message).map(trailerValue);
}

const defectId = value => DEFECT_TRAILER.exec(value)?.[1];

export const validateTrailer = (value, approvedDefects = NO_APPROVED_DEFECTS) => TRAILER.test(value) || approvedDefects.has(defectId(value));

export function checkCommits(commits, { packages, generated = GENERATED, activation = ACTIVATION, approvedDefects = NO_APPROVED_DEFECTS } = {}) {
  const findings = [];
  for (const c of commits) {
    const time = Date.parse(c.authorDate);
    if (Number.isFinite(time) && time < activation.getTime()) continue; // unparsable dates fail closed, they are judged
    const lines = trailerLines(c.message);
    const values = lines.map(trailerValue);
    const declaresDefect = values.some(value => /^\s*defect\b/.test(value));
    // Judge the paths in a defect commit even when the package was removed from the head tree.
    const files = c.files.filter(f => isFrozen(f, declaresDefect ? undefined : packages) && !isGenerated(f, generated)).sort();
    if (!files.length && !declaresDefect) continue;
    if (!values.length) {
      findings.push({ sha: c.sha, files, reason: 'missing Phase4 trailer', expected: EXPECTED });
      continue;
    }
    const bad = values.filter(v => !validateTrailer(v, approvedDefects));
    if (bad.length) {
      const unapproved = bad.map(defectId).filter(id => id !== undefined);
      const reason = unapproved.length
        ? `defect not approved: ${unapproved.join(', ')} (see phase4-freeze-exceptions.json on the PR base)`
        : `malformed Phase4 trailer: ${bad.map(v => JSON.stringify(v)).join(', ')}`;
      findings.push({ sha: c.sha, files, reason, expected: EXPECTED });
      continue;
    }

    const defect = values.map(defectId).find(id => id !== undefined);
    if (defect !== undefined) {
      const exact = `Phase4: defect ${defect}`;
      if (lines.length !== 1 || lines[0] !== exact) {
        findings.push({ sha: c.sha, files, reason: `expected exactly one ${exact} trailer`, expected: EXPECTED });
        continue;
      }
      if (!files.length) {
        findings.push({ sha: c.sha, files, reason: `defect ${defect} requires a frozen source path`, expected: EXPECTED });
        continue;
      }
      const approved = approvedDefects.get(defect);
      const outside = files.filter(f => !approved.has(f));
      if (outside.length) findings.push({ sha: c.sha, files: outside, reason: `defect ${defect} changes frozen files outside its approved paths`, expected: EXPECTED });
      continue;
    }

    // `generated` alone is no bypass: the generated files are already filtered out, so any frozen file left is hand-written.
    if (values.every(v => v === 'generated')) findings.push({ sha: c.sha, files, reason: 'generated trailer, but these frozen files are not generator outputs', expected: EXPECTED });
  }
  return findings;
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function readApprovedDefects(cwd, baseCommit) {
  // An absent path yields empty output. Git and JSON errors fail the check.
  if (!git(cwd, ['ls-tree', '--full-tree', baseCommit, '--', EXCEPTION_FILE])) return NO_APPROVED_DEFECTS;
  const entries = JSON.parse(git(cwd, ['show', `${baseCommit}:${EXCEPTION_FILE}`]));
  return new Map(entries.map(({ id, paths }) => [id, new Set(paths)]));
}

// Non-merge commits reachable from head and not from base, oldest first. Renames count on both sides (`--no-renames`).
export function collectCommits({ base, head, cwd = process.cwd() }) {
  const shas = git(cwd, ['rev-list', '--no-merges', '--reverse', head, '--not', base]).split('\n').filter(Boolean);
  return shas.map(sha => {
    const authorDate = git(cwd, ['show', '-s', '--format=%aI', sha]).trim();
    const message = git(cwd, ['show', '-s', '--format=%B', sha]);
    const files = git(cwd, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '--no-renames', '-z', sha]).split('\0').filter(Boolean);
    return { sha, authorDate, message, files };
  });
}

function range(argv, env) {
  const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  return { base: arg('--base') || env.BASE_SHA || '', head: arg('--head') || env.HEAD_SHA || '' };
}

export function report(findings) {
  return [
    `phase4-freeze: ${findings.length} commit(s) violate the TypeScript freeze rules (D129, ADR-019).`,
    ...findings.flatMap(f => [`  commit ${f.sha}: ${f.reason}`, ...f.files.map(file => `    ${file}`), `    expected trailer: ${f.expected}`]),
  ].join('\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { base, head } = range(process.argv.slice(2), process.env);
    if (!base || !head) console.log('phase4-freeze: no commit range (BASE_SHA/HEAD_SHA or --base/--head), nothing to check');
    else {
      const cwd = process.cwd();
      const baseCommit = git(cwd, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim();
      const approvedDefects = readApprovedDefects(cwd, baseCommit);
      const packages = frozenPackages(readdirSync('packages', { withFileTypes: true }));
      const commits = collectCommits({ base: baseCommit, head, cwd });
      const findings = checkCommits(commits, { packages, approvedDefects });
      if (findings.length) { console.error(report(findings)); process.exitCode = 1; }
      else console.log(`phase4-freeze: ${commits.length} commit(s) checked, ${packages.length} frozen packages, ok`);
    }
  } catch (error) { console.error(`phase4-freeze: ${error.message}`); process.exitCode = 1; }
}
