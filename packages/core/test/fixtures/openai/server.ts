import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { HttpPort, HttpRequest, HttpResponse, PkcePort, SecretPort, RefreshPort } from '../../../src/openai-auth/index.ts';
const marker = () => randomBytes(24).toString('base64url');
/** In-process endpoint dispatcher. No sockets, DNS, recorded credentials, or fetch. */
export class FakeOpenAI implements HttpPort, PkcePort {
  now = 1_000_000;
  readonly issuer = 'https://auth.openai.com';
  readonly keys = generateKeyPairSync('ed25519');
  readonly secrets: string[] = [];
  readonly requests: HttpRequest[] = [];
  readonly registrations = new Map<string, string>();
  readonly refreshes = new Set<string>();
  readonly codes = new Map<string, { nonce: string; challenge: string; client: string }>();
  account = 'account-a'; refreshCount = 0; jwksCount = 0;
  badClaim: 'iss' | 'aud' | 'exp' | 'nonce' | 'signature' | undefined;
  omitScope = false; badState = false; errorCode: string | undefined;
  failPath: string | undefined;
  secret() { const v = marker(); this.secrets.push(v); return v; }
  async redirect() { return 'http://127.0.0.1:49152/auth/callback'; }
  async close() {}
  async authorize(p: Parameters<PkcePort['authorize']>[0]) {
    const u = new URL(p.url.value());
    if (new URL(p.redirectUri).hostname !== '127.0.0.1' || u.searchParams.get('code_challenge_method') !== 'S256') throw Error('invalid PKCE');
    const supplied = u.searchParams.get('client_id')!;
    let client = this.registrations.get(this.account);
    if (!client) { if (supplied !== 'dynamic_agent_client') throw Error('invalid registration'); client = ['oai','app_'].join('') + this.secret(); this.secrets.push(client); this.registrations.set(this.account, client); }
    else if (supplied !== client) throw Error('registration not reused');
    const code = this.secret();
    this.codes.set(code, { nonce: u.searchParams.get('nonce')!, challenge: u.searchParams.get('code_challenge')!, client });
    const callback = new URL(p.redirectUri);
    callback.searchParams.set('state', this.badState ? 'wrong' : u.searchParams.get('state')!);
    callback.searchParams.set('code', code); callback.searchParams.set('client_id', client);
    return callback.href;
  }
  async request(r: HttpRequest): Promise<HttpResponse> {
    this.requests.push(r);
    const path = new URL(r.url).pathname;
    if (this.failPath === path) throw Error(this.secret());
    if (path === '/.well-known/openid-configuration') return { status: 200, body: { issuer: this.issuer, authorization_endpoint: this.issuer + '/authorize', token_endpoint: this.issuer + '/token', revocation_endpoint: this.issuer + '/revoke', jwks_uri: this.issuer + '/jwks' } };
    if (path === '/jwks') { this.jwksCount++; return { status: 200, body: { keys: [{ ...this.keys.publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'EdDSA' }] } }; }
    if (path === '/token') {
      const f = r.form!;
      if (f.grant_type === 'refresh_token') {
        if (!this.refreshes.delete(f.refresh_token!)) return { status: 400, body: { error: 'invalid_grant' } };
        this.refreshCount++; return this.tokens();
      }
      const code = this.codes.get(f.code!); this.codes.delete(f.code!);
      if (!code || createHash('sha256').update(f.code_verifier!).digest('base64url') !== code.challenge || f.client_id !== code.client) return { status: 400, body: { error: 'invalid_grant' } };
      const claims: Record<string, unknown> = { iss: this.issuer, aud: code.client, exp: this.now / 1000 + 3600, nonce: code.nonce, sub: this.account, workspace: 'workspace-test' };
      if (this.badClaim && this.badClaim !== 'signature') claims[this.badClaim] = this.badClaim === 'exp' ? 0 : 'wrong';
      const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'test' })).toString('base64url');
      const b = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const sig = sign(null, Buffer.from(h + '.' + b), this.keys.privateKey).toString('base64url');
      const tokens = this.tokens();
      return { ...tokens, body: { ...tokens.body as object, id_token: h + '.' + b + '.' + (this.badClaim === 'signature' ? marker() : sig) } };
    }
    if (path === '/oauth/token') return { status: 200, body: { access_token: this.secret(), token_type: 'Bearer', expires_in: 300 } };
    if (path === '/v1/models') return { status: 200, body: { data: [{ id: 'fixture-model' }] } };
    if (path === '/v1/responses') return this.errorCode ? { status: 429, body: { error: { code: this.errorCode, message: this.secret() } } } : { status: 200, body: { ok: true } };
    if (path === '/v1/realtime/client_secrets') return { status: 200, body: { value: this.secret(), expires_at: this.now / 1000 + Number((r.json?.expires_after as { seconds: number }).seconds) } };
    if (path === '/v1/live/sessions' || path === '/v1/realtime/calls') return { status: 200, body: { id: 'session-' + marker(), sdp: 'v=0\r\nsynthetic-answer' } };
    if (path === '/revoke') return { status: 200, body: {} };
    return { status: 404, body: {} };
  }
  tokens(): HttpResponse { const refresh = this.secret(); this.refreshes.add(refresh); return { status: 200, body: { access_token: this.secret(), refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: this.omitScope ? 'openid' : 'openid chatgpt.tokens.use.direct' } }; }
}
export class MemorySecrets implements SecretPort {
  readonly data = new Map<string, string>();
  async get(ref: string) { return this.data.get(ref); }
  async set(ref: string, v: string) { this.data.set(ref, v); }
  async delete(ref: string) { this.data.delete(ref); }
}
/** Models the auth core's one durable refresh owner, shared across library instances. */
export class FakeRefreshOwner implements RefreshPort {
  readonly flights = new Map<string, Promise<unknown>>();
  async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const held = this.flights.get(key) ?? Promise.resolve();
    const work = held.catch(() => {}).then(action).finally(() => { if (this.flights.get(key) === work) this.flights.delete(key); });
    this.flights.set(key, work); return work;
  }
}
