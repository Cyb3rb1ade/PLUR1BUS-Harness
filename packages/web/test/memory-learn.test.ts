import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { setup, teardown, withApp, openRoute, browserSkip } from './harness.ts';
import { defaultFixture, installMemoryMocks } from './memory-fixtures.ts';
import { expectAxeClean } from './axe.ts';
before(setup); after(teardown);
for (const lang of ['en', 'de'] as const) {
  test(`learning review keeps refuted evidence folded and confirms a person decision (${lang})`, { skip: browserSkip }, async () => {
    await withApp({ locale: lang === 'de' ? 'de-DE' : 'en-US' }, async app => {
      installMemoryMocks(app.server, defaultFixture());
      const row = { id: 'finding-one', kind: 'knowledge', change: 'add', status: 'pending', score: 0.9, desiredTier: 'A', skeptic: 'refuted', revision: 1,
        prevalence: { sessions: 3, total: 3, days: 2, agents: 1, persons: 1 } };
      const contentHash = 'b'.repeat(64);
      app.server.rpc.handle('dreams.learn.list', () => ({ items: [row], nextOffset: null }));
      app.server.rpc.handle('dreams.learn.get', () => ({ finding: { ...row, text: 'Learning <img src=x onerror=alert(1)>', verify: 'not-applicable' }, contentHash,
        evidence: [{ ref: { sessionId: 'session', turnId: 'turn', sourceId: 'message', trust: 'person', day: '2026-11-07' }, excerpt: 'LIVE_EVIDENCE_FIXTURE' }], action: null, prediction: null }));
      app.server.rpc.handle('dreams.learn.decide', () => { row.status = 'rejected'; return { status: 'rejected' }; });
      await openRoute(app.page, '#/memories/dreams', lang);
      const summary = app.page.locator('summary').filter({ hasText: 'finding-one' }).first();
      await summary.waitFor();
      assert.equal(app.server.rpc.calls.filter(c => c.method === 'dreams.learn.get').length, 0);
      await summary.click();
      await app.page.getByText('Learning <img src=x onerror=alert(1)>', { exact: true }).waitFor();
      assert.equal(await app.page.locator('.tabpanel img').count(), 0);
      await app.page.getByRole('button', { name: lang === 'de' ? 'Ablehnen' : 'Reject', exact: true }).first().click();
      assert.equal(app.server.rpc.calls.filter(c => c.method === 'dreams.learn.decide').length, 0);
      await expectAxeClean(app.page, `learning review ${lang}`);
      await app.page.getByRole('button', { name: lang === 'de' ? 'Bestätigen' : 'Confirm', exact: true }).first().click();
      await app.page.locator('summary').filter({ hasText: lang === 'de' ? 'Abgelehnt' : 'Rejected' }).first().waitFor();
      assert.deepEqual(app.server.rpc.calls.find(c => c.method === 'dreams.learn.decide')?.params, { id: row.id, contentHash, outcome: 'rejected' });
    });
  });
}

for (const role of ['owner', 'admin', 'member'] as const) {
  test(`LQ4 learning settings only write for owner (${role})`, { skip: browserSkip }, async () => {
    await withApp({ server: { role } }, async app => {
      installMemoryMocks(app.server, defaultFixture());
      app.server.rpc.handle('config.set', () => ({ applied: true }));
      await openRoute(app.page, '#/memories/dreams', 'en');
      if (role === 'owner') {
        await app.page.getByRole('button', { name: 'Enable learning', exact: true }).first().click();
        await app.page.getByText('Saved through the Supervisor.', { exact: false }).first().waitFor();
        const call = app.server.rpc.calls.find(c => c.method === 'config.set');
        assert.ok(call); const params = call.params as { changes: { key: string; value: { enabled: boolean; owner: string } }[]; ifRevision: string };
        assert.equal(params.ifRevision, 'learn-config-revision'); assert.equal(params.changes[0]!.key, 'dreams.learn.agents.main');
        assert.equal(params.changes[0]!.value.enabled, true); assert.ok(params.changes[0]!.value.owner);
      } else {
        await app.page.getByText('Only the owner can change learning settings', { exact: false }).first().waitFor();
        assert.equal(await app.page.getByRole('button', { name: 'Enable learning', exact: true }).count(), 0);
        assert.equal(app.server.rpc.calls.filter(c => c.method === 'config.set').length, 0);
      }
    });
  });
}
