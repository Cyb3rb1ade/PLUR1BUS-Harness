import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { setup, teardown, withApp, openRoute } from './harness.ts';
import { defaultFixture, installMemoryMocks } from './memory-fixtures.ts';
import { expectAxeClean } from './axe.ts';
before(setup); after(teardown);
for (const lang of ['en', 'de'] as const) {
  test(`learning review keeps refuted evidence folded and confirms a person decision (${lang})`, async () => {
    await withApp({ locale: lang === 'de' ? 'de-DE' : 'en-US' }, async app => {
      installMemoryMocks(app.server, defaultFixture());
      const row = { id: 'finding-one', kind: 'knowledge', change: 'add', status: 'pending', score: 0.9, desiredTier: 'A', skeptic: 'refuted', revision: 1,
        prevalence: { sessions: 3, total: 3, days: 2, agents: 1, persons: 1 } };
      const contentHash = 'b'.repeat(64);
      app.server.rpc.handle('dreams.learn.list', () => ({ items: [row] }));
      app.server.rpc.handle('dreams.learn.get', () => ({ finding: { ...row, text: 'Learning <img src=x onerror=alert(1)>', verify: 'not-applicable' }, contentHash,
        evidence: [{ ref: { sessionId: 'session', turnId: 'turn', sourceId: 'message', trust: 'person', day: '2026-11-07' }, excerpt: 'LIVE_EVIDENCE_FIXTURE' }], action: null }));
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
      await app.page.waitForFunction(() => !document.querySelector('button:disabled'));
      assert.deepEqual(app.server.rpc.calls.find(c => c.method === 'dreams.learn.decide')?.params, { id: row.id, contentHash, outcome: 'rejected' });
    });
  });
}
