import {readFileSync, appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {lifecycleFailure, launcherSkip} from './lifecycle-report.mjs';

export const windowsFocusLegs = [
  {os:'windows-2025', arch:'x64', cookieGuard:'on'},
  {os:'windows-2025', arch:'x64', cookieGuard:'off'},
  {os:'windows-11-arm', arch:'arm64', cookieGuard:'on'},
  {os:'windows-11-arm', arch:'arm64', cookieGuard:'off'},
];
const keys = value => Object.keys(value).sort().join(',');
const fail = code => { throw new Error(code); };

export function windowsFocusSummary(entries, headSha, matrixResult) {
  if (matrixResult !== 'success') fail('WINDOWS_FOCUS_MATRIX_FAILED');
  if (!/^[a-f0-9]{40}$/.test(headSha ?? '') || entries.length !== windowsFocusLegs.length) fail('WINDOWS_FOCUS_REPORTS_MISSING');
  const rows = windowsFocusLegs.map((leg, index) => {
    const entry = entries[index];
    if (!entry || keys(entry) !== 'arch,cookieGuard,headSha,platform,report,schema' || entry.schema !== 1 ||
        entry.platform !== 'win32' || entry.headSha !== headSha || entry.arch !== leg.arch || entry.cookieGuard !== leg.cookieGuard) {
      fail('WINDOWS_FOCUS_REPORT_CONTEXT_FAILED');
    }
    if (lifecycleFailure(entry.report, {allowWindowsSkip:true})) fail('WINDOWS_FOCUS_REPORT_INCOMPLETE');
    return {...leg, mode:entry.report.second_instance_focus_mode};
  });
  const strict = rows.filter(row => row.arch === 'x64' && row.mode === 'strict').length;
  if (strict === 0) fail('WINDOWS_STRICT_FOCUS_MISSING arch=x64 strict=0');
  const skipped = rows.filter(row => row.mode === launcherSkip).length;
  const table = ['| Architecture | Cookie guard | Second-instance focus |', '|---|---|---|',
    ...rows.map(row => `| ${row.arch} | ${row.cookieGuard} | ${row.mode} |`), '',
    `Strict x64 checks: ${strict}. Skipped checks: ${skipped} (not counted as passes).`, '',
    'Open D1 release gate: owner verifies ARM foreground/singleton behavior manually on a Windows ARM VM.'];
  return {strict, skipped, markdown:table.join('\n') + '\n'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const entries = windowsFocusLegs.map(leg => JSON.parse(readFileSync(join(process.argv[2],
      `desktop-lifecycle-${leg.os}-${leg.cookieGuard}`, 'lifecycle-report.json'), 'utf8')));
    const result = windowsFocusSummary(entries, process.env.PLUR1BUS_CI_HEAD_SHA, process.env.PLUR1BUS_DESKTOP_MATRIX_RESULT);
    console.log(`WINDOWS_FOCUS_COVERAGE strictX64=${result.strict} skipped=${result.skipped}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.markdown);
  } catch (error) {
    const reason = /^WINDOWS_(FOCUS_[A-Z_]+|STRICT_FOCUS_MISSING arch=x64 strict=0)$/.test(error.message) ? error.message : 'WINDOWS_FOCUS_REPORTS_MISSING';
    console.error(reason);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Windows focus coverage failed: ${reason}\n`);
    process.exitCode = 1;
  }
}
