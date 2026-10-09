import { createHash, randomUUID } from 'node:crypto';
import { ChatGPTPlan } from './plan.ts';
import { HostIdentity, JwksVerifier } from './identity.ts';
import { LoopbackPkce } from './loopback.ts';
import { OpenAIError, Sensitive, boundary, type AuditPort, type Clock, type HttpPort, type PkcePort, type RefreshPort, type SecretPort } from './ports.ts';
import { requireOwner, type PlanPrincipal } from './profiles.ts';
/** One mutex per credential for every login, refresh, logout and metadata update. */
export class SerialOwner implements RefreshPort {
  readonly #work = new Map<string, Promise<unknown>>();
  exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const work = (this.#work.get(key) ?? Promise.resolve()).catch(() => {}).then(action).finally(() => { if (this.#work.get(key) === work) this.#work.delete(key); });
    this.#work.set(key, work); return work;
  }
}
export interface CredentialInfo { id: string; person: string; workspace: string; kind: 'oauth_pkce'; billingPath: 'plan'; expiresAt: number | null; needsLogin: boolean }
export interface AuthServiceOptions {
  store: SecretPort; http: HttpPort; clock: Clock; audit: AuditPort; owner?: RefreshPort;
  pkce?: () => PkcePort; timeoutMs?: number; refreshSkewMs?: number; random?: () => number;
}
interface LoginAttempt { person: string; abort: AbortController; result: Promise<CredentialInfo> }
const INDEX = 'openai.credentials.index';
/** Trusted in-process API. Principal must be supplied by the authenticated surface, never agent input. */
export class AuthService {
  readonly #o: AuthServiceOptions; readonly #owner: RefreshPort; readonly #host: HostIdentity;
  readonly #pending = new Map<string, LoginAttempt>(); #closed = false;
  constructor(options: AuthServiceOptions) { this.#o = options; this.#owner = options.owner ?? new SerialOwner(); this.#host = new HostIdentity(options.store, this.#owner); }
  #plan(pkce?: PkcePort, signal?: AbortSignal) {
    return new ChatGPTPlan({ ...this.#o, owner: this.#owner, host: this.#host, verifier: new JwksVerifier(this.#o.http, this.#o.clock), pkce: pkce ?? new LoopbackPkce(async () => {}), ...(signal ? { signal } : {}) });
  }
  async #index(): Promise<CredentialInfo[]> {
    try { const raw = await this.#o.store.get(INDEX); if (!raw) return []; const rows: unknown = JSON.parse(raw);
      if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object' || !/^[a-f0-9]{64}$/.test(r.id) || typeof r.person !== 'string' || typeof r.workspace !== 'string')) throw new Error();
      return rows as CredentialInfo[];
    } catch { throw new OpenAIError('persist-failed'); }
  }
  async #save(info: CredentialInfo) { await this.#owner.exclusive(INDEX, async () => { const rows = await this.#index(); await this.#o.store.set(INDEX, JSON.stringify([...rows.filter(r => r.id !== info.id), info])); }); }
  async startLogin(request: { principal: PlanPrincipal; credentialId?: string }): Promise<{ authorizeUrl: Sensitive; loginId: string }> {
    requireOwner(request.principal); if (this.#closed || this.#pending.size >= 16) throw new OpenAIError('invalid-request');
    const id = request.credentialId ?? createHash('sha256').update(request.principal.user + ':' + randomUUID()).digest('hex');
    if (request.credentialId) await this.#owned(id, request.principal);
    const abort = new AbortController(), loginId = randomUUID();
    let ready!: (url: Sensitive) => void, failed!: (error: unknown) => void;
    const url = new Promise<Sensitive>((resolve, reject) => { ready = resolve; failed = reject; });
    const base = this.#o.pkce?.() ?? new LoopbackPkce(async () => {});
    const pkce: PkcePort = { redirect: () => base.redirect(), close: () => base.close(), authorize: r => { ready(r.url); return base.authorize(r); } };
    const result = boundary(async () => {
      await this.#plan(pkce, abort.signal).login(id, request.principal);
      const metadata = await this.#plan().metadata(id); if (!metadata) throw new OpenAIError('persist-failed');
      const info: CredentialInfo = { id, person: request.principal.user, workspace: metadata.workspace, kind: 'oauth_pkce', billingPath: 'plan', expiresAt: metadata.expiresAt, needsLogin: false };
      try { await this.#save(info); } catch { await this.#plan().logout(id).catch(() => {}); throw new OpenAIError('persist-failed'); } return info;
    });
    // Observe failures even when the caller never awaits a cancelled login.
    void result.catch(failed);
    this.#pending.set(loginId, { person: request.principal.user, abort, result });
    try { return { authorizeUrl: await url, loginId }; } catch (e) { this.#pending.delete(loginId); throw e; }
  }
  async awaitLogin(loginId: string, principal: PlanPrincipal): Promise<CredentialInfo> {
    requireOwner(principal); const attempt = this.#pending.get(loginId);
    if (!attempt || attempt.person !== principal.user) throw new OpenAIError('owner-only');
    try { return await attempt.result; } finally { this.#pending.delete(loginId); }
  }
  cancelLogin(loginId: string, principal: PlanPrincipal) { requireOwner(principal); const attempt = this.#pending.get(loginId); if (!attempt || attempt.person !== principal.user) throw new OpenAIError('owner-only'); attempt.abort.abort(); }
  async listCredentials(principal: PlanPrincipal): Promise<CredentialInfo[]> {
    requireOwner(principal); return boundary(async () => { const out: CredentialInfo[] = []; for (const info of await this.#index()) if (info.person === principal.user) { const m = await this.#plan().metadata(info.id); if (m) out.push({ ...info, ...m }); } return out; }, 'persist-failed');
  }
  async #owned(id: string, p: PlanPrincipal) { requireOwner(p); const info = (await this.#index()).find(r => r.id === id && r.person === p.user); if (!info) throw new OpenAIError('auth-required'); return info; }
  async lease(id: string, principal: PlanPrincipal) { await this.#owned(id, principal); return this.#plan().lease(id, principal); }
  async models(id: string, principal: PlanPrincipal) { await this.#owned(id, principal); return this.#plan().models(id, principal); }
  async logout(id: string, principal: PlanPrincipal) {
    await this.#owned(id, principal);
    try { await this.#plan().logout(id); }
    finally { await this.#owner.exclusive(INDEX, async () => { await this.#o.store.set(INDEX, JSON.stringify((await this.#index()).filter(r => r.id !== id))); }); }
  }
  async status(principal: PlanPrincipal) { return { credentials: await this.listCredentials(principal), pendingLogins: [...this.#pending.values()].filter(a => a.person === principal.user).length }; }
  async close() { this.#closed = true; for (const attempt of this.#pending.values()) attempt.abort.abort(); await Promise.allSettled([...this.#pending.values()].map(a => a.result)); this.#pending.clear(); }
}
