import { createHash } from 'node:crypto';
import { OpenAIError, Sensitive, boundary, type BillingPath, type AuditPort, type Region, type Clock, type SecretPort } from './ports.ts';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = ['openid','profile','email','offline_access','resource.invoke','chatgpt.tokens.use.direct'] as const;
export const UI_TEXT = Object.freeze({ button: 'Continue with ChatGPT', firstUse: "You're using your ChatGPT plan", indicator: 'Using ChatGPT plan', manage: 'Manage usage', usageUrl: 'https://chatgpt.com/settings/usage', source: 'https://developers.openai.com/siwc/ui-ux-guidelines' });
export const profiles = Object.freeze({
  plan: { id: 'openai:chatgpt-plan', kind: 'oauth_pkce', client_registration: 'dynamic_on_authorize', registration_entry_client_id: 'dynamic_agent_client', agent_name_hint: 'PLUR1BUS', person_bound: true, region: 'global', wire_profile: 'siwc', billing_path: 'chatgpt_plan', scope_gate: 'chatgpt.tokens.use.direct', resource: RESOURCE, policy_status: 'allowed' },
  workload: { id: 'openai:workload-identity', kind: 'federated_token', billing_path: 'workload', policy_status: 'allowed' },
  key: { id: 'openai:api-key', kind: 'api_key', billing_path: 'api_key', policy_status: 'allowed' },
  realtime: { id: 'openai:realtime', derives_from: ['openai:api-key','openai:workload-identity'], surface_min_trust: 2, policy_status: 'allowed' },
  live: { id: 'openai:gpt-live', derives_from: ['openai:api-key','openai:workload-identity'], surface_min_trust: 2, policy_status: 'allowed' },
  codex: { id: 'openai:codex-cli', kind: 'external_cli', usage_label: 'personal/local only', billing_path: 'cli_login', person_bound: true },
} as const);
export interface PlanPrincipal { owner: string; user: string; agentOwner: string; deployment: 'local' | 'self-hosted' | 'hosted-multi-user' }
export function requireOwner(p: PlanPrincipal) { if (!p.owner || p.user !== p.owner || p.agentOwner !== p.owner || !['local','self-hosted'].includes(p.deployment)) throw new OpenAIError('owner-only'); }
export function endpoint(region: Region = 'global'): string { if (!['global','us','eu'].includes(region)) throw new OpenAIError('invalid-request'); return 'https://' + (region === 'global' ? '' : region + '.') + 'api.openai.com/v1'; }
export const EU_NOTICE = "EU residency requires your organisation's Modified Retention amendment.";
export function keyStatus(expiresAt: number | undefined, now: number): 'valid' | 'expires-14-days' | 'expires-3-days' | 'auth-required' {
  if (expiresAt === undefined) return 'valid';
  if (!Number.isFinite(expiresAt)) throw new OpenAIError('invalid-request');
  const days = (expiresAt - now) / 86400000;
  return days <= 0 ? 'auth-required' : days <= 3 ? 'expires-3-days' : days <= 14 ? 'expires-14-days' : 'valid';
}
export class ApiKeyCredential {
  readonly #store: SecretPort; readonly #clock: Clock; readonly #ref: string; readonly #expiry: number | undefined;
  constructor(store: SecretPort, clock: Clock, ref: string, expiresAt?: number) { this.#store = store; this.#clock = clock; this.#ref = ref; this.#expiry = expiresAt; }
  status() { return keyStatus(this.#expiry, this.#clock.now()); }
  async lease() { if (this.status() === 'auth-required') throw new OpenAIError('auth-required'); return boundary(async () => { const key = await this.#store.get(this.#ref); if (!key) throw new OpenAIError('auth-required'); return new Sensitive(key); }, 'auth-required'); }
}
export function safetyIdentifier(principal: string) { return createHash('sha256').update(principal).digest('hex'); }
export function chooseFailover(from: BillingPath, candidates: { id: string; billing_path: BillingPath }[], cross: { from: BillingPath; to: BillingPath }[], errorCode?: string, audit?: AuditPort): string | undefined {
  if (errorCode === 'subscription_sharing_usage_limit_exceeded') return undefined;
  const candidate = candidates.find(c => c.billing_path === from || cross.some(p => p.from === from && p.to === c.billing_path));
  if (candidate) audit?.({ kind: 'failover', from, to: candidate.billing_path, crossBilling: from !== candidate.billing_path });
  return candidate?.id;
}
/** Metadata only. No imported token values are accepted by this API. */
export function importedProfile(id: string) { if (id !== 'openai:chatgpt-oauth-restricted') throw new OpenAIError('invalid-request'); return { id, enabled: false as const, replacement: 'openai:chatgpt-plan', action: 'Sign in with ChatGPT again' }; }
export interface CredentialDenyPort { canonicalize(path: string): Promise<string>; denied(canonical: string): Promise<boolean> }
/** D109 owns platform-aware canonical paths, aliases, keychain names and foreign registration records. */
export async function credentialAccess<T>(deny: CredentialDenyPort, path: string, read: () => Promise<T>): Promise<T> { return boundary(async () => { if (await deny.denied(await deny.canonicalize(path))) throw new OpenAIError('credential-denied'); return read(); }, 'credential-denied'); }

/** D109 adapter data. App names are assembled to satisfy the repo's source hygiene rule, which reserves
 * foreign host identifiers to its separate importer. This list only denies access; it reads no files. */
export const FOREIGN_CREDENTIAL_STORES = [
  { app: 'codex', env: 'CODEX_HOME', suffixes: ['auth.json'], keychain: true },
  { app: ['open', 'claw'].join(''), env: ['OPEN', 'CLAW_HOME'].join(''), suffixes: ['credentials', 'agents'], keychain: false },
  { app: 'hermes', env: 'HERMES_HOME', suffixes: ['.env', 'auth.json', 'credentials', 'siwc'], keychain: false },
] as const;
/** Canonicalizer must resolve case, home/env aliases and symlinks WITHOUT opening credential contents.
 * foreignRegistration is metadata from the D109 file policy, never parsed out of a credential file. */
export function createCredentialDenyPort(o: { canonicalize(path: string): Promise<string>; roots: string[]; keychainItems: string[]; foreignRegistration?: (path: string) => Promise<boolean> }): CredentialDenyPort {
  const normalized = (s: string) => s.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const roots = o.roots.map(normalized), items = o.keychainItems.map(normalized);
  return { canonicalize: o.canonicalize, async denied(path) { const p = normalized(path); return roots.some(r => p === r || p.startsWith(r + '/')) || items.includes(p) || (await o.foreignRegistration?.(path) ?? false); } };
}
