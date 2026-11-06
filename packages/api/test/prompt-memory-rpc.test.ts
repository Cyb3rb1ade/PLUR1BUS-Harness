import test from 'node:test';
import assert from 'node:assert/strict';
import { rpcRoute, webEndpoint } from '../src/rpc-route.ts';
import { RPC_RULES, authorize } from '../src/rbac-bridge.ts';
import type { CoreRpc } from '../src/core-rpc.ts';

const person = { userId: 'alice', kind: 'person', role: 'owner' } as const;
const calls: Record<string, object> = {
  'memory.importText.preview': { text: '' },
  'memory.importText.apply': { entries: [{ category: 'Projects', sourceType: 'memory', text: 'Synthetic project',
    warnings: [], idempotencyKey: 'f'.repeat(64) }], targets: [{ target: 'agent', agentIds: ['main'] }], dryRun: true },
  'memory.importText.rollback': { runId: 'prompt-1234-abcd1234' },
  'memory.exportText': {},
};

for (const [method, params] of Object.entries(calls)) {
  test(`the prompt import/export UI reaches the authoritative Core for ${method}`, async () => {
    assert.equal(webEndpoint(method), 'core');
    assert.equal(RPC_RULES[method]?.humanOnly, true);
    const rule = RPC_RULES[method]!;
    assert.equal(rule.action, method === 'memory.exportText' ? 'admin.memory.read' : 'imports.manage');
    assert.equal(authorize({ ...person, role: 'viewer' }, rule.action, rule.resource(params)).effect,
      method === 'memory.exportText' ? 'allow' : 'deny');
    let reached: unknown;
    const core: CoreRpc = { call: async () => { throw new Error('legacy delegation refused'); },
      callAs: async (name, body, principal, endpoint) => { reached = { name, body, principal, endpoint }; return {} as never; } };
    const answer = await rpcRoute(core, { jsonrpc: '2.0', id: 1, method,
      params: { ...params, principal: { role: 'owner' }, actAs: 'another-person' } }, person);
    assert('result' in answer, JSON.stringify(answer));
    assert.deepEqual(reached, { name: method, body: params, principal: person, endpoint: 'core' });
  });
}

test('prompt exposure grants no namespace wildcard or raw capture access', () => {
  for (const method of ['memory.importText.unchecked', 'memory.exportText.internal', 'memory.capture']) {
    assert.equal(webEndpoint(method), null);
  }
});
