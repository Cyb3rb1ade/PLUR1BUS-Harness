import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { boundary, call, object, text, OpenAIError, type SecretPort, type RefreshPort, type HttpPort, type Clock } from './ports.ts';
export class HostIdentity {
  readonly #store: SecretPort; readonly #owner: RefreshPort;
  constructor(store: SecretPort, owner: RefreshPort) { this.#store = store; this.#owner = owner; }
  async id(): Promise<string> {
    return boundary(() => this.#owner.exclusive('openai.host', async () => {
      const ref = 'openai.host.key'; let raw = await this.#store.get(ref);
      if (raw === undefined) { const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }); raw = JSON.stringify(key); await this.#store.set(ref, raw); }
      const key = createPrivateKey({ key: JSON.parse(raw) as JsonWebKey, format: 'jwk' });
      const jwk = createPublicKey(key).export({ format: 'jwk' });
      if (jwk.crv !== 'Ed25519' || jwk.kty !== 'OKP' || !jwk.x) throw new OpenAIError('persist-failed');
      // RFC 7638 lexicographically ordered public members; private d is never hashed or exported.
      const thumb = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest('base64url');
      return 'urn:ietf:params:oauth:jwk-thumbprint:sha-256:' + thumb;
    }), 'persist-failed');
  }
}
export interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; revocation_endpoint: string; jwks_uri: string }
export async function discovery(http: HttpPort): Promise<Discovery> {
  const data = object(await call(http, { method: 'GET', url: 'https://auth.openai.com/.well-known/openid-configuration' }));
  if (data.issuer !== 'https://auth.openai.com') throw new OpenAIError('discovery-invalid');
  for (const k of ['authorization_endpoint','token_endpoint','revocation_endpoint','jwks_uri']) {
    const url = new URL(text(data[k]));
    if (url.origin !== data.issuer || url.username || url.password || url.search || url.hash) throw new OpenAIError('discovery-invalid');
  }
  return data as unknown as Discovery;
}
/** Signature verification is performed locally, never trusted from decoded claims or a remote validation response. */
export class JwksVerifier {
  readonly #http: HttpPort; readonly #clock: Clock;
  readonly #cache = new Map<string, { until: number; keys: Record<string, unknown>[] }>();
  readonly #flights = new Map<string, Promise<Record<string, unknown>[]>>();
  constructor(http: HttpPort, clock: Clock) { this.#http = http; this.#clock = clock; }
  async #keys(url: string) {
    const cached = this.#cache.get(url); if (cached && cached.until > this.#clock.now()) return cached.keys;
    let flight = this.#flights.get(url);
    if (!flight) {
      flight = (async () => { const data = object(await call(this.#http, { method: 'GET', url })); if (!Array.isArray(data.keys) || data.keys.length > 64) throw new OpenAIError('id-token-invalid'); const keys = data.keys.map(object); this.#cache.set(url, { until: this.#clock.now() + 300000, keys }); return keys; })().finally(() => this.#flights.delete(url));
      this.#flights.set(url, flight);
    }
    return flight;
  }
  async validate(token: string, expected: { discovery: Discovery; audience: string; nonce: string }): Promise<{ sub: string; workspace: string }> {
    try {
      if (token.length > 32768) throw new Error();
      const parts = token.split('.'); if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
      const header = object(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()));
      const claims = object(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()));
      if (!['RS256','EdDSA'].includes(String(header.alg))) throw new Error();
      const keys = await this.#keys(expected.discovery.jwks_uri);
      const matches = keys.filter(k => k.kid === header.kid && (!k.alg || k.alg === header.alg) && (!k.use || k.use === 'sig'));
      if (matches.length !== 1) throw new Error();
      const jwk = matches[0]!;
      if ((header.alg === 'RS256' && jwk.kty !== 'RSA') || (header.alg === 'EdDSA' && (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519'))) throw new Error();
      const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
      if (!verify(header.alg === 'RS256' ? 'RSA-SHA256' : null, Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2]!, 'base64url'))) throw new Error();
      const aud = claims.aud; const validAud = aud === expected.audience || (Array.isArray(aud) && aud.includes(expected.audience) && (aud.length === 1 || claims.azp === expected.audience));
      if (claims.iss !== expected.discovery.issuer || !validAud || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= this.#clock.now() / 1000 || claims.nonce !== expected.nonce) throw new Error();
      if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > this.#clock.now() / 1000)) throw new Error();
      return { sub: text(claims.sub), workspace: text(claims.workspace ?? claims.workspace_id ?? object(claims['https://api.openai.com/auth']).chatgpt_account_id) };
    } catch { throw new OpenAIError('id-token-invalid'); }
  }
}
