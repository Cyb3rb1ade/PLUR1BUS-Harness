import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluateGate, selections} from './gate.mjs';

const flags = extra => ({proceed:'true', macos:'false', rust:'false', 'ts-core':'false', web:'false',
  python:'false', documents:'false', workflows:'false', 'engine-pin':'false', 'docs-only':'true', ...extra});
const needs = outputs => ({changes:{result:'success',outputs}, ...Object.fromEntries(
  Object.entries(selections(outputs)).map(([job,selected]) => [job,{result:selected?'success':'skipped'}]))});

test('macOS browser selection requires proceed, web and macos together', () => {
  for (const proceed of ['true','false']) for (const web of ['true','false']) for (const macos of ['true','false']) {
    const outputs=flags({proceed,web,macos});
    assert.equal(selections(outputs)['web-browser-macos'], proceed==='true' && web==='true' && macos==='true');
    for (const result of ['success','failure','skipped','cancelled',undefined,'','unknown']) {
      const input=needs(outputs);
      if (result===undefined) delete input['web-browser-macos'];
      else input['web-browser-macos']={result};
      assert.equal(evaluateGate(input).length===0, ['success','failure','skipped'].includes(result), `${proceed}/${web}/${macos}/${result}`);
    }
  }
});

test('macos output is validated and Linux browser failure remains blocking', () => {
  for (const macos of [undefined,'',true,'TRUE']) {
    assert(evaluateGate(needs(flags({macos}))).some(error=>error.includes('macos')));
  }
  const input=needs(flags({web:'true',macos:'true'}));
  input['web-browser-macos']={result:'failure'};
  assert.deepEqual(evaluateGate(input),[]);
  input['web-browser']={result:'failure'};
  assert(evaluateGate(input).some(error=>error.includes('web-browser: failure')));
});

test('actual macOS workflow and gate dependencies use changes and retain the #621 browser contract', () => {
  const yaml=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
  const block=yaml.split('  web-browser-macos:\n')[1].split('\n  web-browser:\n')[0];
  assert.match(block,/^    needs: changes$/m);
  assert.match(block,/^    if: needs\.changes\.outputs\.proceed == 'true' && needs\.changes\.outputs\.web == 'true' && needs\.changes\.outputs\.macos == 'true'$/m);
  assert.match(block,/shard: \[1, 2\]/);
  assert.match(block,/PLUR1BUS_WEB_E2E_REQUIRED: "1"/);
  assert.match(block,/playwright install chromium/);
  assert.match(block,/timeout-minutes: 45/);
  assert.match(yaml.split('  ci-gate:\n')[1],/^    needs: \[[^\]]*web-browser-macos[^\]]*\]/m);
});
