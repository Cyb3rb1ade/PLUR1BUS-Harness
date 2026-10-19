// Reuse the normal personal-token store and revocation rules; no second credential database.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiPrincipal } from '@plur1bus/module-api';
import type { AdminStore } from '../identity/admin-store.ts';
import { authorize } from '../rbac/authorize.ts';
import { RpcError } from './errors.ts';

const actions: Record<string, string> = {
  'core.status': 'doctor.read', 'agent.status': 'agent.read', 'agent.open': 'agent.use', 'agent.close': 'agent.use',
  'memory.recall': 'agent.use', 'memory.capture': 'agent.use', 'memory.checkpoint': 'agent.use',
  'memory.list': 'agent.use', 'memory.show': 'agent.use', 'memory.forget': 'memory.forget', 'memory.correct': 'memory.forget',
};
const denied = () => new RpcError('E_DENIED', 'Hermes client authority denied', { reason: 'hermes-client-scope' });
export function hermesClientAuth(home: string, people: AdminStore, now: () => number) {
  let accounts: import('../../../api/src/account-store.ts').AccountStore | undefined;
  let service: import('../../../api/src/tokens.ts').TokenService | undefined;
  let closed = false;
  let opening: Promise<void> | undefined;
  return {
    async authorize(token: string, method: string, params: any): Promise<ApiPrincipal> {
      if (closed) throw denied();
      if (!/^plb_/.test(token) || !existsSync(join(home, 'state', 'api', 'accounts.db'))) throw denied();
      if (!opening) opening = (async () => {
        const [{ AccountStore }, { TokenService }] = await Promise.all([import('../../../api/src/account-store.ts'), import('../../../api/src/tokens.ts')]);
        if (closed) throw denied();
        accounts = new AccountStore({ path: join(home, 'state', 'api', 'accounts.db'), now, resolve: async id => { const p = people.person(id); return p ? { ...p, kind: 'person' } : null; } });
        service = new TokenService({ store: accounts.tokens, clock: { now } });
      })();
      try { await opening; } catch { throw denied(); }
      const auth = await service!.authenticate(token);
      if (!auth.ok) throw denied();
      const bound = /^(hermes-[a-z0-9_-]{1,57})$/.exec(auth.record.name)?.[1];
      const person = people.resolvePerson(auth.record.userId);
      if (!bound || !person || !auth.record.scopes.length || auth.record.scopes.some(s => !Object.values(actions).includes(s))) throw denied();
      const principal: ApiPrincipal = { ...person, kind: 'agent', tokenScopes: auth.record.scopes };
      if (method === 'core.auth') return principal;
      const action = actions[method];
      if (!action || (method !== 'core.status' && params?.agentId !== bound)) throw denied();
      if (authorize(principal, action, method === 'core.status' ? { kind: 'system' } : { kind: 'agent', agentId: bound }).effect !== 'allow') throw denied();
      // A host credential handles mapped Hermes users inside its one approved agent. No cross-agent sharing.
      return principal;
    },
    close() { closed = true; accounts?.close(); accounts = undefined; service = undefined; },
  };
}
