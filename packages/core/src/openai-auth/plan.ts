import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Sensitive, SensitivePayload, OpenAIError, boundary, bounded, call, object, positive, text, type SecretPort, type RefreshPort, type PkcePort, type Clock, type HttpPort, type AuditPort } from './ports.ts';
import { HostIdentity, JwksVerifier, discovery } from './identity.ts';
import { requireOwner, RESOURCE, SCOPES, type PlanPrincipal } from './profiles.ts';
import { guardSiwc } from './wire.ts';
export interface PlanPorts { store: SecretPort; owner: RefreshPort; pkce: PkcePort; http: HttpPort; clock: Clock; host: HostIdentity; verifier: JwksVerifier; audit: AuditPort; deadline?: (milliseconds: number) => AbortSignal }
interface Registration { clientId: string; sub: string; workspace: string; accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt: number; scope: string; refreshConsumed?: boolean }
function tokens(raw: unknown, now: number) {
  const t = object(raw);
  if (typeof t.token_type !== 'string' || t.token_type.toLowerCase() !== 'bearer') throw new OpenAIError('endpoint-rejected');
  const scope = text(t.scope);
  if (!scope.split(' ').includes('chatgpt.tokens.use.direct')) throw new OpenAIError('scope-denied');
  return { accessToken: text(t.access_token), refreshToken: text(t.refresh_token), expiresAt: now + positive(t.expires_in) * 1000, refreshExpiresAt: now + (t.refresh_expires_in === undefined ? 30 * 86400 : positive(t.refresh_expires_in)) * 1000, scope };
}
/** Owns no background process. Every durable mutation is serialized through the generic auth owner port. */
export class ChatGPTPlan {
  readonly #p: PlanPorts;
  constructor(ports: PlanPorts) { this.#p = ports; }
  accountRef(account: string) { if (!/^[a-zA-Z0-9._-]{1,80}$/.test(account)) throw new OpenAIError('invalid-request'); return 'openai.plan.' + account; }
  async #load(ref: string): Promise<Registration | undefined> {
    const raw = await this.#p.store.get(ref); if (raw === undefined) return undefined;
    const r = object(JSON.parse(raw));
    for (const k of ['clientId','sub','workspace','accessToken','refreshToken','scope']) text(r[k]);
    if (r.clientId === 'dynamic_agent_client') throw new OpenAIError('auth-required');
    positive(r.expiresAt); positive(r.refreshExpiresAt);
    return r as unknown as Registration;
  }
  async login(account: string, principal: PlanPrincipal): Promise<{ profileId: string; expiresAt: number }> {
    requireOwner(principal);
    const ref = this.accountRef(account);
    return boundary(() => this.#p.owner.exclusive(ref, async () => {
      const old = await this.#load(ref), d = await discovery(this.#p.http);
      const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      const host = await this.#p.host.id();
      // PKCE port opens the listener before constructing the browser URL, with only the port varying.
      const port = this.#p.pkce;
      const redirect = await port.redirect();
      const target = new URL(redirect);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/auth/callback' || !target.port || target.username || target.password || target.search || target.hash) throw new OpenAIError('invalid-request');
      const u = new URL(d.authorization_endpoint);
      const client = old?.clientId ?? 'dynamic_agent_client';
      for (const [k,v] of Object.entries({ client_id: client, agent_name_hint: 'PLUR1BUS', ext_agent_host_id: host, response_type: 'code', redirect_uri: redirect, scope: SCOPES.join(' '), resource: RESOURCE, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), state, nonce })) u.searchParams.set(k,v);
      let callback: URL;
      try { callback = new URL(await (() => { const signal = (this.#p.deadline ?? AbortSignal.timeout)(600000); return bounded(this.#p.pkce.authorize({ url: new Sensitive(u.href), redirectUri: redirect, signal }), signal); })()); }
      finally { await port.close(); }
      const actual = Buffer.from(callback.searchParams.get('state') ?? ''), wanted = Buffer.from(state);
      if (callback.origin !== target.origin || callback.pathname !== target.pathname || callback.hash || callback.username || callback.password || callback.searchParams.getAll('state').length !== 1 || actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new OpenAIError('state-mismatch');
      if (callback.searchParams.has('error') || callback.searchParams.getAll('code').length !== 1 || callback.searchParams.getAll('client_id').length > 1) throw new OpenAIError('auth-required');
      const issued = text(callback.searchParams.get('client_id') ?? old?.clientId);
      if (!/^oaiapp_[A-Za-z0-9_-]+$/.test(issued) || (old && issued !== old.clientId)) throw new OpenAIError('auth-required');
      const raw = object(await call(this.#p.http, { method: 'POST', url: d.token_endpoint, form: { grant_type: 'authorization_code', client_id: issued, code: text(callback.searchParams.get('code')), code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE } }));
      const identity = await this.#p.verifier.validate(text(raw.id_token), { discovery: d, audience: issued, nonce });
      if (old && (old.sub !== identity.sub || old.workspace !== identity.workspace)) throw new OpenAIError('owner-only');
      const record: Registration = { clientId: issued, ...identity, ...tokens(raw, this.#p.clock.now()) };
      this.#p.audit({ kind: 'login' }); // fail closed before persistence/release
      await this.#p.store.set(ref, JSON.stringify(record));
      return { profileId: 'openai:chatgpt-plan', expiresAt: record.expiresAt };
    }));
  }
  async lease(account: string, principal: PlanPrincipal): Promise<Sensitive> {
    requireOwner(principal); const ref = this.accountRef(account);
    return boundary(() => this.#p.owner.exclusive(ref, async () => {
      const r = await this.#load(ref), now = this.#p.clock.now();
      if (!r || r.refreshConsumed || r.refreshExpiresAt <= now) throw new OpenAIError('auth-required');
      if (!r.scope.split(' ').includes('chatgpt.tokens.use.direct')) throw new OpenAIError('scope-denied');
      if (r.expiresAt - 120000 > now) return new Sensitive(r.accessToken);
      const d = await discovery(this.#p.http);
      // Mark spent durably BEFORE exchange. A crash/unknown network outcome cannot reuse the previous token.
      await this.#p.store.set(ref, JSON.stringify({ ...r, refreshConsumed: true }));
      const raw = object(await call(this.#p.http, { method: 'POST', url: d.token_endpoint, form: { grant_type: 'refresh_token', client_id: r.clientId, refresh_token: r.refreshToken, resource: RESOURCE } }));
      const next: Registration = { clientId: r.clientId, sub: r.sub, workspace: r.workspace, ...tokens({ ...raw, scope: raw.scope ?? r.scope }, this.#p.clock.now()) };
      if (next.refreshToken === r.refreshToken) throw new OpenAIError('auth-required');
      this.#p.audit({ kind: 'refresh' });
      await this.#p.store.set(ref, JSON.stringify(next));
      return new Sensitive(next.accessToken);
    }));
  }
  async models(account: string, principal: PlanPrincipal): Promise<string[]> {
    return boundary(async () => { const token = await this.lease(account, principal); const data = object(await call(this.#p.http, { method: 'GET', url: RESOURCE + '/models', authorization: token })); if (!Array.isArray(data.data)) throw new OpenAIError('endpoint-rejected'); return data.data.map(v => text(object(v).id)); });
  }
  async responses(account: string, principal: PlanPrincipal, request: Record<string, unknown>): Promise<unknown> { const json = guardSiwc(request); return boundary(async () => new SensitivePayload(await call(this.#p.http, { method: 'POST', url: RESOURCE + '/responses', json, authorization: await this.lease(account, principal) }))); }
  async logout(account: string): Promise<void> { const ref = this.accountRef(account); await boundary(() => this.#p.owner.exclusive(ref, async () => { const r = await this.#load(ref); if (!r) return; const d = await discovery(this.#p.http); try { await call(this.#p.http, { method: 'POST', url: d.revocation_endpoint, form: { token: r.refreshToken, client_id: r.clientId, token_type_hint: 'refresh_token' } }); } finally { await this.#p.store.delete(ref); } this.#p.audit({ kind: 'logout' }); })); }
  /** Person-run SSH transfer port. Destination must be independently authenticated and owned by the same person.
   * Move, never copy, rotating credentials; destination's host key is untouched. No intermediary disk file. */
  async transfer(account: string, destination: { accept(record: Sensitive): Promise<void> }, principal: PlanPrincipal) { requireOwner(principal); const ref = this.accountRef(account); await boundary(() => this.#p.owner.exclusive(ref, async () => { const r = await this.#load(ref); if (!r || r.refreshConsumed) throw new OpenAIError('auth-required'); await this.#p.store.set(ref, JSON.stringify({ ...r, refreshConsumed: true })); await destination.accept(new Sensitive(JSON.stringify(r))); await this.#p.store.delete(ref); })); }
}
