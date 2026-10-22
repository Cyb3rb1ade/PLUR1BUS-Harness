import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { browserSkip, setup, teardown, withApp, openRoute } from './harness.ts';
import { seedSecrets, meta } from './secrets-fixtures.ts';
import { expectAxeClean } from './axe.ts';
before(setup); after(teardown);
test('owner edits only the description; separate from rotation; read view does not imply lease authority', { skip: browserSkip }, async () => {
  await withApp({ width: 400 }, async app => {
    const state = seedSecrets(app.server.rpc, [meta('billing', { description: 'Old billing account' })]);
    app.server.rpc.handle('secret.describe', p => {
      const args = p as { name: string; description: string };
      state.secrets[0]!.description = args.description;
      return state.secrets[0]!;
    });
    app.server.rpc.handle('secret.grants.list', () => ({ agentLeasesEnabled: false, grants: [], references: [{ agentId: 'main', name: 'billing', scope: ['provider:example'], present: true, leaseAllowed: false }] }), { write: false });
    await openRoute(app.page, '#/settings/secrets');
    await app.page.getByRole('button', { name: 'Edit description of billing' }).click();
    const dialog = app.page.getByRole('dialog');
    assert.equal(await dialog.locator('input[type=password]').count(), 0);
    await dialog.getByLabel('Description', { exact: true }).fill('Production billing account');
    await expectAxeClean(app.page, 'secret description dialog 400px');
    await dialog.getByRole('button', { name: 'Save description' }).click();
    await dialog.waitFor({ state: 'detached' });
    await app.page.getByText('Production billing account', { exact: true }).waitFor();
    assert.deepEqual(app.server.rpc.calls.filter(c => c.method === 'secret.describe').map(c => c.params), [{ name: 'billing', description: 'Production billing account' }]);
    assert.equal(app.server.rpc.calls.filter(c => c.method === 'secret.set' || c.method === 'secret.get').length, 0);
    await app.page.getByText('Agent leases are disabled. Configuration references are not grants.', { exact: true }).waitFor();
    assert.ok(await app.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  });
});
