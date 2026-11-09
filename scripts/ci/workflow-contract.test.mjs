import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify } from './changes.mjs';
import { selections, evaluateGate, UNGATED } from './gate.mjs';
import { listTestFiles, selectShard } from './test-shards.mjs';
import { fileURLToPath } from 'node:url';

// Execute the narrow boolean expression subset used at the actual job boundaries.
function condition(expression, outputs) {
  const replaced = expression.replaceAll('always()', 'true').replace(/needs\.changes\.outputs\.([\w-]+)/g,
    (_, key) => { assert(key in outputs, key); return JSON.stringify(outputs[key]); });
  assert.match(replaced, /^[\s()"'a-z=|&]+$/);
  return Function(`return (${replaced});`)();
}

const workflow = () => readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const jobBlocks = yaml => Object.fromEntries(yaml.slice(yaml.indexOf('\njobs:\n')).split(/(?=^  [a-z][\w-]*:\n)/m).slice(1)
  .map(block => [/^  ([\w-]+):/.exec(block)[1], block]));
// A job's block also carries the comment lines written above the next job; they are not steps.
const stepsOf = block => block.slice(block.indexOf('\n    steps:\n')).replace(/(?:^  #.*\n)+$/m, '');

test('B1 fixture selftests prepare the pinned Go and Python toolchains before execution', () => {
  for (const name of ['unit', 'unit-os']) {
    const block = jobBlocks(workflow())[name];
    const fixture = block.indexOf('      - name: B1 coding checker selftest');
    const go = block.indexOf('uses: actions/setup-go@');
    const python = block.indexOf('uses: actions/setup-python@');
    assert.ok(fixture >= 0 && go >= 0 && go < fixture, `${name}: prepare Go before B1`);
    assert.ok(python >= 0 && python < fixture, `${name}: prepare Python before B1`);
    assert.match(block.slice(go, fixture), /go-version: "1\.27\.1"/);
    assert.match(block.slice(python, fixture), /python-version: "3\.13"/);
  }
});

test('media capability acceptance runs in a required browser shard behind the web merge gate', () => {
  const jobs = jobBlocks(workflow()), shard = jobs['web-browser-shard'];
  assert.match(shard, /^      PLUR1BUS_WEB_E2E_REQUIRED: "1"$/m);
  assert.doesNotMatch(shard, /PLUR1BUS_WEB_BROWSER:\s*["']?off/);
  const steps = stepsOf(shard);
  const install = steps.indexOf('pnpm --filter @plur1bus/web exec playwright install --with-deps chromium');
  const run = steps.indexOf('run: pnpm --filter @plur1bus/web test');
  assert.ok(install >= 0 && run > install, 'lockfile-matched browser installation precedes the suite');
  assert.match(shard, /^      PLUR1BUS_TEST_SHARD: \$\{\{ matrix.shard \}\}\/\$\{\{ matrix.total \}\}$/m);
  const total = Number(/^        total: \[(\d+)\]$/m.exec(shard)?.[1]);
  assert.ok(Number.isInteger(total) && total > 0, 'the browser job defines its shard count');
  const files = listTestFiles(fileURLToPath(new URL('../../packages/web', import.meta.url)));
  const target = 'test/media-capabilities.test.ts';
  assert.ok(files.includes(target), 'media acceptance is in the production package runner list');
  const owners = Array.from({ length: total }, (_, i) => i + 1)
    .filter(index => selectShard(files, { index, total }).includes(target));
  assert.equal(owners.length, 1, 'exactly one required browser shard runs media acceptance');
  assert.match(jobs['web-browser'], /^    needs: \[changes, web-browser-build, web-browser-shard\]$/m);
  assert.match(jobs['ci-gate'], /^    needs: \[[^\]\n]*\bweb-browser\b[^\]\n]*\]$/m);
  const outputs = Object.fromEntries(Object.entries({ proceed: true, macos: false,
    ...classify({ event: 'pull_request', files: ['packages/web/test/media-capabilities.test.ts'] }) })
    .map(([key, value]) => [key, String(value)]));
  assert.equal(selections(outputs)['web-browser'], true, 'media acceptance changes require the browser gate');
});

test('WSL setup attempts cannot consume the job budget before retries and real tests', () => {
  const wsl = jobBlocks(workflow()).wsl;
  assert.match(wsl, /^    timeout-minutes: 20$/m);
  const steps = stepsOf(wsl).split(/(?=^      - )/m);
  let totalSetupMinutes = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const step = steps.find(block => block.includes(`id: wsl_setup_${attempt}\n`));
    assert.ok(step, `setup attempt ${attempt} missing`);
    const minutes = Number(/^        timeout-minutes: (\d+)$/m.exec(step)?.[1]);
    assert.ok(minutes > 0 && minutes <= 4, `attempt ${attempt} must have its own bounded deadline`);
    totalSetupMinutes += minutes;
    assert.match(step, /continue-on-error: true/);
    if (attempt > 1) assert.ok(step.includes(`if: steps.wsl_setup_${attempt - 1}.outcome == 'failure'`));
  }
  assert.ok(totalSetupMinutes <= 12, 'leave the remaining job budget for preparation and actual WSL assertions');
  const status = steps.find(block => block.includes('id: wsl_setup_status\n'));
  assert.match(status, /if: always\(\)/);
  assert.match(status, /echo "ready=false"/);
  assert.match(status, /exit 1/);
  assert.ok(steps.some(block => block.includes('name: synthetic WSL source and import detect')));
});

test('every job running Core builds the native sandbox launcher before its assertions', () => {
  const jobs = jobBlocks(workflow());
  for (const name of ['unit', 'unit-os', 'core-unit-shard', 'core-unit-shard-windows']) {
    const block = jobs[name];
    const build = block.indexOf('cargo build --locked -p plur1bus --bin plur1bus-sandbox-limits');
    const tests = block.indexOf(name.startsWith('core-unit') ? '      - name: measured Core shard' : '      - name: unit tests with file timings');
    assert.ok(build >= 0 && build < tests, `${name}: native launcher must exist before Core starts`);
    const toolchain = block.indexOf('uses: dtolnay/rust-toolchain@');
    assert.ok(toolchain >= 0 && toolchain < build, name);
    const step = block.slice(0, build).split(/(?=^      - )/m).at(-1);
    assert.doesNotMatch(step, /outputs\.rust/, `${name}: a TS-only change still needs the launcher`);
  }
});

test('release smoke prepares the verified real-model cache before the unchanged acceptance deadline', () => {
  const yaml = readFileSync(new URL('../../.github/workflows/release-smoke.yml', import.meta.url), 'utf8');
  const prepare = yaml.indexOf('node scripts/ci/prepare-real-models.mjs');
  const acceptance = yaml.indexOf('tests/system/two-session-recall.test.ts');
  assert(prepare > 0 && prepare < acceptance, 'real artifacts must be prepared before timed model startup');
  assert.equal((yaml.match(/PLUR1BUS_MODELS_CACHE: \$\{\{ runner.temp \}\}\/release-real-models/g) ?? []).length, 3);
  const source = readFileSync(new URL('../../tests/system/two-session-recall.test.ts', import.meta.url), 'utf8');
  assert(source.includes('waitEngineReady(h, 60_000)'));
  assert(yaml.includes('--test-timeout=300000 tests/system/two-session-recall.test.ts'));
});

test('every workflow job is either in the gate or deliberately ungated, and job conditions match the skip policy', () => {
  const jobs = jobBlocks(workflow());
  const gated = Object.keys(selections({})).sort();
  assert.deepEqual(Object.keys(jobs).filter(k => !['changes', 'ci-gate'].includes(k)).sort(), [...gated, ...UNGATED].sort());
  const dependencies = /^    needs: \[([^\]]+)\]/m.exec(jobs['ci-gate'])[1].split(',').map(s => s.trim()).sort();
  assert.deepEqual(dependencies, ['changes', ...gated].sort());
  for (const files of [['docs/a.md'], ['packages/web/src/app.tsx'], ['crates/x/src/lib.rs'],
    ['packages/core/src/core.ts'], ['crates/plur1bus/tests/fixtures/fake-api.mjs'], ['clients/python/client.py'], ['packages/rpc-schema/schema/rpc.schema.json'],
    ['docs/errors.md'], ['.github/workflows/ci.yml'], ['pnpm-lock.yaml']]) {
    const outputs = Object.fromEntries(Object.entries({ proceed: true, macos: true, ...classify({ event: 'pull_request', files }) }).map(([k, v]) => [k, String(v)]));
    const expected = selections(outputs);
    const needs = { changes: { result: 'success', outputs } };
    for (const job of gated) {
      const scheduled = condition(/^    if: (.*)$/m.exec(jobs[job])[1], outputs);
      assert.equal(scheduled, expected[job], `${files}:${job}`);
      needs[job] = { result: scheduled ? 'success' : 'skipped' };
    }
    assert.deepEqual(evaluateGate(needs), []);
  }
});

test('the ungated jobs can neither delay nor fail the gate', () => {
  const jobs = jobBlocks(workflow());
  const gateNeeds = /^    needs: \[([^\]]+)\]/m.exec(jobs['ci-gate'])[1];
  for (const job of UNGATED) assert(!new RegExp(`\\b${job}\\b`).test(gateNeeds), job);
  // A failing leg of an ungated job must not change the verdict, and a failing gated job must.
  const outputs = Object.fromEntries(Object.entries({ proceed: true, macos: true, ...classify({ event: 'push', files: [] }) }).map(([k, v]) => [k, String(v)]));
  const needs = { changes: { result: 'success', outputs }, ...Object.fromEntries(Object.keys(selections(outputs)).map(job => [job, { result: 'success' }])) };
  assert.deepEqual(evaluateGate(needs), []);
  assert(evaluateGate({ ...needs, unit: { result: 'failure' } }).length > 0);
  assert(evaluateGate({ ...needs, 'unit-os': { result: 'failure' } }).some(e => e.includes('unrecognized job: unit-os')),
    'an ungated job in needs is a contract error, never a silent pass');
});

test('engine parity is advisory and runs for Rust, Core, parity fixtures or a new engine pin', () => {
  const jobs = jobBlocks(workflow());
  const job = jobs['engine-parity'];
  assert.ok(job, 'missing engine-parity job');
  assert.ok(UNGATED.includes('engine-parity'));
  assert.match(job, /^    needs: changes$/m);
  const jobIf = /^    if: (.*)$/m.exec(job)[1];
  for (const [files, enginePinChanged, proceed, expected] of [
    [['crates/plur1bus-engine/src/lib.rs'], false, true, true],
    [['packages/core/src/engine/client.ts'], false, true, true],
    [['tests/engine-parity/scenarios/recall/plain.json'], false, true, true],
    [['docs/engine-stores.md'], true, true, true],
    [['docs/engine-stores.md'], false, true, false],
    [['packages/web/src/example.ts'], false, true, false],
    [['crates/plur1bus-engine/src/lib.rs'], false, false, false],
  ]) {
    const flags = classify({ event: 'pull_request', files, enginePinChanged });
    const outputs = Object.fromEntries(Object.entries({ ...flags, proceed }).map(([key, value]) => [key, String(value)]));
    assert.equal(condition(jobIf, outputs), expected, files.join(', '));
  }
  assert.match(job, /pnpm parity --check tests\/engine-parity\/scenarios --report /);
  assert.doesNotMatch(job, /--node-only|continue-on-error/);
  assert.match(job, /if: \$\{\{ !cancelled\(\) \}\}[\s\S]*name: engine-parity-report/);
});

test('every Desktop platform builds test executables before the unchanged execution deadline', () => {
  const yaml = readFileSync(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8');
  const desktop = jobBlocks(yaml).desktop;
  const steps = desktop.split(/(?=^      - )/m);
  const build = steps.find(step => /run: cargo test --locked --workspace --no-run\n/.test(step));
  const execute = steps.find(step => /id: desktop-rust-tests\n/.test(step));
  assert(build, 'cold compilation must have its own bounded step');
  assert.doesNotMatch(build, /^        if:/m, 'Linux and macOS must not charge compilation to test execution');
  assert.match(build, /^        timeout-minutes: 15$/m);
  assert.match(execute, /^        timeout-minutes: 15$/m);
  assert.match(execute, /cargo test --locked --workspace --no-fail-fast -- --test-threads=1 --nocapture/);
  assert(steps.indexOf(build) < steps.indexOf(execute));
  assert.match(desktop, /^    timeout-minutes: 60$/m);
});

test('macOS unit opts into bounded Core concurrency without changing deadlines or test selection', () => {
  const block = jobBlocks(workflow())['unit-os'];
  assert.match(block, /PLUR1BUS_CORE_TEST_CONCURRENCY: \$\{\{ runner.os == 'macOS' && 'bounded' \|\| '' \}\}/);
  assert.match(block, /timeout-minutes: \$\{\{ matrix.os == 'windows-2025' && 35 \|\| 25 \}\}/);
  assert.match(block, /            pnpm test\n/);
  const runner = readFileSync(new URL('../test-package.mjs', import.meta.url), 'utf8');
  assert.match(runner, /const TEST_TIMEOUT_MS = 120_000/);
  assert.match(runner, /\.\.\.files\], \{ stdio: "inherit" \}/);
});

test('unit-os preserves every unit step while Ubuntu and Windows run Core only in their measured shards', () => {
  const jobs = jobBlocks(workflow());
  const coreSplit = '          # The Core files run exactly once in core-unit-shard; every other package stays here.\n' +
    '          node scripts/run-ts-tests.mjs --filter=!@plur1bus/core\n';
  // macOS keeps the whole workspace; Windows runs Ubuntu's filtered command and leaves Core to core-unit-shard-windows.
  const osSplit = '          if [ "$RUNNER_OS" = Windows ]; then\n' +
    '            # The Core files run exactly once in core-unit-shard-windows; every other package stays here.\n' +
    '            node scripts/run-ts-tests.mjs --filter=!@plur1bus/core\n' +
    '          else\n' +
    '            pnpm test\n' +
    '          fi\n';
  const timingStep = jobs['unit-os'].split(/(?=^      - )/m).find(step => step.includes('name: unit tests with file timings'));
  assert.match(timingStep, /PLUR1BUS_CORE_TEST_CONCURRENCY: \$\{\{ runner.os == 'macOS' && 'bounded' \|\| '' \}\}/);
  assert.match(timingStep, /timeout-minutes: \$\{\{ matrix.os == 'windows-2025' && 35 \|\| 25 \}\}/);
  assert.ok(stepsOf(jobs.unit).includes(coreSplit));
  const rustToolchain =
    '      - uses: dtolnay/rust-toolchain@89b12181fb390509a0842a86cc55eeb8eb928c1d # stable (toolchain fixed by with)\n' +
    '        with: { toolchain: "1.95", components: "clippy, rustfmt" }\n';
  const macToolchains =
    '      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0\n' +
    "        if: matrix.os == 'macos-15'\n" +
    '        with: { go-version: "1.27.1", cache: false }\n' +
    '      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0\n' +
    "        if: matrix.os == 'macos-15'\n" +
    '        with: { python-version: "3.13" }\n';
  assert.ok(stepsOf(jobs.unit).includes(rustToolchain));
  const expected = stepsOf(jobs.unit)
    .replace(coreSplit, osSplit)
    .replace(rustToolchain, rustToolchain + macToolchains);
  assert.equal(stepsOf(jobs['unit-os']), expected);
  assert.match(jobs['core-unit-shard'], /pnpm --filter @plur1bus\/core test/);
  assert.match(jobs['core-unit'], /core-unit-shard/);
  const field = (block, re) => re.exec(block)[0];
  // Same condition as `unit`, plus the full-platform policy: every leg of this job is non-Linux (see the next test).
  assert.equal(field(jobs['unit-os'], /^    if: .*$/m), `${field(jobs.unit, /^    if: .*$/m)} && needs.changes.outputs.macos == 'true'`);
  assert.equal(field(jobs['unit-os'], /^    timeout-minutes: .*$/m), field(jobs.unit, /^    timeout-minutes: .*$/m));
  const matrix = block => /^        os: \[([^\]]+)\]/m.exec(block)[1].split(',').map(x => x.trim());
  assert.deepEqual(matrix(jobs.unit), ['ubuntu-24.04']);
  assert.deepEqual(matrix(jobs['unit-os']), ['macos-15', 'windows-2025']);
  // Hosted check names stay stable; the separately tested trusted VM route declares its actual environment.
  assert.doesNotMatch(jobs.unit, /^    name:/m, 'Linux keeps the default unit matrix check name');
  assert.match(jobs['unit-os'], /^    name: unit \(\$\{\{ .* && 'macOS VM' \|\| matrix\.os \}\}\)$/m);
});

