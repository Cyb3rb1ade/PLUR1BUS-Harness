import { boundary, call, object, text, positive, Sensitive, OpenAIError, type HttpPort, type Clock, type Region } from './ports.ts';
export interface WorkloadProfile { token_exchange_endpoint: string; subject_token_source: `file:${string}` | `env:${string}` | `metadata:${string}`; subject_token_type: string; audience: string; principal: string; identity_provider_id: string; service_account_id: string; region: Region; refresh_skew_seconds?: number }
export interface SubjectPort { read(source: WorkloadProfile['subject_token_source']): Promise<string> }
/** OIDC templates; X.509 can be supplied by the HttpPort's mTLS exchange implementation. */
export const workloadTemplates = { kubernetes: { subject_token_source: 'file:/var/run/secrets/tokens/openai', subject_token_type: 'urn:ietf:params:oauth:token-type:jwt' }, github: { subject_token_source: 'metadata:github-actions', subject_token_type: 'urn:ietf:params:oauth:token-type:jwt' } } as const;
export class WorkloadIdentity {
  readonly #p: WorkloadProfile; readonly #http: HttpPort; readonly #clock: Clock; readonly #subject: SubjectPort;
  #token: Sensitive | undefined; #expiresAt = 0; #flight: Promise<Sensitive> | undefined;
  constructor(profile: WorkloadProfile, ports: { http: HttpPort; clock: Clock; subject: SubjectPort; certificateHttp?: HttpPort }) {
    let u: URL; try { u = new URL(profile.token_exchange_endpoint); } catch { throw new OpenAIError('invalid-request'); }
    const certificate = profile.subject_token_type === 'urn:openai:params:oauth:token-type:x509';
    if (certificate && !ports.certificateHttp) throw new OpenAIError('invalid-request');
    if (u.protocol !== 'https:' || u.hostname !== (certificate ? 'mtls.auth.openai.com' : 'auth.openai.com') || u.pathname !== '/oauth/token' || u.username || u.password || u.search || u.hash || !/^(file|env|metadata):.+/.test(profile.subject_token_source) || !Number.isFinite(profile.refresh_skew_seconds ?? 120) || (profile.refresh_skew_seconds ?? 120) < 0) throw new OpenAIError('invalid-request');
    text(profile.identity_provider_id); text(profile.service_account_id); text(profile.audience); text(profile.principal);
    this.#p = { ...structuredClone(profile), token_exchange_endpoint: u.href }; this.#http = certificate ? ports.certificateHttp! : ports.http; this.#clock = ports.clock; this.#subject = ports.subject;
  }
  async lease(): Promise<Sensitive> {
    if (this.#token && this.#expiresAt - (this.#p.refresh_skew_seconds ?? 120) * 1000 > this.#clock.now()) return this.#token;
    if (this.#flight) return this.#flight;
    this.#flight = boundary(async () => {
      const certificate = this.#p.subject_token_type === 'urn:openai:params:oauth:token-type:x509';
      let subject: string | undefined;
      if (!certificate) { try { subject = text(await this.#subject.read(this.#p.subject_token_source)); } catch { throw new OpenAIError('auth-required'); } }
      const raw = object(await call(this.#http, { method: 'POST', url: this.#p.token_exchange_endpoint, json: { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', ...(subject === undefined ? {} : { subject_token: subject }), subject_token_type: this.#p.subject_token_type, identity_provider_id: this.#p.identity_provider_id, service_account_id: this.#p.service_account_id } }));
      if (String(raw.token_type).toLowerCase() !== 'bearer') throw new OpenAIError('endpoint-rejected');
      const expires = positive(raw.expires_in); const token = new Sensitive(text(raw.access_token));
      if (expires > 3600) throw new OpenAIError('endpoint-rejected');
      const absolute = raw.expires_at === undefined ? this.#clock.now() + expires * 1000 : positive(raw.expires_at) * 1000;
      this.#expiresAt = Math.min(absolute, this.#clock.now() + expires * 1000);
      if (this.#expiresAt <= this.#clock.now()) throw new OpenAIError('auth-required'); this.#token = token; return token;
    }).finally(() => { this.#flight = undefined; });
    return this.#flight;
  }
}
