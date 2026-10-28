import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluateGate, selections, UNGATED} from './gate.mjs';

const flags = extra => ({proceed:'true', macos:'false', rust:'false', 'ts-core':'false', web:'false',
  python:'false', documents:'false', workflows:'false', 'engine-pin':'false', 'docs-only':'true', ...extra});
const needs = outputs => ({changes:{result:'success',outputs}, ...Object.fromEntries(
  Object.entries(selections(outputs)).map(([job,selected]) => [job,{result:selected?'success':'skipped'}]))});

// Owner decision of 2026-10-28: the gate no longer waits for the macOS browser shards. They still run under the macOS
// policy and report their own check, but no outcome of theirs can delay or decide a merge.
test('the macOS browser shards are outside the gate for every plan', () => {
  assert(UNGATED.includes('web-browser-macos'));
  for (const proceed of ['true','false']) for (const web of ['true','false']) for (const macos of ['true','false']) {
    const outputs=flags({proceed,web,macos});
    assert(!('web-browser-macos' in selections(outputs)), `${proceed}/${web}/${macos}`);
    assert.deepEqual(evaluateGate(needs(outputs)), [], `${proceed}/${web}/${macos}`);
  }
});

test('macos output is validated and Linux browser failure remains blocking', () => {
  for (const macos of [undefined,'',true,'TRUE']) {
    assert(evaluateGate(needs(flags({macos}))).some(error=>error.includes('macos')));
  }
  const input=needs(flags({web:'true',macos:'true'}));
  assert.deepEqual(evaluateGate(input),[]);
  input['web-browser']={result:'failure'};
  assert(evaluateGate(input).some(error=>error.includes('web-browser: failure')));
});

test('actual macOS workflow keeps the #621 browser contract and the gate does not need it', () => {
  const yaml=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
  const block=yaml.split('  web-browser-macos:\n')[1].split('\n  web-browser:\n')[0];
  assert.match(block,/^    needs: changes$/m);
  assert.match(block,/^    if: needs\.changes\.outputs\.proceed == 'true' && needs\.changes\.outputs\.web == 'true' && needs\.changes\.outputs\.macos == 'true'$/m);
  assert.match(block,/shard: \[1, 2\]/);
  assert.match(block,/PLUR1BUS_WEB_E2E_REQUIRED: "1"/);
  assert.match(block,/playwright install chromium/);
  assert.match(block,/timeout-minutes: 45/);
  assert.doesNotMatch(yaml.split('  ci-gate:\n')[1],/^    needs: \[[^\]]*web-browser-macos[^\]]*\]/m);
});