test('unit checks continue after earlier failures, stop on cancellation and time Rust build separately', () => {
  for (const name of ['unit', 'unit-os']) {
    const block = jobBlocks(workflow())[name];
    const independent = block.slice(block.indexOf('      # The vacuous-run guard'));
    const steps = independent.split(/(?=^      - )/m).filter(step => /^      - /m.test(step));
    assert.equal(steps.length, 12, `${name}: guard, release, installer, fmt, clippy, three tokenizer steps, library build, full build, run and diagnostics`);
    for (const step of steps) {
      const expression = /^ {6}(?:- |  )if: \$\{\{ (.*?) \}\}$/m.exec(step)?.[1];
      assert.ok(expression?.includes('!cancelled()'), `${name}: explicit status guard for ${step}`);
      for (const cancelled of [false, true]) for (const rust of [false, true]) {
        const evaluate = status => expression.replace('!cancelled()', String(!cancelled))
          .replace("needs.changes.outputs.rust == 'true'", String(rust))
          .replace("runner.os == 'Windows'", String(status === 'Windows'));
        for (const os of ['Windows', 'macOS', 'Linux']) {
          assert.equal(Function(`return (${evaluate(os)});`)(),
            !cancelled && (!expression.includes('outputs.rust') || rust) &&
              (!expression.includes('runner.os') || os === 'Windows'));
        }
      }
    }
    const library = steps.find(step => /^          cargo test --workspace --lib --no-run(?: [^\n]*)?\n/m.test(step));
    const build = steps.find(step => /^          cargo test --workspace --no-run(?: [^\n]*)?\n/m.test(step));
    const run = steps.find(step => /^          cargo test --workspace --no-fail-fast(?: [^\n]*)?\n/m.test(step));
    assert.match(library, /timeout-minutes: 25/);
    assert.match(build, /timeout-minutes: 25/);
    assert.match(run, /timeout-minutes: 30/);
    assert.equal(steps.indexOf(library) + 1, steps.indexOf(build));
    assert.equal(steps.indexOf(build) + 1, steps.indexOf(run));
    for (const phase of [library, build, run]) {
      assert.doesNotMatch(phase, /--(?:exclude|skip|features|no-default-features|target-dir|release)\b/);
    }
  }
});

