// A real model and real local engine, exercised through two independent Direct Chat sessions.
// Never imported by the gating package suites. With no endpoint/model configuration the test is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseUrl = process.env.PLUR1BUS_M2_CHAT_URL, model = process.env.PLUR1BUS_M2_CHAT_MODEL;
const skip = process.env.PLUR1BUS_M2_NIGHTLY !== '1' ? 'M2 Nightly disabled' : !baseUrl || !model ? 'real chat endpoint/model not configured' : false;
test('M2 Nightly real-model Direct Chat recalls an unpredictable fact in a new session', { skip, timeout: 600_000 }, async () => {
  const { defaults } = await import('@plur1bus/config-schema');
  const { createCore } = await import('../../packages/core/src/core.ts');
  const { connect } = await import('../../packages/core/test/helpers/connect.ts');
  const { createChatCompletionsAdapter } = await import('../../packages/providers/src/index.ts');
  const { createEgress, isLoopbackHost } = await import('../../packages/core/src/egress/index.ts');
  const { providerFetch } = await import('../../packages/core/src/composition/http.ts');
  const home = await mkdtemp(join(tmpdir(), 'p1-m2-nightly-'));
  let core: ReturnType<typeof createCore> | undefined;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let passed = false;
  try {
    const url = new URL(baseUrl!);
    assert.ok(['https:', 'http:'].includes(url.protocol));
    assert.equal(url.username + url.password + url.search + url.hash, '');
    const config = defaults(); config.agents.nightly = {};
    config.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false } };
    config.core.recall.softBudgetMs = 10_000; config.core.recall.hardBudgetMs = 15_000;
    config.egress = { allowHosts: [url.hostname], allowPorts: [Number(url.port || (url.protocol === 'https:' ? 443 : 80))], allowLoopback: isLoopbackHost(url.hostname) };
    await writeFile(join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    if (process.env.PLUR1BUS_MODELS_CACHE) {
      await mkdir(process.env.PLUR1BUS_MODELS_CACHE, { recursive: true });
      await symlink(process.env.PLUR1BUS_MODELS_CACHE, join(home, 'models'), 'dir');
    }
    const egress = createEgress({ config: () => config.egress });
    const adapter = createChatCompletionsAdapter({ baseUrl: baseUrl!, credentials: { authorization: () => process.env.PLUR1BUS_M2_CHAT_KEY ? `Bearer ${process.env.PLUR1BUS_M2_CHAT_KEY}` : undefined }, fetch: providerFetch(egress, 'chat_completions'), timeouts: { totalMs: 120_000 } });
    // Real production adapter through the production turn pipeline; no fake provider or flat embedder.
    core = createCore({ home, discovery: { scheduler: false }, composition: { providers: { profiles: { default: [{ provider: 'nightly', model: model!, adapter }] }, maxTokens: 256 } } });
    await core.start(); client = await connect({ address: core.address, token: core.token });
    const deadline = Date.now() + 240_000;
    while (true) {
      const status = await client.call<any>('core.status', {});
      if (status.engine.ready) break;
      assert.ok(Date.now() < deadline);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const caller = { channel: 'cli', accountId: 'nightly', userId: 'm2-owner' };
    const phrase = `violet-${randomUUID()}`;
    const first = await client.call<any>('session.create', { caller, agentId: 'nightly', title: 'M2 capture' });
    const capture = await client.call<any>('session.submit', { caller, sessionId: first.session.id, text: `Remember this fact: the launch verification phrase for project Lumen is ${phrase}.`, wait: true });
    assert.equal(capture.state, 'completed');
    const captureDeadline = Date.now() + 30_000;
    while (true) {
      const cards = await client.call<any>('memory.list', { caller, agentId: 'nightly', since: 0 });
      if (JSON.stringify(cards.items).includes(phrase)) break;
      assert.ok(Date.now() < captureDeadline);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const second = await client.call<any>('session.create', { caller, agentId: 'nightly', title: 'M2 recall' });
    assert.notEqual(second.session.id, first.session.id);
    const recalled = await client.call<any>('session.submit', { caller, sessionId: second.session.id, text: 'What is the launch verification phrase for project Lumen? Reply with the exact phrase from memory.', wait: true });
    assert.equal(recalled.state, 'completed');
    assert.ok(typeof recalled.reply === 'string' && recalled.reply.includes(phrase));
    passed = true;
  } catch { /* Do not print upstream errors, prompt bodies or credentials. */ }
  finally {
    await client?.close().catch(() => {});
    await core?.stop({ budgetMs: 5000 }).catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
  assert.ok(passed, 'M2 real-model Direct Chat acceptance failed; provider details withheld');
});
