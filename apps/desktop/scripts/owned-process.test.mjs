import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOwnedChild, removeExitedProfile, ownedProfileFailureMessage } from './owned-process.mjs';

test('process closes before its owned profile is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-process-test-'));
  await writeFile(join(root, 'fixture'), 'synthetic');
  const result = await runOwnedChild(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 30)'], {}, 2000);
  assert.equal(result.status, 0);
  assert.equal(result.timedOut, false);
  await removeExitedProfile(root);
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});

test('sharing failures retry exactly ten times and preserve final reason', async () => {
  let attempts = 0, waits = 0;
  await assert.rejects(removeExitedProfile('synthetic', {
    rm: async () => { attempts++; throw Object.assign(new Error('private path'), { code: 'EPERM' }); },
    delay: async ms => { assert.equal(ms, 100); waits++; },
    lstat: async () => assert.fail('verify must not run after failed delete'),
  }), /OWNED_PROFILE_DELETE_FAILED code=EPERM retries=10/);
  assert.equal(attempts, 11); assert.equal(waits, 10);
});

test('transient sharing failure succeeds; unrelated failure never retries', async () => {
  let attempts = 0;
  await removeExitedProfile('synthetic', {
    rm: async () => { if (++attempts === 1) throw Object.assign(new Error(), { code: 'ENOTEMPTY' }); },
    delay: async () => {}, lstat: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); },
  });
  assert.equal(attempts, 2);
  await assert.rejects(removeExitedProfile('synthetic', {
    rm: async () => { throw Object.assign(new Error(), { code: 'EACCES' }); },
    delay: async () => assert.fail('no retry'), lstat: async () => {},
  }), /code=EACCES retries=0/);
});

test('bounded child timeout waits for process close and reports its signal', async () => {
  const result = await runOwnedChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, 50);
  assert.equal(result.timedOut, true);
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, 'SIGKILL');
});

test('native fixtures preserve the actual bounded cleanup category', async () => {
  let failure;
  try {
    await removeExitedProfile('synthetic', {
      rm: async () => { throw Object.assign(new Error('private path'), { code: 'EPERM' }); },
      delay: async () => {}, lstat: async () => assert.fail('delete did not succeed'),
    });
  } catch (error) { failure = error; }
  assert.equal(ownedProfileFailureMessage(failure), 'OWNED_PROFILE_DELETE_FAILED code=EPERM retries=10');
});

test('native cleanup diagnostics reject arbitrary text and unbounded categories', () => {
  for (const value of [
    new Error('private path'),
    new Error('OWNED_PROFILE_DELETE_FAILED code=EPERM retries=10\nprivate path'),
    new Error('OWNED_PROFILE_DELETE_FAILED code=EPERM retries=11'),
    new Error('OWNED_PROFILE_DELETE_FAILED code=ENOENT retries=0'),
    null, 'OWNED_PROFILE_RETAINED exists=true',
  ]) assert.equal(ownedProfileFailureMessage(value), undefined);
  assert.equal(ownedProfileFailureMessage(new Error('OWNED_PROFILE_VERIFY_FAILED code=OTHER')), 'OWNED_PROFILE_VERIFY_FAILED code=OTHER');
  assert.equal(ownedProfileFailureMessage(new Error('OWNED_PROFILE_RETAINED exists=true')), 'OWNED_PROFILE_RETAINED exists=true');
});
