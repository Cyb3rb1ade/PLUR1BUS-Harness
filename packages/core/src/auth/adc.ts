import { inspect } from "node:util";
import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { AdcTokenSource } from "./credentials.ts";
import type { Clock } from "./clock.ts";
import { AuthError } from "./errors.ts";
import { parseTokenResponse, type OAuthHttp } from "./http.ts";
import { refreshSkewMs, tokenUrl, validateProfile, type AuthProfile } from "./profile.ts";

export interface GoogleAdcOptions {
  http: OAuthHttp;
  clock: Clock;
  env?: () => Record<string, string | undefined>;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
}
interface Cached { accessToken: string; expiresAt: number; refreshToken?: string }
/** ADC supports public authorized_user and service_account files, never another CLI's private token store.
 *  Cache/credentials are private; only a provider-facing token() returns a secret. */
export class GoogleAdc implements AdcTokenSource {
  readonly #o: GoogleAdcOptions;
  readonly #cache = new Map<string, Cached>();
  readonly #flights = new Map<string, Promise<Cached>>();
  constructor(o: GoogleAdcOptions) { this.#o = o; }
  async token(input: AuthProfile): Promise<{ accessToken: string; expiresAt: number }> {
    const profile = validateProfile(input);
    try {
      if (profile.kind !== "adc") throw new Error("invalid ADC profile");
      const env = (this.#o.env ?? (() => process.env))(), platform = this.#o.platform ?? process.platform;
      const paths = platform === "win32" ? win32 : posix;
      const path = env.GOOGLE_APPLICATION_CREDENTIALS ?? (platform === "win32"
        ? paths.join(env.APPDATA ?? paths.join((this.#o.homedir ?? homedir)(), "AppData", "Roaming"), "gcloud", "application_default_credentials.json")
        : paths.join((this.#o.homedir ?? homedir)(), ".config", "gcloud", "application_default_credentials.json"));
      const key = JSON.stringify([path, tokenUrl(profile), profile.scopes ?? [], profile.audience]);
      const cached = this.#cache.get(key);
      if (cached && cached.expiresAt - refreshSkewMs(profile) > this.#o.clock.now()) return new AdcToken(cached.accessToken, cached.expiresAt);
      let flight = this.#flights.get(key);
      if (!flight) {
        flight = this.#exchange(path, profile, cached).then(result => { this.#cache.set(key, result); return result; }).finally(() => this.#flights.delete(key));
        this.#flights.set(key, flight);
      }
      const value = await flight;
      return new AdcToken(value.accessToken, value.expiresAt);
    } catch { throw new AuthError("adc_unavailable", "Google application-default credentials are unavailable; configure ADC and try again."); }
  }
  async #exchange(path: string, profile: AuthProfile, cached?: Cached): Promise<Cached> {
    const raw = await (this.#o.readFile ?? (p => readFile(p, "utf8")))(path);
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error("invalid ADC");
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid ADC");
    const c = data as Record<string, unknown>;
    const endpoint = tokenUrl(profile) ?? (typeof c.token_uri === "string" ? c.token_uri : "https://oauth2.googleapis.com/token");
    let form: Record<string, string>;
    if (c.type === "authorized_user") {
      if (![c.client_id, c.client_secret, c.refresh_token].every(v => typeof v === "string" && v.length > 0)) throw new Error("invalid ADC");
      form = { grant_type: "refresh_token", client_id: c.client_id as string, client_secret: c.client_secret as string, refresh_token: cached?.refreshToken ?? c.refresh_token as string };
    } else if (c.type === "service_account") {
      if (typeof c.client_email !== "string" || typeof c.private_key !== "string" || !profile.scopes?.length) throw new Error("invalid ADC");
      const key = createPrivateKey(c.private_key);
      if (key.asymmetricKeyType !== "rsa") throw new Error("invalid ADC");
      const iat = Math.floor(this.#o.clock.now() / 1000);
      const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const body = `${encode({ alg: "RS256", typ: "JWT", ...(typeof c.private_key_id === "string" ? { kid: c.private_key_id } : {}) })}.${encode({ iss: c.client_email, scope: profile.scopes.join(" "), aud: profile.audience ?? endpoint, iat, exp: iat + 3600 })}`;
      form = { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}` };
    } else throw new Error("invalid ADC");
    const result = parseTokenResponse(await this.#o.http.post(endpoint, form));
    if (result.expiresInSeconds === undefined) throw new Error("invalid ADC response");
    return { accessToken: result.accessToken, expiresAt: this.#o.clock.now() + result.expiresInSeconds * 1000, ...((result.refreshToken ?? cached?.refreshToken) ? { refreshToken: result.refreshToken ?? cached!.refreshToken! } : {}) };
  }
}

class AdcToken {
  readonly #value: string;
  readonly expiresAt: number;
  constructor(value: string, expiresAt: number) { this.#value = value; this.expiresAt = expiresAt; }
  get accessToken() { return this.#value; }
  toJSON() { return { accessToken: "[redacted]", expiresAt: this.expiresAt }; }
  [inspect.custom]() { return this.toJSON(); }
}