test("Windows unit builds omit debug information without changing assertions or timeout budgets", () => {
  const mode = "${{ matrix.os == 'windows-2025' && '0' || '2' }}";
  for (const name of ["unit", "unit-os"]) {
    const job = jobBlocks(workflow())[name];
    for (const profile of ["DEV", "TEST"]) {
      assert.ok(job.includes(`      CARGO_PROFILE_${profile}_DEBUG: ${mode}\n`));
    }
    assert.doesNotMatch(job, /CARGO_PROFILE_(?:DEV|TEST)_(?:DEBUG_ASSERTIONS|OVERFLOW_CHECKS):/);
    assert.match(job, /timeout-minutes: \$\{\{ matrix\.os == 'windows-2025' && 90 \|\| 65 \}\}/);
  }
});

test('the Windows Core shards run the Ubuntu partition under the full-platform policy, outside the gate', () => {
  const jobs = jobBlocks(workflow());
  const ubuntu = jobs['core-unit-shard'], windows = jobs['core-unit-shard-windows'], check = jobs['core-unit-windows'];
  const field = (block, re) => re.exec(block)?.[1];
  for (const re of [/^        shard: (.*)$/m, /^      PLUR1BUS_TEST_SHARD: (.*)$/m, /^      PLUR1BUS_TEST_SHARD_TIMINGS: (.*)$/m]) {
    assert.ok(field(ubuntu, re), String(re));
    assert.equal(field(windows, re), field(ubuntu, re), `same partition: ${re}`);
  }
  assert.equal(field(windows, /^    runs-on: (.*)$/m), 'windows-2025');
  assert.equal(field(windows, /^    name: (.*)$/m), 'core unit shard ${{ matrix.shard }}/3 (windows-2025)');
  assert.match(windows, /^          pnpm --filter @plur1bus\/core test$/m);
  // Selected like the Ubuntu shards and their check, plus the full-platform policy that also selects unit-os.
  const ifOf = block => field(block, /^    if: (.*)$/m);
  assert.equal(ifOf(windows), `${ifOf(ubuntu)} && needs.changes.outputs.macos == 'true'`);
  assert.equal(ifOf(check), `${ifOf(jobs['core-unit'])} && needs.changes.outputs.macos == 'true'`);
  for (const macos of [true, false]) {
    for (const block of [windows, check]) {
      assert.equal(condition(ifOf(block), { proceed: 'true', 'ts-core': 'true', macos: String(macos) }), macos);
      assert.equal(condition(ifOf(block), { proceed: 'true', 'ts-core': 'false', macos: String(macos) }), false);
    }
  }
  assert.equal(field(check, /^    needs: (.*)$/m), '[changes, core-unit-shard-windows]');
  // The Windows manifests reach only the Windows check: the gated Ubuntu `core-unit` download pattern cannot match them.
  const glob = pattern => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*') + '$');
  const pattern = block => field(block, /^          pattern: (.*)$/m);
  const uploads = [...windows.matchAll(/^          name: (.*)$/gm)].map(m => m[1].replace('${{ matrix.shard }}', '1'));
  assert.deepEqual(uploads, ['windows-core-unit-manifest-1', 'core-test-timings-windows-2025-1']);
  assert.ok(glob(pattern(check)).test(uploads[0]));
  for (const name of uploads) assert.ok(!glob(pattern(jobs['core-unit'])).test(name), name);
  assert.match(check, /test-shards\.mjs verify --cwd=packages\/core --dir=windows-core-unit-manifests/);
  assert.match(check, /SHARDS: \$\{\{ needs\.core-unit-shard-windows\.result \}\}/);
  for (const job of ['core-unit-shard-windows', 'core-unit-windows']) assert.ok(UNGATED.includes(job), job);
});

