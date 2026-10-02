// Launch the real platform WebView in a deliberately isolated diagnostic process.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, release, version } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(resolve(process.env.RUNNER_TEMP || tmpdir(), 'plur1bus-native-spike-run-'));
const result = resolve(root, 'native-transport.json');
const build = spawnSync('cargo', ['build', '--locked', '-p', 'plur1bus-desktop', '--example', 'transport_spike'], { cwd: desktop, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const env = { ...process.env, TMPDIR: root, TEMP: root, TMP: root, HOME: resolve(root, 'home'), USERPROFILE: resolve(root, 'home'),
  CFFIXED_USER_HOME: resolve(root, 'home'), XDG_CONFIG_HOME: resolve(root, 'config'),
  XDG_CACHE_HOME: resolve(root, 'cache'), XDG_DATA_HOME: resolve(root, 'data') };
for (const name of ['HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME']) mkdirSync(env[name], { recursive: true });
const child = spawnSync(resolve(desktop, 'target/debug/examples/transport_spike' + (process.platform === 'win32' ? '.exe' : '')), [result], {
  cwd: root, env, encoding: 'utf8', timeout: 75000, maxBuffer: 1024 * 1024,
});
writeFileSync(resolve(root, 'native-process.log'), `${child.stdout ?? ''}\n${child.stderr ?? ''}`);
console.log(`Native diagnostic artifacts: ${root}`);
if (child.status !== 0) { console.error(child.error?.message ?? `Native diagnostic exit ${child.status}`); process.exit(1); }
const report = JSON.parse(readFileSync(result, 'utf8'));
report.host = { osRelease: release(), osVersion: version() };
writeFileSync(result, JSON.stringify(report, null, 2) + '\n');
for (const kind of ['custom','loopback']) {
  const value = report.observations?.[kind];
  if (!value?.userAgent || value.kind !== kind || !value.sse || !value.websocket || !value.download || !value.latency) throw Error(`Incomplete native observation: ${kind}`);
  console.log(JSON.stringify({ os: report.os, arch: report.arch, kind, ...value }));
}
// An unsupported custom transport is a valid measured result, not a CI failure.
// Infrastructure failures and missing observations fail this collection command.
