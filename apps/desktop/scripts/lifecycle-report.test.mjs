import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lifecycleFields, lifecycleFailure, launcherSkip} from './lifecycle-report.mjs';
const complete = () => ({...Object.fromEntries(lifecycleFields.map(field => [field, true])), second_instance_focus_mode: 'strict'});
test('only a complete strict second-instance report passes', () => {
  assert.equal(lifecycleFailure(complete()), undefined);
  for (const mode of ['lenient', undefined, true]) assert.equal(lifecycleFailure({...complete(), second_instance_focus_mode: mode}), 'second_instance_focus_mode');
  assert.equal(lifecycleFailure({...complete(), second_instance_focus: false}), 'second_instance_focus');
  assert.equal(lifecycleFailure({...complete(), extra: true}), 'extra-fields');
  assert.equal(lifecycleFailure(null), 'invalid-report');
});
test('an explicit Windows launcher skip preserves all other lifecycle obligations', () => {
  const skipped = {...complete(), second_instance_focus:launcherSkip, second_instance_focus_mode:launcherSkip};
  assert.equal(lifecycleFailure(skipped), 'second_instance_focus_mode');
  assert.equal(lifecycleFailure(skipped, {allowWindowsSkip:true}), undefined);
  for (const field of lifecycleFields.filter(field => field !== 'second_instance_focus')) {
    assert.equal(lifecycleFailure({...skipped, [field]:false}, {allowWindowsSkip:true}), field);
  }
  assert.equal(lifecycleFailure({...skipped, second_instance_focus:true}, {allowWindowsSkip:true}), 'second_instance_focus_mode');
  assert.equal(lifecycleFailure({...skipped, second_instance_focus_mode:'strict'}, {allowWindowsSkip:true}), 'second_instance_focus');
});
