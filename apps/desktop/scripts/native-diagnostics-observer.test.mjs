import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source = readFileSync(new URL('../src-tauri/examples/production_diagnostics.rs', import.meta.url), 'utf8');
const script = source.match(/const CRASH_MODAL_OBSERVER: &str = r#"([\s\S]*?)"#;/)?.[1];
assert.ok(script, 'exercise the actual native observer');
function observe(dialog) {
  const titles = []; const cleared = []; let tick;
  const document = {querySelector(selector) { assert.equal(selector, 'dialog[data-crash-offer]'); return dialog; },
    get title() { return titles.at(-1) ?? ''; }, set title(value) { titles.push(value); }};
  runInNewContext(script, {document, setInterval(callback, ms) { assert.equal(ms, 20); tick = callback; return 7; }, clearInterval(id) { cleared.push(id); }});
  return {titles, cleared, tick: () => tick()};
}
const dialog = (textContent, childElementCount = 0) => ({open:true, querySelector: () => ({textContent, childElementCount})});
test('native crash observer distinguishes an absent or closed modal without repeated title traffic', () => {
  for (const [view, expected] of [[null, 'DIAGNOSTICS_MODAL_ABSENT'], [{open:false}, 'DIAGNOSTICS_MODAL_CLOSED']]) {
    const result = observe(view); result.tick(); result.tick();
    assert.deepEqual(result.titles, ['DIAGNOSTICS_OBSERVER_STARTED', expected]);
    assert.deepEqual(result.cleared, []);
  }
});
test('native crash observer emits only closed classification codes for rejected content', () => {
  for (const [view, expected] of [
    [{open:true, querySelector:()=>null}, 'DIAGNOSTICS_MODAL_PRE_ABSENT'],
    [dialog('untrusted text'), 'DIAGNOSTICS_MODAL_HEADER_ABSENT'],
    [dialog('PLUR1BUS desktop crash'), 'DIAGNOSTICS_MODAL_BACKTRACE_ABSENT'],
    [dialog('PLUR1BUS desktop crash Backtrace:', 1), 'DIAGNOSTICS_MODAL_NOT_PLAIN_TEXT'],
    ...['wp06NativeCrashCanary', 'wp06NativeTicket', 'wp06NativeCookie'].map(value => [dialog('PLUR1BUS desktop crash Backtrace: '+value), 'DIAGNOSTICS_MODAL_SECRET_DETECTED']),
  ]) {
    const result = observe(view); result.tick();
    assert.deepEqual(result.titles, ['DIAGNOSTICS_OBSERVER_STARTED', expected]);
    assert.deepEqual(result.cleared, [7]);
  }
});
test('native crash observer accepts complete redacted plain text', () => {
  const result = observe(dialog('PLUR1BUS desktop crash v1\nBacktrace:\n[REDACTED]'));
  result.tick();
  assert.deepEqual(result.titles, ['DIAGNOSTICS_OBSERVER_STARTED', 'WP6_CRASH_MODAL']);
  assert.deepEqual(result.cleared, [7]);
});
