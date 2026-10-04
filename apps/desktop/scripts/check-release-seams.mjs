import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// A debug positive control prevents an incorrect binary path or ineffective search
// from silently proving absence. Do not scan bundles: inspect the executable itself.
const [debugPath, releasePath] = process.argv.slice(2);
assert(debugPath && releasePath, 'expected debug and release executable paths');
const debug = readFileSync(debugPath);
const release = readFileSync(releasePath);
const markers = ['PLUR1BUS_DESKTOP_CONFIG_DIR', 'PLUR1BUS_DESKTOP_COOKIE_GUARD'];
assert(debug.includes(Buffer.from(markers[0])), 'debug fixture marker missing: invalid positive control');
if (process.platform === 'win32') {
  assert(debug.includes(Buffer.from(markers[1])), 'Windows debug guard switch missing: invalid positive control');
}
for (const marker of markers) {
  assert(!release.includes(Buffer.from(marker)), `release fixture marker present: ${marker}`);
}
console.log('PASS: debug fixture positive control; release fixture env switches absent');
