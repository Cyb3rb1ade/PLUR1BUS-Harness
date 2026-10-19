import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docDiff } from './doc-diff.mjs';
test('stale docs include a readable unified diff with the complete expected changed lines', () => {
  const diff = docDiff('docs/cli.md', '# CLI\nold command\n', '# CLI\nnew command\n');
  assert.match(diff, /--- a\/docs\/cli.md\n\+\+\+ b\/docs\/cli.md/);
  assert.match(diff, /-old command\n\+new command/);
});
test('CRLF differences do not create a documentation diff', () => {
  assert.equal(docDiff('docs/cli.md', 'same\r\n', 'same\n'), '');
});
