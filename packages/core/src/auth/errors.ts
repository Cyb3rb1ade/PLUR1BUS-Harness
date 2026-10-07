export type AuthErrorCode =
  | "login_failed" | "login_timeout" | "state_mismatch" | "access_denied" | "persist_failed"
  | "reauth_required"      // the stored login is dead (refresh token expired/revoked): a person must sign in again
  | "refresh_failed"       // the token endpoint could not be reached or answered 5xx: retry later, login is intact
  | "no_credential"        // nothing stored under the secret reference, or the pool has no entries
  | "all_cooling_down"     // every pool credential is in cooldown
  | "unknown_profile"
  | "delegated_login"      // the profile's login belongs to a vendor CLI; the harness never holds a header for it
  | "adc_unavailable"
  | "invalid_profile"
  | "invalid_secret_record";

/** Every message is built from constants and profile display names. Never from a token, a header, a response body or
 *  a foreign error's message, and no `cause` is retained, so an AuthError is safe to log, serialise and show as is. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly profileId?: string;
  readonly credentialId?: string;
  readonly retryable: boolean;
  /** Milliseconds until a retry can succeed (cooldown), when known. */
  readonly retryAfterMs?: number;
  /** What the person should run, e.g. `plur1bus login <profile>`. */
  readonly action?: string;
  constructor(code: AuthErrorCode, message: string, o: { profileId?: string; credentialId?: string; retryable?: boolean; retryAfterMs?: number; action?: string } = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    if (o.profileId !== undefined) this.profileId = o.profileId;
    if (o.credentialId !== undefined) this.credentialId = o.credentialId;
    this.retryable = o.retryable ?? false;
    if (o.retryAfterMs !== undefined) this.retryAfterMs = o.retryAfterMs;
    if (o.action !== undefined) this.action = o.action;
  }
}

export function isAuthError(e: unknown): e is AuthError { return e instanceof AuthError; }
