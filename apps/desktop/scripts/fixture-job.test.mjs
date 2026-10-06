import test from 'node:test';
import assert from 'node:assert/strict';
import {jobDiagnostic, jobSafeToDelete} from './fixture-job.mjs';
test('job timeout keeps app/browser image PID and parent evidence without path or title output', () => {
  const valid = 'FIXTURE_JOB_DRAIN_TIMEOUT remaining=production_lifecycle.exe:12:4,msedgewebview2.exe:15:12';
  assert.equal(jobDiagnostic(valid), valid);
  for (const raw of ['C:\\private\\app.exe:12:4', 'app.exe:NaN:4', 'app.exe:0:4', 'app.exe:99999999999999999999:4', 'title with secret:1:2']) assert.equal(jobDiagnostic('FIXTURE_JOB_DRAIN_TIMEOUT remaining=' + raw), undefined);
  assert.equal(jobDiagnostic('FIXTURE_JOB_TERMINATION_UNCONFIRMED'), 'FIXTURE_JOB_TERMINATION_UNCONFIRMED');
});
test('profile deletion requires explicit confirmed zero active processes', () => {
  assert.equal(jobSafeToDelete('FIXTURE_JOB_SAFE_TO_DELETE active=0'), true);
  for (const raw of ['FIXTURE_JOB_SAFE_TO_DELETE active=1', 'FIXTURE_JOB_DRAIN_TIMEOUT remaining=app.exe:1:2', 'FIXTURE_JOB_SAFE_TO_DELETE active=0 extra=title']) assert.equal(jobSafeToDelete(raw), false);
});
