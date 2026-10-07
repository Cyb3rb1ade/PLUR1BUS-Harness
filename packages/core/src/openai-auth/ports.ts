import { inspect } from 'node:util';
import type { Clock } from '../auth/clock.ts';
import type { SecretStore } from '../auth/secret-store.ts';
export type { Clock };
export type SecretPort = SecretStore;
/** One core-owned, process-wide authority. Implementations must serialize all consumers of a key. */
export interface RefreshPort { exclusive<T>(key: string, action: () => Promise<T>): Promise<T> }
export interface HttpRequest { method: 'GET' | 'POST'; url: string; authorization?: Sensitive; form?: Record<string, string>; json?: Record<string, unknown>; sdp?: string; headers?: Record<string, string>; signal?: AbortSignal }
export interface HttpResponse { status: number; body: unknown }
/** Egress-approved, pinned, bounded transport. Never follow redirects or log request/response payloads. */
export interface HttpPort { request(request: HttpRequest): Promise<HttpResponse> }
export interface PkcePort { redirect(): Promise<string>; close(): Promise<void>; authorize(request: { url: Sensitive; redirectUri: string; signal: AbortSignal }): Promise<string> }
export interface AuditEvent { kind: 'login' | 'logout' | 'refresh' | 'failover' | 'mint' | 'session-start' | 'session-close'; provider?: 'openai:realtime' | 'openai:gpt-live'; ttlSeconds?: number; from?: BillingPath; to?: BillingPath; crossBilling?: boolean; agentRef?: string; surface?: 'desktop' | 'web' | 'channel' | 'group'; sessionRef?: string }
export type AuditPort = (event: AuditEvent) => void;
export type BillingPath = 'api_key' | 'chatgpt_plan' | 'workload' | 'cli_login';
export type Region = 'global' | 'us' | 'eu';
export const ERROR_CODES = ['invalid-request', 'transport-failed', 'endpoint-rejected', 'discovery-invalid', 'state-mismatch', 'id-token-invalid', 'scope-denied', 'auth-required', 'owner-only', 'persist-failed', 'siwc-unsupported', 'credential-denied', 'surface-denied', 'ephemeral-consumed', 'budget-exceeded', 'capacity-exceeded', 'transport-unavailable', 'policy-denied', 'session-unknown', 'subscription_sharing_usage_limit_exceeded', 'subscription_sharing_authentication_required', 'subscription_sharing_not_enabled', 'subscription_sharing_workspace_not_allowed', 'subscription_sharing_invalid_token', 'subscription_sharing_user_not_eligible', 'subscription_sharing_usage_unavailable', 'subscription_sharing_unsupported_capability', 'subscription_sharing_route_not_supported', 'subscription_sharing_invalid_user', 'subscription_sharing_user_unavailable', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
/** Constant messages and closed codes: vendor payloads and foreign exceptions never escape. */
export class OpenAIError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { const safe: ErrorCode = ERROR_CODES.includes(code) ? code : 'endpoint-rejected'; super('OpenAI operation refused (' + safe + ').'); this.name = 'OpenAIError'; this.code = safe; }
  toJSON() { return { code: this.code, message: this.message }; }
}
export class Sensitive {
  readonly #secret: string;
  constructor(secret: string) { this.#secret = secret; }
  value() { return this.#secret; }
  toJSON() { return '[redacted]'; }
  [inspect.custom]() { return this.toJSON(); }
}
export function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new OpenAIError('endpoint-rejected'); return v as Record<string, unknown>; }
export function text(v: unknown): string { if (typeof v !== 'string' || !v || /[\r\n\0]/.test(v)) throw new OpenAIError('endpoint-rejected'); return v; }
export function positive(v: unknown): number { if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new OpenAIError('endpoint-rejected'); return v; }
const wireCodes = new Set<ErrorCode>(ERROR_CODES.filter(c => c.startsWith('subscription_sharing_') || c.startsWith('chatpass_v2_')));
export async function call(http: HttpPort, request: HttpRequest): Promise<unknown> {
  let res: HttpResponse;
  Object.defineProperty(request, 'toJSON', { value: () => ({ method: request.method, payload: '[redacted]' }) });
  Object.defineProperty(request, inspect.custom, { value: () => ({ method: request.method, payload: '[redacted]' }) });
  try { res = await http.request(request); } catch { throw new OpenAIError('transport-failed'); }
  if (res.status < 200 || res.status >= 300) {
    const body = res.body && typeof res.body === 'object' ? res.body as Record<string, unknown> : {};
    const err = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {};
    const code = err.code;
    throw new OpenAIError(typeof code === 'string' && wireCodes.has(code as ErrorCode) ? code as ErrorCode : body.error === 'invalid_grant' ? 'auth-required' : 'endpoint-rejected');
  }
  return res.body;
}
/** Sanitizes arbitrary injected boundary failures; local library errors alone retain their fixed code. */
export async function boundary<T>(action: () => Promise<T>, fallback: ErrorCode = 'transport-failed'): Promise<T> { try { return await action(); } catch (e) { throw e instanceof OpenAIError ? new OpenAIError(e.code) : new OpenAIError(fallback); } }

/** Abort a hung port independently of whether that port honours its signal. */
export function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new OpenAIError('auth-required'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Raw streamed inference remains in-process; generic output, snapshots and exports see no body. */
export class SensitivePayload {
  readonly #body: unknown;
  constructor(body: unknown) { this.#body = body; }
  value() { return this.#body; }
  toJSON() { return { payload: '[redacted]' }; }
  [inspect.custom]() { return this.toJSON(); }
}
