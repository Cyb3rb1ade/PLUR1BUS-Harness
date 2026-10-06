import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {windowsFocusLegs, windowsFocusSummary} from './windows-focus-summary.mjs';
import {lifecycleFields, launcherSkip} from './lifecycle-report.mjs';
const head = 'a'.repeat(40);
const entries = () => windowsFocusLegs.map(leg => ({schema:1, headSha:head, platform:'win32', arch:leg.arch, cookieGuard:leg.cookieGuard,
  report:{...Object.fromEntries(lifecycleFields.map(field => [field,true])), second_instance_focus_mode:'strict'}}));
const skip = entry => ({...entry, report:{...entry.report, second_instance_focus:launcherSkip, second_instance_focus_mode:launcherSkip}});

test('ARM skips require at least one genuine strict x64 check on this exact head', () => {
  const valid = entries().map(entry => entry.arch === 'arm64' ? skip(entry) : entry);
  assert.equal(windowsFocusSummary(valid, head, 'success').strict, 2);
  assert.equal(windowsFocusSummary([skip(valid[0]), ...valid.slice(1)], head, 'success').strict, 1);
  assert.equal(windowsFocusSummary(valid, head, 'success').skipped, 2);
  assert.throws(() => windowsFocusSummary(valid.map(skip), head, 'success'), /WINDOWS_STRICT_FOCUS_MISSING/);
  assert.throws(() => windowsFocusSummary(valid.slice(1), head, 'success'), /WINDOWS_FOCUS_REPORTS_MISSING/);
  assert.throws(() => windowsFocusSummary(valid, 'b'.repeat(40), 'success'), /WINDOWS_FOCUS_REPORT_CONTEXT_FAILED/);
  assert.throws(() => windowsFocusSummary(valid, head, 'failure'), /WINDOWS_FOCUS_MATRIX_FAILED/);
  const changed = entries(); changed[0].report.second_instance_focus = false;
  assert.throws(() => windowsFocusSummary(changed, head, 'success'), /WINDOWS_FOCUS_REPORT_INCOMPLETE/);
  const extra = entries(); extra[0].privateTitle = 'synthetic-private';
  assert.throws(() => windowsFocusSummary(extra, head, 'success'), /WINDOWS_FOCUS_REPORT_CONTEXT_FAILED/);
});

test('the workflow entrypoint fails everything-skipped and missing reports, and emits a truthful summary', t => {
  const root = mkdtempSync(join(tmpdir(), 'wp06-focus-summary-test-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const script = fileURLToPath(new URL('./windows-focus-summary.mjs', import.meta.url));
  const summary = join(root, 'summary.md');
  const run = () => spawnSync(process.execPath, [script, root], {encoding:'utf8',
    env:{...process.env, PLUR1BUS_CI_HEAD_SHA:head, PLUR1BUS_DESKTOP_MATRIX_RESULT:'success', GITHUB_STEP_SUMMARY:summary}});
  assert.equal(run().status, 1);
  const save = reports => windowsFocusLegs.forEach((leg,index) => {
    const folder = join(root, `desktop-lifecycle-${leg.os}-${leg.cookieGuard}`); mkdirSync(folder, {recursive:true});
    writeFileSync(join(folder, 'lifecycle-report.json'), JSON.stringify(reports[index]));
  });
  save(entries().map(skip)); const allSkipped = run();
  assert.equal(allSkipped.status, 1); assert.match(allSkipped.stderr, /strict=0/);
  save(entries().map(entry => entry.arch === 'arm64' ? skip(entry) : entry)); const covered = run();
  assert.equal(covered.status, 0); assert.match(covered.stdout, /strictX64=2 skipped=2/);
  assert.match(readFileSync(summary, 'utf8'), /not counted as passes/);
});
