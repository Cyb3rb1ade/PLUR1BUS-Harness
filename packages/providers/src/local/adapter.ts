import { isLoopbackUrl } from "./loopback.ts";
import type { ProbeResult } from "./types.ts";

/** The `ProviderCredentials` shape of the chat_completions adapter, restated so this module stands on its own. */
export interface NoAuthCredentials {
  authorization(ctx: { signal: AbortSignal }): undefined;
}

/** "No auth" mode: the adapter is asked for an Authorization value and gets none, so no header is sent. */
export const NO_AUTH: NoAuthCredentials = Object.freeze({ authorization: () => undefined });

/** The part of `ChatCompletionsConfig` this module decides. The rest (timeouts, repair, …) is the caller's. */
export interface LocalAdapterConfig {
  baseUrl: string;
  credentials: NoAuthCredentials;
}

/** Port for `createChatCompletionsAdapter` (feat/m2-providers-chat-completions). */
export type ChatAdapterFactory<A, X extends object = object> = (config: LocalAdapterConfig & X) => A;

const FORBIDDEN_LOOPBACK_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);

export interface LocalAdapterOptions {
  /** Explicit opt-in for a non-loopback base URL. Credentials then stay `NO_AUTH` unless `extra.credentials` is given. */
  allowNonLoopback?: boolean;
}

/**
 * Build a chat_completions adapter for a discovered local endpoint. Only an endpoint that answered as a model server
 * (`ok` or `empty`) is accepted; an unreachable or refused one is the caller's bug.
 *
 * RULING: a loopback model server never gets credentials: the factory always receives `NO_AUTH`, and an `extra` that
 * carries `credentials` or an authorization/proxy-authorization/cookie header is a TypeError (not silently dropped:
 * the caller believes it is sending a key). A non-loopback base URL is a TypeError unless `allowNonLoopback` is set.
 */
export function createLocalChatAdapter<A, X extends object = object>(
  endpoint: Pick<ProbeResult, "state" | "baseUrl">,
  factory: ChatAdapterFactory<A, X>,
  extra?: X,
  options?: LocalAdapterOptions,
): A {
  if (endpoint.state !== "ok" && endpoint.state !== "empty") throw new TypeError(`local endpoint is not usable (${endpoint.state})`);
  const loopback = isLoopbackUrl(endpoint.baseUrl);
  if (!loopback && options?.allowNonLoopback !== true) throw new TypeError("local endpoint is not a loopback address; pass { allowNonLoopback: true } to use it");
  const e = (extra ?? {}) as Record<string, unknown>;
  if (loopback) {
    if ("credentials" in e) throw new TypeError("no credentials for a loopback model server: remove `credentials`");
    const headers = e["headers"];
    if (headers !== null && typeof headers === "object") {
      for (const k of Object.keys(headers)) {
        if (FORBIDDEN_LOOPBACK_HEADERS.has(k.toLowerCase())) throw new TypeError(`no auth header to a loopback model server: remove header "${k}"`);
      }
    }
  }
  const credentials = !loopback && "credentials" in e ? (e["credentials"] as NoAuthCredentials) : NO_AUTH;
  return factory({ ...(extra ?? ({} as X)), baseUrl: endpoint.baseUrl, credentials });
}
