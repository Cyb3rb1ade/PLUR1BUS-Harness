import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// The nightly canary runs `git apply apps/desktop/canary/tauri3.patch` on a fresh checkout. A change to the lines
// the patch touches (a dependency bump or a new plugin in src-tauri/Cargo.toml, the builder line in lib.rs) used
// to leave it stale unnoticed: the job failed with "patch does not apply" for days and said nothing about Tauri 3.
test('the Tauri 3 canary patch still applies to this checkout', (t) => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {cwd: here, encoding: 'utf8'});
  if (top.status !== 0) {
    t.skip('not a git checkout, or git is not installed');
    return;
  }
  const check = spawnSync('git', ['apply', '--check', '--ignore-whitespace', 'apps/desktop/canary/tauri3.patch'], {
    cwd: top.stdout.trim(),
    encoding: 'utf8',
  });
  assert.equal(check.status, 0, `apps/desktop/canary/tauri3.patch no longer applies; regenerate it with the new context.\n${check.stderr}`);
});
