import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsHomePids } from './helpers.ts';

test('Windows reaper selects only the complete home argument, including spaces and regex characters', () => {
  const h = 'C:\\temp\\home (test).1';
  const row = (ProcessId: number, CommandLine: string | null) => ({ ProcessId, CommandLine });
  assert.deepEqual(windowsHomePids([
    row(1001, `node core.js --home "${h}" --test-internals flat-embedder`),
    row(1002, `plur1bus --home "${h}" supervise`),
    row(1003, `node core.js --home "${h}-other"`),
    row(1004, `node core.js --other "${h}"`),
    row(1005, null),
    row(process.pid, `node --home "${h}"`),
  ], h), [1001, 1002]);
  assert.deepEqual(windowsHomePids([row(1006, 'node --home C:\\temp\\h')], 'C:\\temp\\h'), [1006]);
});
