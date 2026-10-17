import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { browserSkip, openRoute, setup, teardown, withApp } from './harness.ts';
import { sampleChannel, seedSwitchboard } from './switchboard-fixtures.ts';
import { expectAxeClean } from './axe.ts';

before(setup); after(teardown);
for (const lang of ['en', 'de'] as const) test(`effective profile and channel-only editing (${lang})`, { skip: browserSkip }, async () => {
  await withApp({ locale: lang === 'de' ? 'de-DE' : 'en-US' }, async app => {
    const profile = { reply: { policy: 'on-mention' }, tools: { deny: ['exec'], allow: null } };
    const origins = { 'reply.policy': ['shipped.group'], 'tools.deny': ['default'], 'tools.allow': ['shipped.direct'] };
    const data = { agentId: 'main', editableKey: 'agents.main.behaviour.byChannelKind.discord', layer: {}, group: { profile, origins }, direct: { profile: { reply: { policy: 'always' } }, origins: { 'reply.policy': ['shipped.direct'] } } };
    seedSwitchboard(app.server.rpc, [sampleChannel()]);
    app.server.rpc.handle('channel.get', () => ({ ...sampleChannel(), behaviour: data }), { write: false });
    app.server.rpc.handle('config.get', () => ({ value: {}, revision: 'one' }), { write: false });
    app.server.rpc.handle('config.set', () => ({}));
    await openRoute(app.page, '#/switchboard', lang);
    await app.page.getByRole('heading', { name: lang === 'en' ? 'Effective behaviour' : 'Effektives Verhalten' }).waitFor();
    assert.match(await app.page.locator('body').innerText(), /on-mention/);
    assert.match(await app.page.locator('body').innerText(), /shipped.group/);
    await app.page.getByRole('combobox', { name: lang === 'en' ? 'Chat type' : 'Chat-Typ' }).selectOption('direct');
    assert.match(await app.page.locator('body').innerText(), /always/);
    await app.page.getByRole('textbox', { name: lang === 'en' ? 'Channel layer (JSON)' : 'Kanal-Ebene (JSON)' }).fill('{"commands":{"deny":["new"]}}');
    await expectAxeClean(app.page, 'channel behaviour');
    await app.page.getByRole('button', { name: lang === 'en' ? 'Save' : 'Speichern', exact: true }).click();
    await app.page.waitForFunction(() => !document.querySelector('button[disabled]'));
    const calls = app.server.rpc.calls.filter(c => c.method === 'config.set');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.params, { changes: [{ key: data.editableKey, value: { commands: { deny: ['new'] } } }], ifRevision: 'one' });
    assert.ok(calls[0]!.csrf);
  });
});
