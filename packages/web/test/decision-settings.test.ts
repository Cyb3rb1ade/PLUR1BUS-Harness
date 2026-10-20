import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { expectAxeClean } from './axe.ts';
import { openRoute, setup, teardown, withApp } from './harness.ts';
import { seedConfig } from './settings-config-fixtures.ts';
import { rpcError } from './mock-rpc.ts';
before(setup); after(teardown);
function install(app: any) {
  const fake = seedConfig(app.server.rpc, { decision: { backend: 'role' } });
  app.server.rpc.handle('agent.list', () => ({ agents: [{ agentId: 'main', open: false }] }), { write: false });
  app.server.rpc.handle('decision.status', () => ({ backend: 'role', installed: ['role'], requests: 12, failures: 2, errorRate: 1 / 6, p50Ms: 4, p95Ms: 18 }), { write: false });
  app.server.rpc.handle('decision.test', () => ({ ok: true, durationMs: 5, outcome: 'accepted', backend: 'role' }));
  return fake;
}
test('decision settings show metrics and provisional native evidence; revision save and fixed diagnostic', async () => {
  await withApp({ width: 400 }, async app => {
    const f = install(app); await openRoute(app.page, '#/settings/decision');
    await app.page.locator('#decision-test').waitFor();
    await app.page.locator('#decision-status').filter({ hasText: 'p95: 18 ms' }).waitFor();
    assert.match(await app.page.locator('#decision-evidence').innerText(), /46.67.*65.00/);
    await app.page.locator('#decision-test').click(); await app.page.getByText('Diagnostic passed (5 ms).').waitFor();
    assert.deepEqual(app.server.rpc.calls.filter(c => c.method === 'decision.test').map(c => c.params), [{ agentId: 'main' }]);
    await app.page.locator('#cfg-decision-backend').selectOption('auto');
    await app.page.getByRole('button', { name: 'Review changes', exact: true }).click();
    await app.page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await app.page.getByText(/Saved 1 change/).waitFor();
    assert.deepEqual(f.sets, [{ changes: [{ key: 'decision.backend', value: 'auto' }], ifRevision: 'r1' }]);
    await expectAxeClean(app.page, 'decision settings'); assert.deepEqual(app.problems, []);
  });
});
for (const role of ['member', 'viewer', 'operator', 'agent', 'unknown']) test(`${role} cannot invoke or configure diagnostic`, async () => {
  await withApp({ server: { role } }, async app => {
    install(app); await openRoute(app.page, '#/settings/decision');
    await app.page.locator('#decision-evidence').waitFor();
    assert.equal(await app.page.locator('#decision-test').count(), 0);
    assert.equal(await app.page.locator('#cfg-decision-backend').count(), 0);
    assert.equal(app.server.rpc.calls.filter(c => c.method === 'decision.test' || c.method === 'config.set').length, 0);
  });
});
test('German gate failure and refused diagnostic are explicit; Admin controls and axe', async () => {
  await withApp({ width: 400, locale: 'de-DE', server: { role: 'admin' } }, async app => {
    install(app); app.server.rpc.handle('decision.test', () => { throw rpcError('E_DENIED', 'denied'); });
    await openRoute(app.page, '#/settings/decision', 'de');
    await app.page.locator('#decision-test').click();
    await app.page.getByRole('alert').filter({ hasText: 'Diagnose verweigert oder nicht verfügbar' }).waitFor();
    assert.match(await app.page.locator('#decision-evidence').innerText(), /Deutsch-Gate nicht bestanden/);
    assert.match(await app.page.locator('#decision-evidence').innerText(), /Linux.*Windows.*Kev/);
    await expectAxeClean(app.page, 'decision settings');
  });
});

test('unavailable status and unsuccessful diagnostics retain explicit states', async () => {
  await withApp({}, async app => {
    install(app); app.server.rpc.handle('decision.status', () => { throw rpcError('E_NOT_AVAILABLE', 'not ready'); }, { write: false });
    app.server.rpc.handle('decision.test', () => ({ ok: false, durationMs: 17, outcome: 'privacy' }));
    await openRoute(app.page, '#/settings/decision');
    await app.page.getByText('Decision status is unavailable.').waitFor();
    await app.page.locator('#decision-test').click();
    await app.page.getByRole('alert').filter({ hasText: 'Diagnostic failed: privacy (17 ms).' }).waitFor();
  });
});
test('leaving during a diagnostic aborts UI delivery without stale notices', async () => {
  await withApp({}, async app => {
    install(app); app.server.rpc.setDelay('decision.test', 400);
    await openRoute(app.page, '#/settings/decision');
    await app.page.locator('#decision-test').click();
    await app.page.getByRole('button', { name: 'Running diagnostic…' }).waitFor();
    await app.page.evaluate(() => { location.hash = '#/settings/general'; });
    await app.page.locator('#cfg-core-logLevel').waitFor();
    await app.page.waitForTimeout(450);
    assert.equal(await app.page.getByText(/Diagnostic passed/).count(), 0); assert.deepEqual(app.problems, []);
  });
});

test('empty registered agents disable the diagnostic without an RPC invocation', async () => {
  await withApp({}, async app => {
    install(app); app.server.rpc.handle('agent.list', () => ({ agents: [] }), { write: false });
    await openRoute(app.page, '#/settings/decision');
    await app.page.getByText('Register an agent before running this diagnostic.').waitFor();
    assert.equal(await app.page.locator('#decision-test').isDisabled(), true);
    assert.equal(app.server.rpc.calls.filter(c => c.method === 'decision.test').length, 0);
    app.server.rpc.handle('agent.list', () => ({ agents: [{ agentId: 'main' }] }), { write: false });
    await app.page.getByRole('button', { name: 'Refresh status' }).click();
    await app.page.getByText('Diagnostic agent: main').waitFor();
    await app.page.locator('#decision-test').click();
    await app.page.getByText('Diagnostic passed (5 ms).').waitFor();
    assert.deepEqual(app.server.rpc.calls.filter(c => c.method === 'decision.test').map(c => c.params), [{ agentId: 'main' }]);
  });
});
