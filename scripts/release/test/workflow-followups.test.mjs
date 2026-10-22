import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = name => readFileSync(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
const desktop = workflow('desktop');

// Scope checks to real indentation-delimited blocks, never comments or another job.
// actionlint separately validates the complete YAML and Actions expression grammar.
function block(text, name, indent) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line === `${' '.repeat(indent)}${name}:`);
  assert.notEqual(start, -1, `missing block ${name}`);
  const end = lines.findIndex((line, index) => index > start && line.trim() && !line.trimStart().startsWith('#') && line.search(/\S/) <= indent);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function steps(job) {
  return job.split(/(?=^      - )/m).slice(1).map(body => ({ body }));
}

function field(step, name) {
  return new RegExp(`^ {6}(?:- |  )${name}: (.+)$`, 'm').exec(step.body)?.[1].replace(/ #.*$/, '').trim();
}

function label(step) { return field(step, 'name') ?? field(step, 'run') ?? field(step, 'uses'); }

// Interpret the actual workflow conditions and GitHub's implicit success() guard.
// Reject unknown atoms rather than silently treating a changed condition as covered.
function runs(condition = 'success()', { os, status, cargo, native }) {
  let expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  if (!/\b(?:always|success|failure|cancelled)\(\)/.test(expression) && status !== 'success') return false;
  expression = expression.replace(/runner\.os (==|!=) '(Windows|Linux|macOS)'/g, (_, operator, expected) => String(operator === '==' ? os === expected : os !== expected))
    .replace(/steps\.(desktop-rust-tests|native-diagnostics)\.outcome == 'failure'/g, (_, step) => String((step === 'desktop-rust-tests' ? cargo : native) === 'failure'))
    .replace(/(always|success|failure|cancelled)\(\)/g, (_, fn) => String(fn === 'always' || fn === status));
  assert.match(expression, /^(?:true|false|\s|\(|\)|&&|\|\|)+$/, `uninterpreted condition: ${condition}`);
  const tokens = expression.match(/true|false|\(|\)|&&|\|\|/g);
  let cursor = 0;
  const atom = () => {
    const token = tokens[cursor++];
    if (token === '(') { const value = or(); assert.equal(tokens[cursor++], ')'); return value; }
    assert.ok(token === 'true' || token === 'false');
    return token === 'true';
  };
  const and = () => { let value = atom(); while (tokens[cursor] === '&&') { cursor++; const next = atom(); value = value && next; } return value; };
  const or = () => { let value = and(); while (tokens[cursor] === '||') { cursor++; const next = and(); value = value || next; } return value; };
  const value = or();
  assert.equal(cursor, tokens.length);
  return value;
}

test('desktop PR and push paths include both exact cross-language IP inputs', () => {
  const triggers = block(desktop, 'on', 0);
  for (const event of ['pull_request', 'push']) {
    const section = block(triggers, event, 2);
    const paths = JSON.parse(/^    paths: (.+)$/m.exec(section)?.[1] ?? 'null');
    for (const path of ['packages/core/src/tools/web/ip.ts', 'packages/core/test/fixtures/net/ip-classification-vectors.json']) {
      assert.ok(paths.includes(path), `${event}: missing exact path ${path}`);
    }
  }
});

test('scheduled advisory canary installs GTK4 with its existing native dependencies', () => {
  const canary = block(block(desktop, 'jobs', 0), 'canary', 2);
  assert.match(canary, /^    if: github.event_name == 'schedule'$/m);
  assert.match(canary, /^    continue-on-error: true$/m);
  const install = steps(canary).map(step => field(step, 'run')).find(command => command?.startsWith('sudo apt-get update && sudo apt-get install -y '));
  assert.ok(install, 'the actual canary apt command exists');
  for (const dependency of ['libgtk-4-dev', 'libwebkit2gtk-4.1-dev', 'libayatana-appindicator3-dev', 'librsvg2-dev', 'libsecret-1-dev']) {
    assert.ok(install.split(/\s+/).includes(dependency), `missing canary package ${dependency}`);
  }
});

test('every HM4 step has a bounded timeout and retains the contract commands', () => {
  const hm4 = block(block(workflow('hermes-host'), 'jobs', 0), 'hm4-contract', 2);
  assert.match(hm4, /^    timeout-minutes: 60$/m);
  const expected = new Map([
    ['install pinned dependencies', 10], ['pnpm prep', 10],
    ['scoped token and real fake-Hermes client', 5],
    ['profile transaction and read-only dry-run', 20],
    ['profile rollback and store inode preservation', 10],
    ['Python provider and client offline suites', 5],
  ]);
  for (const step of steps(hm4)) {
    const timeout = Number(field(step, 'timeout-minutes'));
    assert.ok(Number.isInteger(timeout) && timeout > 0 && timeout <= 60, `${label(step)}: missing/invalid timeout`);
    assert.equal(timeout, field(step, 'uses') ? 5 : expected.get(label(step)), label(step));
  }
  for (const command of [
    'pnpm install --frozen-lockfile', 'pnpm prep',
    'node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 packages/core/test/hermes/scoped-client.test.ts packages/rpc-schema/test/hermes-client-auth.test.ts',
    'cargo test -p plur1bus --test hm4 --test setup_profile', 'cargo test -p plur1bus profile_upgrade',
    'python -m unittest discover -s hosts/hermes/tests -t hosts/hermes',
    'python -m unittest discover -s clients/python/plur1bus-memory-client/tests -t clients/python/plur1bus-memory-client',
  ]) assert.ok(steps(hm4).some(step => step.body.split('\n').some(line => line.trim().replace(/^(?:- )?run: /, '') === command)), `missing HM4 command ${command}`);
});

test('Windows post-Cargo steps survive red tests while non-Windows status predicates remain intact', () => {
  const job = block(block(desktop, 'jobs', 0), 'desktop', 2);
  assert.doesNotMatch(job, /^    continue-on-error:/m, 'the desktop job must remain red after a test failure');
  assert.match(job, /^    timeout-minutes: 60$/m);
  const allSteps = steps(job);
  const cargoIndex = allSteps.findIndex(step => field(step, 'id') === 'desktop-rust-tests');
  assert.ok(cargoIndex >= 0);
  assert.equal(field(allSteps[cargoIndex], 'timeout-minutes'), '15');
  const downstream = allSteps.slice(cargoIndex + 1);
  assert.equal(downstream.length, 23, 'cover every downstream step, including the unsigned upload');
  const nativeFailure = "success() || (failure() && steps.native-diagnostics.outcome == 'failure')";
  const original = new Map([
    ['Windows libtest loader failure evidence', "runner.os == 'Windows' && failure() && steps.desktop-rust-tests.outcome == 'failure'"],
    ['Windows libtest loader evidence artifacts', "always() && runner.os == 'Windows'"],
    ['Native transport spike (WebKitGTK)', "runner.os == 'Linux'"],
    ['Native transport spike (WKWebView and WebView2)', `runner.os != 'Linux' && (${nativeFailure})`],
    ['Native deep-link startup and second-instance delivery (Linux)', "runner.os == 'Linux'"],
    ['Native deep-link startup and second-instance delivery (macOS and Windows)', "runner.os != 'Linux'"],
    ['Native transport observations', 'always()'],
    ['Native SPA login, restart and isolation (WebKitGTK)', `runner.os == 'Linux' && (${nativeFailure})`],
    ['Native SPA login, restart and isolation (WKWebView and WebView2)', `runner.os != 'Linux' && (${nativeFailure})`],
    ['Native lifecycle and isolated second instance (Linux)', "runner.os == 'Linux'"],
    ['Native lifecycle and isolated second instance (macOS and Windows)', "runner.os != 'Linux'"],
    ['Retain Windows lifecycle coverage', "always() && runner.os == 'Windows'"],
    ['Native crash restart, Shell acknowledgment and diagnostics Quit (Linux)', "runner.os == 'Linux'"],
    ['Native crash restart, Shell acknowledgment and diagnostics Quit (macOS and Windows)', "runner.os != 'Linux'"],
    ['Native AppKit tray headers, tooltip and template fallback (macOS)', "runner.os == 'macOS'"],
    ['Native SPA observations', 'always()'],
  ]);
  for (const step of downstream) {
    const name = label(step);
    const timeout = name === 'Windows libtest loader failure evidence' || name === 'Native fixture tests' || name.startsWith('Native transport spike') ? '10'
      : name === 'Native probe and Windows startup diagnostic tests' ? '5'
      : name.startsWith('Native SPA login') ? '15'
      : name.startsWith('Native deep-link') || name.startsWith('Native lifecycle and') || name.startsWith('Native crash restart') || name.startsWith('Native AppKit') ? '8' : undefined;
    assert.equal(field(step, 'timeout-minutes'), timeout, `${name}: preserve the existing platform timeout`);
    const before = original.get(name);
    const windowsEligible = !before || !/runner.os == '(?:Linux|macOS)'/.test(before);
    if (windowsEligible) assert.match(field(step, 'if') ?? '', /\balways\(\)/, `${name}: explicit always()`);
    assert.equal(field(step, 'continue-on-error'), undefined, `${name}: failures still fail the job`);
    for (const os of ['Windows', 'Linux', 'macOS']) for (const status of ['success', 'failure', 'cancelled']) {
      for (const cargo of ['success', 'failure', 'skipped']) for (const native of ['success', 'failure', 'skipped']) {
        const context = { os, status, cargo, native };
        let expected = runs(before, context);
        if (os === 'Windows' && windowsEligible) expected = name === 'Windows libtest loader failure evidence' ? status === 'failure' && cargo === 'failure' : true;
        assert.equal(runs(field(step, 'if'), context), expected, `${name}: ${JSON.stringify(context)}`);
      }
    }
  }
  const unsigned = downstream.at(-1);
  assert.match(unsigned.body, /name: desktop-unsigned-/);
  assert.equal(runs(field(unsigned, 'if'), { os: 'Windows', status: 'failure', cargo: 'failure', native: 'failure' }), true);
});
