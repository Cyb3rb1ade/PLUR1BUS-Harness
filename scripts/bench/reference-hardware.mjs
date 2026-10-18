// Owner-run O6 collector. No installation, cache flushing, service changes or real user home.
import { execFileSync } from 'node:child_process';
import { cpus, totalmem, platform, arch, release, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startup } from './startup.mjs';
import { budgets } from './budgets.mjs';
import { runs } from './metrics.mjs';
import { deviceContext } from './device-context.mjs';

function storageType() {
  try {
    if (platform() === 'darwin') {
      const plist = execFileSync('/usr/sbin/diskutil', ['info', '-plist', '/'], { encoding: 'utf8', timeout: 5000 });
      const flag = /<key>SolidState<\/key>\s*<(true|false)\s*\/>/.exec(plist)?.[1];
      return flag === 'true' ? 'SSD' : flag === 'false' ? 'HDD' : null;
    }
    if (platform() === 'linux') {
      const media = readdirSync('/sys/block').filter(n => !/^(loop|ram|dm-)/.test(n)).map(n => readFileSync(`/sys/block/${n}/queue/rotational`, 'utf8').trim());
      return media.length && new Set(media).size === 1 ? media[0] === '0' ? 'non-rotating (system devices)' : 'rotating (system devices)' : null;
    }
    if (platform() === 'win32') {
      const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-PhysicalDisk | Select-Object -ExpandProperty MediaType -Unique'], { encoding: 'utf8', timeout: 10000 }).trim();
      return ['SSD', 'HDD'].includes(text) ? `${text} (system devices)` : null;
    }
  } catch { /* unsupported or restricted hardware probe: unknown, never guessed */ }
  return null;
}
function systemModel() {
  try {
    if (platform() === 'darwin') return execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], { encoding: 'utf8', timeout: 5000 }).trim() || null;
    if (platform() === 'linux') return readFileSync('/sys/class/dmi/id/product_name', 'utf8').trim() || null;
    if (platform() === 'win32') return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystem).Model'], { encoding: 'utf8', timeout: 10000 }).trim() || null;
  } catch { /* model unavailable: never substitute a manually supplied hardware value */ }
  return null;
}
function osProductVersion() {
  try {
    if (platform() === 'darwin') return execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5000 }).trim() || null;
    if (platform() === 'linux') return /^PRETTY_NAME=["']?([^\r\n"']+)/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? null;
    if (platform() === 'win32') return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$osInfo = Get-CimInstance Win32_OperatingSystem; "$($osInfo.Caption) $($osInfo.Version)"'], { encoding: 'utf8', timeout: 10000 }).trim() || null;
  } catch { /* keep the independently captured kernel/build version; no guessed product version */ }
  return null;
}
export function hardware() {
  // An explicit allowlist. Never include hostname, username, serials, environment or network addresses.
  return { systemModel: systemModel(), cpuModel: cpus()[0]?.model ?? null, logicalCores: cpus().length, ramBytes: totalmem(), os: platform(), osVersion: release(), osProductVersion: osProductVersion(), architecture: arch(), storageType: storageType(), storageNote: 'Best effort: macOS root-volume flag; Linux/Windows only when system devices report a single medium type. Unknown/mixed stays null. No disk identifiers retained.' };
}
export function render(report) {
  return '# O6 reference hardware report\n\n' + JSON.stringify(report.hardware) + '\n\n' + (report.device ? JSON.stringify(report.device) + '\n\n' + report.device.comparisonNote + '\n\n' : '') + (report.timing ? `Measurement duration: ${report.timing.elapsedMs} ms. Runtime: ${report.node}.\n\n` : '') +
    '| Budget | Policy | Target | Measurement status |\n|---|---|---|---|\n' + budgets.map(b => `| ${b.id} | ${b.policy} | ${b.target} | ${report.status[b.id] ?? 'missing'} |`).join('\n') +
    '\n\nFull samples, warmups, limitations and mock accounting: accompanying JSON. No outliers discarded.\n\n' + report.gaps.map(g => `- ${g}`).join('\n') + '\n';
}
export async function reference({ out, count = 30, real = false, modelsCache, bin, core, baseline, deviceRole, allScenarios = false } = {}) {
  const detected = hardware();
  const device = deviceContext(deviceRole, detected); // validate before creating a home or starting a benchmark
  const startedAt = new Date().toISOString(), started = performance.now();
  const root = mkdtempSync(join(tmpdir(), 'p1b-reference-'));
  const report = { schema: 'plur1bus-reference/v1', hardware: detected, device, timing: { startedAt, elapsedMs: null }, node: process.version, budgets, status: {}, measurements: {}, gaps: [], complete: false };
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const run = (args, timeout = 180000) => execFileSync(process.execPath, args, { cwd: repo, timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
  try {
    runs(count);
    if (allScenarios) {
      modelsCache ??= join(root, 'models-cache');
      mkdirSync(modelsCache, { recursive: true });
    }
    const s = await startup({ count, real: allScenarios ? false : real, cache: modelsCache, bin, core });
    report.measurements.startup = s;
    for (const b of ['B1', 'B8', 'B11']) report.status[b] = s.errors.length ? 'error: see startup.errors' : 'measured';
    if (allScenarios) {
      const models = await startup({ count, real: true, cache: modelsCache, bin, core });
      report.measurements.startupModels = models;
      if (models.errors.length) report.status.B8 = 'error: see startupModels.errors';
    }
    const runtimeReal = real || allScenarios;
    // Runtime writes into this run's temp root; its own Core uses another fresh temporary home.
    const runtimeFile = join(root, 'runtime.json');
    let runtimeError = false;
    try { run(['--experimental-strip-types', '--conditions=source', 'scripts/bench/runtime.ts', runtimeFile, ...(runtimeReal ? ['--real-models', '--models-cache', resolve(modelsCache)] : [])], 600000); }
    catch { runtimeError = true; report.gaps.push('Runtime probe failed or timed out; no test duration is substituted for a benchmark.'); }
    try {
      const r = JSON.parse(readFileSync(runtimeFile, 'utf8')); report.measurements.runtime = r;
      for (const result of r.results) report.status[result.budget] = result.status ?? (result.passed === false ? 'target missed' : 'measured');
      if (r.errors.length) report.gaps.push(...r.errors.map(e => `Runtime: ${e}`));
    } catch { if (!runtimeError) report.gaps.push('Runtime probe wrote no valid report.'); }
    for (const [id, file] of [['B6', 'packages/core/test/prompt/b6-determinism.test.ts'], ['B9', 'packages/core/test/b9-no-syscalls.test.ts']]) {
      try { run(['--experimental-strip-types', '--conditions=source', '--no-warnings=ExperimentalWarning', '--test', '--test-concurrency=1', file]); report.status[id] = 'assertion passed'; report.measurements[id] = { passed: true, source: file, measuredValue: 0, warmups: 'test-defined; invariant, not a percentile' }; }
      catch { report.status[id] = 'assertion failed'; report.measurements[id] = { passed: false, source: file }; }
    }
    if (baseline) {
      const old = JSON.parse(readFileSync(baseline, 'utf8')).measurements.runtime.results.find(r => r.budget === 'B7');
      const now = report.measurements.runtime?.results.find(r => r.budget === 'B7');
      if (old && now && old.corpus === now.corpus && old.total > 0) { now.regressionFraction = now.total / old.total - 1; now.alert = now.regressionFraction > .1; }
      else report.gaps.push('B7 baseline missing or incompatible; regression cannot be calculated.');
    } else report.gaps.push('B7 absolute token counts only: supply --baseline for the >10% regression alert.');
    report.gaps.push('B10 incomplete: an RSS observation does not prove the configured ceiling or two-identity + reranker LRU eviction soak.');
    report.gaps.push('B2 starts at RPC client submit; CLI-launch-to-submit time is excluded. B3 uses in-memory mock SSE. B5/B7 use synthetic usage derived from wire prefix bytes, not vendor tokenization.');
    report.gaps.push('B9 is the existing JavaScript entry-point proxy, not complete native syscall tracing.');
    if (!runtimeReal) report.gaps.push('Flat embedding seam: repeat with --real-models and a populated cache for model latency and memory evidence.');
    if (device.virtualMachine !== false) report.gaps.push(device.comparisonNote);
    report.executionFailed = (report.measurements.startupModels?.errors.length ?? 0) > 0 || s.errors.length > 0 || runtimeError || !report.measurements.runtime || report.measurements.runtime.errors.length > 0 || ['B6', 'B9'].some(id => report.measurements[id]?.passed !== true);
    report.complete = budgets.every(b => ['measured', 'assertion passed'].includes(report.status[b.id]));
  } finally {
    report.timing.elapsedMs = Math.round(performance.now() - started);
    rmSync(root, { recursive: true, force: true });
    if (out) {
      mkdirSync(resolve(out, '..'), { recursive: true });
      writeFileSync(`${out}.json`, JSON.stringify(report, null, 2) + '\n');
      writeFileSync(`${out}.md`, render(report));
    }
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'reference-hardware' }, runs: { type: 'string' }, 'real-models': { type: 'boolean' }, 'models-cache': { type: 'string' }, baseline: { type: 'string' }, 'device-role': { type: 'string' }, 'all-scenarios': { type: 'boolean' } } });
  if (values['real-models'] && !values['models-cache'] && !values['all-scenarios']) throw new Error('--real-models requires --models-cache');
  const r = await reference({ out: values.out, count: runs(values.runs), real: values['real-models'], modelsCache: values['models-cache'], baseline: values.baseline, deviceRole: values['device-role'], allScenarios: values['all-scenarios'] });
  console.log(render(r)); process.exitCode = r.executionFailed ? 1 : r.complete ? 0 : 2;
}
