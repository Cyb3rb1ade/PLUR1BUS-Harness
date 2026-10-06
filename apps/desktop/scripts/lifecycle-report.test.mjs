import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lifecycleFields, lifecycleFailure} from './lifecycle-report.mjs';
const complete = () => ({...Object.fromEntries(lifecycleFields.map(field => [field, true])), second_instance_focus_mode: 'strict'});
test('only a complete strict second-instance report passes', () => {
  assert.equal(lifecycleFailure(complete()), undefined);
  for (const mode of ['lenient', undefined, true]) assert.equal(lifecycleFailure({...complete(), second_instance_focus_mode: mode}), 'second_instance_focus_mode');
  assert.equal(lifecycleFailure({...complete(), second_instance_focus: false}), 'second_instance_focus');
  assert.equal(lifecycleFailure({...complete(), extra: true}), 'extra-fields');
  assert.equal(lifecycleFailure(null), 'invalid-report');
});
