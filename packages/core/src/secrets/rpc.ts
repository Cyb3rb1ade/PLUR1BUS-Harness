import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";
import { SecretError, type SecretErrorCode } from "./types.ts";
import type { SecretStore } from "./store.ts";
import type { SecretPrincipal } from "./types.ts";

export type SecretMethod = "secret.status" | "secret.list" | "secret.set" | "secret.get" | "secret.delete";

const MAP: Record<SecretErrorCode, RpcError["error"]> = {
  denied: "E_DENIED", "not-found": "E_NOT_FOUND", "invalid-name": "E_INVALID_PARAMS", "invalid-value": "E_INVALID_PARAMS", "invalid-ttl": "E_INVALID_PARAMS",
  "no-backend": "E_NOT_AVAILABLE", "backend-unavailable": "E_NOT_AVAILABLE", corrupt: "E_STORAGE", storage: "E_STORAGE", "audit-unavailable": "E_STORAGE", "lease-invalid": "E_INVALID_PARAMS",
};
const FIELD: Partial<Record<SecretErrorCode, string>> = { "invalid-name": "name", "invalid-value": "value" };

/** SecretError → RpcError. The message is the store's fixed text (names and codes only); nothing else is forwarded. */
export function toRpcError(e: unknown): unknown {
  if (!(e instanceof SecretError)) return e;
  const detail = FIELD[e.code];
  return new RpcError(MAP[e.code], e.message, { reason: e.code, ...(detail ? { detail } : {}) });
}

export interface SecretMethodDeps {
  store: SecretStore;
  /** Derives who is calling from the connection. A client can never name its own principal. Fail closed: a connection
   *  for which this answers anything but `owner` is refused every `secret.*` method. */
  principalOf: (ctx: { connectionId: string }) => SecretPrincipal;
}

/** `secret.*` (M2, ADR-005): owner only. The store enforces it; the handlers add nothing but the wire mapping. */
export function buildSecretMethods(d: SecretMethodDeps): Record<SecretMethod, Handler> {
  const wrap = (fn: (p: SecretPrincipal, params: any) => Promise<unknown>): Handler => async (params, ctx) => {
    try { return await fn(d.principalOf(ctx), params); } catch (e) { throw toRpcError(e); }
  };
  return {
    "secret.status": wrap((p) => d.store.status(p)),
    "secret.list": wrap(async (p) => ({ secrets: await d.store.list(p) })),
    "secret.set": wrap((p, a: { name: string; value: string }) => d.store.set(p, a.name, a.value)),
    "secret.get": wrap(async (p, a: { name: string; reveal?: boolean }) => {
      if (a.reveal === true) { const r = await d.store.reveal(p, a.name); return { secret: r.meta, value: r.value }; }
      return { secret: await d.store.meta(p, a.name) };
    }),
    "secret.delete": wrap((p, a: { name: string }) => d.store.delete(p, a.name)),
  };
}
