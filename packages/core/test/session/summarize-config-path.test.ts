// End-to-end over the real config path: config.json on disk → loadConfig (validate + migrate) → sessionRoleFactory → router.
// Nothing here assigns modelRoles by hand, which is how the schema gap stayed hidden behind the older unit tests.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '../../../config-schema/src/index.ts';
import { loadConfig, writeConfigAtomic } from '../../src/config-load.ts';
import { sessionRoleFactory } from '../../src/session/maintenance.ts';
import { createTurnProvider } from '../../src/composition/provider.ts';
import { createCallBudget, PriceBook, SHIPPED_PRICE_TABLES } from '../../src/budget/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import type { ChatRequest } from '../../src/session/provider.ts';
import type { ChatRequest as WireRequest } from '../../../providers/src/index.ts';

const summaryRequest = (): ChatRequest => ({ sessionId: 's', agentId: 'a', principal: 'user:v1:test', role: 'summarize', maxOutputTokens: 40, summaries: [], memory: '', messages: [{ role: 'user', text: 'summarize these facts' }], signal: new AbortController().signal });

function harness(configPath: string) {
  const models: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'summarize-budget-'));
  const budget = createCallBudget({ path: join(dir, 'budget.sqlite'), clock: { now: Date.now }, prices: new PriceBook(SHIPPED_PRICE_TABLES) });
  const adapter = { async *stream(req: WireRequest) {
    models.push(req.model);
    yield { type: 'text_delta' as const, text: 'summary' };
    yield { type: 'done' as const, result: { text: 'summary', toolCalls: [], finishReason: 'stop' as const, rawFinishReason: 'stop', usage: { inputTokens: 20, outputTokens: 2 }, meta: {} } };
  } };
  const { config } = loadConfig(configPath);
  const provider = sessionRoleFactory(createTurnProvider, config)({
    profiles: { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter }], cheap: [{ provider: 'fixture', model: 'gpt-4.1-mini', adapter }] },
    profileForClass: () => 'default', registry: new ToolRegistry(), budget,
    approval: { request: async () => ({ approved: false }) }, grants: { get: () => undefined, list: () => [] },
    log: () => {}, resultStore: { put: async () => 'result:fixture' },
  });
  return { models, provider, close() { budget.close(); rmSync(dir, { recursive: true, force: true }); } };
}

it('a config.json that sets modelRoles.summarize loads, and the router summarizes with that model', async () => {
  const home = mkdtempSync(join(tmpdir(), 'summarize-config-'));
  const configPath = join(home, 'config.json');
  try {
    const config = defaults(); config.modelRoles = { chat: 'default', summarize: 'cheap' };
    writeConfigAtomic(configPath, config);
    const h = harness(configPath);
    try {
      for await (const chunk of h.provider.stream(summaryRequest())) void chunk;
      assert.deepEqual(h.models, ['gpt-4.1-mini']);
    } finally { h.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('without modelRoles.summarize the summary role rejects with summary-model-unavailable and calls no model', async () => {
  const home = mkdtempSync(join(tmpdir(), 'summarize-config-'));
  const configPath = join(home, 'config.json');
  try {
    writeConfigAtomic(configPath, defaults());
    const h = harness(configPath);
    try {
      await assert.rejects(async () => { for await (const chunk of h.provider.stream(summaryRequest())) void chunk; }, /summary-model-unavailable/);
      assert.deepEqual(h.models, []);
    } finally { h.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