test('a label run for another label cannot report a check named ci-gate', () => {
  const yaml = workflow();
  const gate = jobBlocks(yaml)['ci-gate'];
  const expression = /^    name: \$\{\{ (.*) \}\}$/m.exec(gate)[1];
  const nameFor = (action, label) => {
    const replaced = expression.replace('github.event.action', JSON.stringify(action)).replace('github.event.label.name', JSON.stringify(label));
    assert.match(replaced, /^[\s()"'\w:=!|&-]+$/);
    return Function(`return (${replaced});`)();
  };
  assert.equal(nameFor('opened', ''), 'ci-gate');
  assert.equal(nameFor('synchronize', ''), 'ci-gate');
  assert.equal(nameFor('', ''), 'ci-gate'); // push, schedule, workflow_dispatch
  assert.equal(nameFor('labeled', 'ci:macos'), 'ci-gate'); // a real run: every job runs, nothing else is the gate for it
  assert.notEqual(nameFor('labeled', 'documentation'), 'ci-gate');
  assert.notEqual(nameFor('labeled', ''), 'ci-gate');
  // The same predicate decides the no-op concurrency group, so the no-op run never cancels the real one.
  const predicate = "github.event.action == 'labeled' && github.event.label.name != 'ci:macos'";
  assert(/^concurrency:\n  group: .*$/m.test(yaml) && yaml.slice(yaml.indexOf('\nconcurrency:'), yaml.indexOf('\njobs:')).includes(predicate));
  assert(gate.includes(predicate));
});

test('docs-hygiene uses the verified pnpm v6 commit', () => {
  const yaml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const block = yaml.split('  docs-hygiene:\n')[1].split(/\n  [a-z][\w-]*:\n/)[0];
  assert.match(block, /pnpm\/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6\.1\.0/);
});

// #621's added macOS browser job used a renamed planning dependency. Catch this even when YAML merges cleanly.
function unknownNeeds(yaml) {
  const declared = new Set([...yaml.matchAll(/^  ([a-z][\w-]*):$/gm)].map(match => match[1]));
  return [...yaml.matchAll(/needs\.([\w-]+)\./g)].map(match => match[1]).filter(name => !declared.has(name));
}
test('workflow dependency references resolve, including a regression for the #621 planning-job rename', () => {
  const yaml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.deepEqual(unknownNeeds(yaml), []);
  const macosJob = "  web-browser-macos:\n    needs: plan\n    if: needs.plan.outputs.proceed == 'true' && needs.plan.outputs.macos == 'true'\n";
  assert.deepEqual(unknownNeeds(yaml + macosJob), ['plan', 'plan']);
  assert.deepEqual(unknownNeeds(yaml + macosJob.replaceAll('needs: plan', 'needs: changes').replaceAll('needs.plan.', 'needs.changes.')), []);
});

test('every executable CI job has a bounded timeout, including the Core shard and its gate', () => {
  const yaml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = yaml.slice(yaml.indexOf('\njobs:\n')).split(/(?=^  [a-z][\w-]*:\n)/m).slice(1);
  for (const job of jobs) {
    const name = /^  ([\w-]+):/.exec(job)[1];
    const timeout = /^    timeout-minutes: (.+)$/m.exec(job)?.[1];
    assert.ok(timeout, `${name}: explicit job timeout required`);
    const minutes = timeout.startsWith('${{') ? [...timeout.matchAll(/(?:&&|\|\|)\s*(\d+)/g)].map(m => Number(m[1])) : [Number(timeout)];
    assert.ok(minutes.length > 0 && minutes.every(n => Number.isInteger(n) && n >= 1 && n <= 120), `${name}: unreasonable job budget ${timeout}`);
  }
});

// The non-deciding non-Linux legs (macOS, Windows, Windows ARM) follow the full-platform policy (`changes.macos`: push to main,
// schedule, dispatch, label `ci:macos`, platform-sensitive paths). Linux legs run on every selected PR push. The decision lives in
// the job conditions and matrices, so they are evaluated here the way the runner would: `exclude` entries drop matching
// combinations of the `os` list, and a dynamic `include` list is the matrix itself.
const isLinux = os => os.startsWith('ubuntu-');
const matrixOs = block => /^\s+os: \[([^\]]+)\]/m.exec(block)[1].split(',').map(x => x.trim());
const macosExpression = /fromJSON\(needs\.changes\.outputs\.macos == 'true' && '(\[.*?\])' \|\| '(\[.*?\])'\)/;
const policy = (block, key) => {
  const line = new RegExp(`^\\s+${key}: \\$\\{\\{ (.*) \\}\\}$`, 'm').exec(block);
  assert(line, `${key} must be a fromJSON(macos ...) expression`);
  const m = macosExpression.exec(line[1]);
  assert(m, `${key} must use the macos policy expression`);
  return { full: JSON.parse(m[1]), selected: JSON.parse(m[2]) };
};
/** The os values a job runs on for a given policy output, from its own matrix. */
function legsOf(block, macos) {
  if (/^\s+include: \$\{\{/m.test(block)) {
    const { full, selected } = policy(block, 'include');
    return (macos ? full : selected).map(e => e.os);
  }
  const excluded = new Set(policy(block, 'exclude')[macos ? 'full' : 'selected'].map(e => e.os));
  return matrixOs(block).filter(os => !excluded.has(os));
}

test('non-deciding non-Linux legs run only under the full-platform policy; every Linux leg runs on every selected push', () => {
  const jobs = jobBlocks(workflow());
  const expected = {
    service: { all: ['ubuntu-24.04', 'macos-15', 'windows-2025'], linux: ['ubuntu-24.04'] },
    sandbox: { all: ['macos-15', 'ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-2025', 'windows-11-arm'], linux: ['ubuntu-24.04', 'ubuntu-24.04-arm'] },
    'perf-budgets': { all: ['macos-15', 'windows-2025', 'windows-11-arm', 'ubuntu-24.04', 'ubuntu-24.04-arm'], linux: ['ubuntu-24.04', 'ubuntu-24.04-arm'] },
    'perf-startup': { all: ['macos-15', 'windows-2025', 'windows-11-arm', 'ubuntu-24.04', 'ubuntu-24.04-arm'], linux: ['ubuntu-24.04', 'ubuntu-24.04-arm'] },
    system: { all: ['ubuntu-24.04', 'macos-15'], linux: ['ubuntu-24.04'] },
  };
  for (const [job, want] of Object.entries(expected)) {
    assert.deepEqual([...legsOf(jobs[job], true)].sort(), [...want.all].sort(), `${job}: policy on`);
    assert.deepEqual([...legsOf(jobs[job], false)].sort(), [...want.linux].sort(), `${job}: policy off`);
    assert(legsOf(jobs[job], false).every(isLinux), `${job}: no non-Linux leg without the policy`);
  }
  // perf-startup keeps the target that goes with each runner.
  const targets = Object.fromEntries(policy(jobs['perf-startup'], 'include').full.map(e => [e.os, e.target]));
  assert.deepEqual(targets, { 'macos-15': 'darwin-arm64', 'windows-2025': 'win32-x64', 'windows-11-arm': 'win32-arm64', 'ubuntu-24.04': 'linux-x64', 'ubuntu-24.04-arm': 'linux-arm64' });
  assert.deepEqual(policy(jobs['perf-startup'], 'include').selected.map(e => e.target), ['linux-x64', 'linux-arm64']);

  // unit-os has no Linux leg, so the whole job is conditional instead of excluding every matrix entry.
  assert(matrixOs(jobs['unit-os']).every(os => !isLinux(os)));
  assert(!/^\s+exclude:/m.test(jobs['unit-os']));
  const unitOsIf = /^    if: (.*)$/m.exec(jobs['unit-os'])[1];
  const outputs = (macos, kind) => ({ proceed: 'true', macos: String(macos), rust: String(kind === 'rust'), 'ts-core': String(kind === 'ts-core') });
  for (const kind of ['rust', 'ts-core']) {
    assert.equal(condition(unitOsIf, outputs(true, kind)), true, `unit-os runs under the policy (${kind})`);
    assert.equal(condition(unitOsIf, outputs(false, kind)), false, `unit-os is skipped without the policy (${kind})`);
  }
  assert.equal(condition(unitOsIf, outputs(true, 'none')), false);

  // The Linux jobs and the gate are not conditional on the policy; the gate neither needs nor waits for the gated legs.
  assert(!/macos/.test(/^    if: (.*)$/m.exec(jobs.unit)[1]));
  assert(!/macos/.test(/^    if: (.*)$/m.exec(jobs.wsl)[1]));
  assert(!/macos/.test(matrixOs(jobs.unit).join()));
});

test('a PR without the platform policy still gets a passing gate when the gated non-Linux legs are skipped', () => {
  const outputs = Object.fromEntries(Object.entries({ proceed: true, macos: false, ...classify({ event: 'pull_request', files: ['packages/core/src/core.ts'] }) }).map(([k, v]) => [k, String(v)]));
  const needs = { changes: { result: 'success', outputs } };
  for (const [job, required] of Object.entries(selections(outputs))) needs[job] = { result: required ? 'success' : 'skipped' };
  assert(!('web-browser-macos' in selections(outputs)), 'the macOS browser shards are outside the gate');
  assert.deepEqual(evaluateGate(needs), []);
  assert(!('unit-os' in needs), 'the gated non-Linux jobs are not part of the gate');
});

test("Core shards prepare the pinned Rust toolchain and protected cache before native integration builds", () => {
  const jobs = jobBlocks(workflow());
  for (const job of ["core-unit-shard", "core-unit-shard-windows"]) {
    const block = jobs[job];
    const build = block.indexOf(
      "run: cargo build --locked -p plur1bus-tools -p plur1bus",
    );
    const toolchain = block.indexOf(
      "uses: dtolnay/rust-toolchain@89b12181fb390509a0842a86cc55eeb8eb928c1d",
    );
    const cache = block.indexOf(
      "uses: Swatinem/rust-cache@49a0bdc70d2e1b713ca9e2869b211fcce03d3c1c",
    );
    assert.ok(
      toolchain >= 0 && toolchain < build,
      `${job}: pinned toolchain before native build`,
    );
    assert.ok(
      cache > toolchain && cache < build,
      `${job}: pinned cache after toolchain and before build`,
    );
    assert.match(block.slice(toolchain, cache), /toolchain: "1\.95"/);
    assert.match(
      block.slice(cache, build),
      /save-if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/,
    );
    assert.match(block.slice(cache, build), /cache-on-failure: false/);
  }
});

test('native installation and served-stack acceptance carry the required CLI and tools release pair', () => {
  const jobs = jobBlocks(workflow());
  const build = jobs['web-browser-build'];
  assert.match(build, /path: \|\n\s+target\/debug\/plur1bus\n\s+target\/debug\/plur1bus-tools/);
  assert.match(jobs['web-browser-shard'], /chmod \+x.*plur1bus-tools/);
  for (const workflowName of ['release-smoke.yml', 'hermes-host.yml', 'nightly.yml']) {
    const text = readFileSync(new URL(`../../.github/workflows/${workflowName}`, import.meta.url), 'utf8');
    const commands = text.split('\n').filter(line => /cargo build --release -p plur1bus(?: |$)/.test(line));
    assert.ok(commands.length > 0, workflowName);
    for (const command of commands) assert.match(command, /-p plur1bus-tools(?: |$)/, workflowName);
  }
  const release = readFileSync(new URL('../../.github/workflows/harness-release.yml', import.meta.url), 'utf8');
  for (const command of release.split('\n').filter(line => /cargo (?:zigbuild|build) --locked --release -p plur1bus(?: |$)/.test(line))) {
    assert.match(command, /-p plur1bus-tools(?: |$)/);
  }
  assert.match(release, /cp "target\/\$TRIPLE\/release\/plur1bus-tools\$ext" "out\/plur1bus-tools-\$TARGET\$ext"/);
  assert.match(release, /for binary in out\/plur1bus-darwin-arm64 out\/plur1bus-tools-darwin-arm64; do/);
  assert.match(release, /name: signed-darwin-arm64\n\s+path: \|\n\s+out\/plur1bus-darwin-arm64\n\s+out\/plur1bus-tools-darwin-arm64/);
});
