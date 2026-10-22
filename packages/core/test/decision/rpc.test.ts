import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardMethods, LOCAL_OWNER } from '../../src/rbac/guard.ts';
import { isForbiddenMethod } from '../../../webmcp/src/provider.ts';
import { RpcError } from '../../src/rpc/errors.ts';
test('decision diagnostics admit only Owner/Admin people and never become model tools', async () => {
  let ran = 0; const handlers = { 'decision.status': async () => { ran++; return {}; }, 'decision.test': async () => { ran++; return {}; } };
  for (const method of Object.keys(handlers)) {
    assert.equal(isForbiddenMethod(method), true);
    for (const role of ['owner', 'admin', 'operator', 'member', 'viewer'] as const) for (const kind of ['person', 'agent'] as const) {
      const guarded = guardMethods(handlers, { now: Date.now, resolve: () => ({ ...LOCAL_OWNER, role, kind }) });
      const call = () => guarded[method]!({}, { signal: new AbortController().signal } as never);
      if (kind === 'person' && ['owner', 'admin'].includes(role)) await call();
      else await assert.rejects(call, (e: unknown) => e instanceof RpcError && e.error === 'E_DENIED');
    }
  }
  assert.equal(ran, 4);
});
