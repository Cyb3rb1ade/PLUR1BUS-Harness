import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { roleFields } from '../src/pages/settings/config/roles.ts';
import { collectChanges, initialDraft } from '../src/pages/settings/config/model.ts';
import { initial, changesFor, stepsFor } from '../src/pages/setup/model.ts';
import { browserSkip, setup, teardown, withApp, openRoute } from './harness.ts';
import { seedConfig } from './settings-config-fixtures.ts';
import { installCatalog } from './models-fixtures.ts';
import { expectAxeClean } from './axe.ts';
import { next, seed, skip, stepHeading } from './setup-fixtures.ts';
before(setup); after(teardown);
test('role fields preserve stored values and reject unavailable catalog choices', () => {
  const fields = roleFields({ modelRoles: { decision: 'old/profile' } }, { models: [{ provider: 'p', id: 'gone', kind: 'chat', status: 'unavailable' }] });
  assert.equal(fields.length, 8);
  const decision = fields.find(f => f.key === 'modelRoles.decision')!;
  assert.equal(decision.value, 'old/profile');
  const draft = { ...initialDraft(fields), 'modelRoles.decision': 'p/gone' };
  assert.equal(collectChanges(fields, draft).changes.length, 0);
  assert.ok(collectChanges(fields, draft).errors['modelRoles.decision']);
});
test('decision setup is optional, after chat, and never chooses a model by default', () => {
  const ids = stepsFor(false).map(s => s.id);
  assert.equal(ids.indexOf('decision'), ids.indexOf('model') + 1);
  const a = initial().answers;
  assert.deepEqual(changesFor('decision', a), []);
  a.decisionModel = 'p/small';
  assert.deepEqual(changesFor('decision', a), [{ key: 'modelRoles.decision', value: 'p/small' }]);
});
test('settings save roles with revision and test the selected model; axe and 400 px', { skip: browserSkip }, async () => {
  await withApp({ width: 400 }, async app => {
    const config = seedConfig(app.server.rpc);
    installCatalog(app.server.rpc);
    app.server.rpc.handle('models.test', () => ({ ok: true, durationMs: 1 }));
    await openRoute(app.page, '#/settings/models');
    const select = app.page.locator('#cfg-modelRoles-decision');
    await select.selectOption('alpha/alpha-1');
    await app.page.locator('[data-key="modelRoles.decision"]').getByRole('button', { name: 'Test', exact: true }).click();
    await app.page.getByText('Model responded successfully.', { exact: true }).waitFor();
    await app.page.getByRole('button', { name: 'Review changes', exact: true }).click();
    await app.page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await app.page.getByText(/Saved 1 changes/).waitFor();
    assert.equal((config.sets[0] as { ifRevision: string }).ifRevision, 'r1');
    assert.equal((config.config.modelRoles as Record<string, string>).decision, 'alpha/alpha-1');
    await expectAxeClean(app.page, 'model roles 400px');
    assert.ok(await app.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  });
});
test('wizard writes only an explicitly selected decision model with revision', { skip: browserSkip }, async () => {
  await withApp({}, async app => {
    seed(app.server.rpc); await openRoute(app.page, '#/setup');
    await next(app.page);
    await app.page.getByLabel('Display name').fill('Hal'); await next(app.page);
    await skip(app.page);
    await stepHeading(app.page, /Decision model/).waitFor();
    await app.page.getByLabel('Decision model', { exact: true }).selectOption('anthropic/claude-x');
    await next(app.page); await stepHeading(app.page, /Switchboard/).waitFor();
    const write = app.server.rpc.calls.filter(c => c.method === 'config.set').at(-1)!;
    assert.deepEqual(write.params, { changes: [{ key: 'modelRoles.decision', value: 'anthropic/claude-x' }], ifRevision: 'r1' });
  });
});
