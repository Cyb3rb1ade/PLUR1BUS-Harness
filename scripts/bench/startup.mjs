// Repeated process starts; never flush OS caches or modify system configuration.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir, platform, arch, release } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { connect } from '@plur1bus/module-api';
import { defaults } from '@plur1bus/config-schema';
import { distribution, runs } from './metrics.mjs';

const pause = ms => new Promise(r => setTimeout(r, ms));
export async function startup({ count = 30, real = false, cache, bin = resolve(process.env.PLUR1BUS_BIN ?? `target/release/plur1bus${platform() === 'win32' ? '.exe' : ''}`), core = resolve(process.env.PLUR1BUS_CORE_JS ?? 'packages/core/dist/core.js') } = {}) {
  runs(count);
  const report = { schema: 'plur1bus-startup/v1', target: `${platform()}-${arch()}`, os: release(), node: process.version,
    runner: process.env.RUNNER_ENVIRONMENT ?? 'local', runnerLabel: process.env.PERF_RUNNER_LABEL ?? 'local',
    methodology: 'Cold = new process + fresh home, zero warmups; OS page/antivirus caches uncontrolled. Warm = new process, same home, 3 warmups. B8 = fresh home per start, 1 discarded warmup. No outliers removed.', results: [], errors: [] };
  const root = mkdtempSync(join(tmpdir(), 'p1b-perf-'));
  try {
    report.binarySha256 = createHash('sha256').update(readFileSync(bin)).digest('hex');
    const cold = [], warm = [];
    for (let i = 0; i < count; i++) {
      const home = join(root, `help-${i}`);
      const t = performance.now();
      execFileSync(bin, ['--home', home, '--help'], { stdio: 'ignore', timeout: 30_000 });
      cold.push(performance.now() - t);
    }
    for (let i = -3; i < count; i++) {
      const t = performance.now();
      execFileSync(bin, ['--home', join(root, 'help-warm'), '--help'], { stdio: 'ignore', timeout: 30_000 });
      if (i >= 0) warm.push(performance.now() - t);
    }
    for (const [scenario, values, warmups] of [['cold-process', cold, 0], ['warm-process', warm, 3]]) report.results.push({ budget: 'B1', scenario, mode: 'advisory', reason: 'New five-target job: promotion requires three consecutive green runs and a separate commit.', limitMs: 100, ...distribution(values, warmups) });
    const socket = [], healthy = [], rpc = [];
    const series = [['socket-ready', socket], ['healthy-ready', healthy]].map(([scenario, samples]) => ({ budget: 'B8', scenario: `${real ? 'real-models' : 'flat-embedder'}-${scenario}`, mode: 'advisory', reason: 'ADR-010 tracking; local-model and reference hardware acceptance reported separately.', limitMs: real ? 15000 : 3000, samples, n: 0, warmups: 1, outliersDiscarded: 0 }));
    report.results.push(...series);
    if (real && !cache) throw new Error('real models require an explicit populated --models-cache');
    for (let i = -1; i < count; i++) {
      const home = join(root, `core-${i}`); mkdirSync(home);
      const cfg = defaults(); cfg.agents.bench = {};
      writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
      if (real) symlinkSync(resolve(cache), join(home, 'models'), platform() === 'win32' ? 'junction' : 'dir');
      const env = { ...process.env, PLUR1BUS_CORE_JS: core, PLUR1BUS_NODE: process.execPath };
      delete env.PLUR1BUS_TEST_INTERNALS; delete env.PLUR1BUS_ALLOW_TEST_INTERNALS;
      if (!real) Object.assign(env, { PLUR1BUS_ALLOW_TEST_INTERNALS: '1', PLUR1BUS_TEST_INTERNALS: 'flat-embedder' });
      const t = performance.now();
      const child = spawn(bin, ['--home', home, 'core', 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let exited = false, client;
      const closed = new Promise(r => { child.once('close', () => { exited = true; r(); }); });
      // Drain logs without publishing paths, tokens or unbounded output.
      child.stderr.resume();
      try {
        const ready = await new Promise((res, rej) => {
          const timer = setTimeout(() => done(new Error('core ready timeout (120 s)')), 120_000);
          let buf = '';
          const done = (err, value) => { clearTimeout(timer); child.stdout.off('data', data); err ? rej(err) : res(value); };
          const data = d => { buf += String(d); if (buf.length > 65536) return done(new Error('oversized ready line')); if (!buf.includes('\n')) return; try { const v = JSON.parse(buf.slice(0, buf.indexOf('\n'))); if (!v.ready || typeof v.address !== 'string') throw new Error('invalid ready line'); done(null, v); } catch { done(new Error('invalid ready line')); } };
          child.stdout.on('data', data);
          child.once('error', () => done(new Error('core spawn failed')));
          child.once('exit', () => done(new Error('core exited before ready')));
        });
        const socketMs = performance.now() - t;
        child.stdout.resume();
        client = await connect({ address: ready.address, expectedServerPid: ready.pid, token: readFileSync(join(home, 'run/core.token'), 'utf8').trim() });
        for (;;) {
          const status = await client.call('core.status', {}, 5000);
          if (status.process.state === 'ready' && status.engine.ready && status.engine.degraded === null) break;
          if (performance.now() - t > 120_000) throw new Error('healthy core timeout (120 s)');
          await pause(10);
        }
        if (i >= 0) { socket.push(socketMs); healthy.push(performance.now() - t); for (const result of series) Object.assign(result, distribution(result.samples, 1)); }
        if (i === count - 1) {
          for (let j = -20; j < 200; j++) { const t1 = performance.now(); await client.call('core.status'); if (j >= 0) rpc.push(performance.now() - t1); }
        }
      } finally {
        if (client) { try { await client.call('core.shutdown', { budgetMs: 5000 }, 6000); } catch { /* exit may precede reply */ } await client.close(); }
        if (!exited && platform() !== 'win32') child.kill('SIGTERM');
        if (!exited && platform() === 'win32') { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 }); } catch { /* already exited */ } }
        const force = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 10_000);
        await closed; clearTimeout(force);
      }
    }
    for (const result of series) Object.assign(result, distribution(result.samples, 1));
    report.results.push({ budget: 'B11', scenario: 'core.status', mode: 'advisory', reason: 'Existing pnpm bench B11 gate is unchanged.', limitMs: 5, ...distribution(rpc, 20) });
  } catch (e) { report.errors.push(e.message); }
  finally { rmSync(root, { recursive: true, force: true }); }
  return report;
}
export function markdown(report) {
  return `# Startup benchmarks: ${report.target}\n\n${report.methodology}\n\n| Budget / scenario | n | warmups | p50 ms | p95 ms | limit ms | result | policy |\n|---|---:|---:|---:|---:|---:|---|---|\n` + report.results.map(r => `| ${r.budget} ${r.scenario} | ${r.n} | ${r.warmups} | ${r.p50?.toFixed(2) ?? '—'} | ${r.p95?.toFixed(2) ?? '—'} | ${r.limitMs} | ${r.n < 30 ? 'INCOMPLETE' : r.p95 < r.limitMs ? 'PASS' : 'SLOW'} | ${r.mode} |`).join('\n') + '\n\n' + report.errors.map(e => `ERROR: ${e}`).join('\n') + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { runs: { type: 'string' }, out: { type: 'string', default: 'startup-benchmark' }, 'real-models': { type: 'boolean' }, 'models-cache': { type: 'string' } } });
  const report = await startup({ count: runs(values.runs), real: values['real-models'], cache: values['models-cache'] });
  writeFileSync(`${values.out}.json`, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(`${values.out}.md`, markdown(report));
  console.log(markdown(report));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(report));
  process.exitCode = report.errors.length ? 1 : 0;
}
