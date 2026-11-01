/** Local adapter construction: keyless loopback servers and D122's guarded, system-only managed Unix provider. */
import { ProviderError } from "../errors.ts";
import { validateRequest } from "../request.ts";
import type { CallOptions, ChatCompletionsAdapter, ChatRequest } from "../types.ts";
import { isLoopbackUrl } from "./loopback.ts";
import type { ProbeResult } from "./types.ts";
import { APPLE_FM_BASE_URL, createUnixFetch } from "./unix.ts";
import type { ManagedUnixSocket, UnixFetchOptions } from "./unix.ts";

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
  fetch?: typeof fetch;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}

/** Port for `createChatCompletionsAdapter` (feat/m2-providers-chat-completions). */
export type ChatAdapterFactory<A, X extends object = object> = (config: LocalAdapterConfig & X) => A;

const FORBIDDEN_LOOPBACK_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);

export interface LocalAdapterOptions {
  /** Explicit opt-in for a non-loopback base URL. Credentials then stay `NO_AUTH` unless `extra.credentials` is given. */
  allowNonLoopback?: boolean;
  /** D122: composition resolves this descriptor from Layout and supplies its filesystem guard. */
  unix?: UnixFetchOptions & { socket: ManagedUnixSocket };
}

/** A successful probe endpoint; profiles name a managed id, never a filesystem path. */
export interface LocalAdapterEndpoint {
  state: ProbeResult["state"] | "unavailable";
  baseUrl: string;
  socket?: "managed:apple-fm";
}

function checkManagedRequest(request: ChatRequest): void {
  if (request.model !== "system") {
    throw new ProviderError("invalid_request", "Apple FM only allows the on-device system model", {
      code: "model_not_allowed", retryable: false,
    });
  }
  if (request.reasoning !== undefined) {
    throw new ProviderError("invalid_request", "Apple FM does not support a reasoning directive", { retryable: false });
  }
  validateRequest(request);
  for (const message of request.messages) {
    if (message.role === "user" && Array.isArray(message.content)
      && message.content.some((part) => part.type === "image_url")) {
      throw new ProviderError("invalid_request", "Apple FM does not accept image parts", { retryable: false });
    }
  }
}

function managedError(error: unknown): unknown {
  if (error instanceof ProviderError && (error.kind === "context_length"
    || ((error.status === 500 || error.status === undefined) && error.providerType === "server_error"
      && error.providerMessage === "The session's transcript exceeded the model's context size."))) {
    // AF0: HTTP 500 JSON or the same error inside HTTP 200 SSE. Neither is a retryable outage.
    // Keep other vendors' 5xx taxonomy unchanged.
    return new ProviderError("invalid_request", "Apple FM request exceeds the model context window", {
      code: "context_overflow", retryable: false, ...(error.status === undefined ? {} : { status: error.status }),
    });
  }
  return error;
}

function managedAdapter<A>(inner: A): A {
  const adapter = inner as A & ChatCompletionsAdapter;
  if (typeof adapter?.complete !== "function" || typeof adapter?.stream !== "function") {
    throw new TypeError("managed Unix factory must return a chat completions adapter");
  }
  let active = false;
  const acquire = (request: ChatRequest, options: CallOptions | undefined) => {
    checkManagedRequest(request);
    if (options?.signal?.aborted) throw new ProviderError("aborted", "call aborted by the caller");
    // D122 §3.2 / AF0: no parallel model-execution proof. Busy calls fall back instead of building an unbounded queue.
    if (active) {
      throw new ProviderError("network", "Apple FM inference is busy", { code: "unavailable", retryable: false });
    }
    active = true;
  };
  return {
    ...inner,
    async complete(request: ChatRequest, options?: CallOptions) {
      acquire(request, options);
      try {
        return await adapter.complete(request, options);
      } catch (error) {
        throw managedError(error);
      } finally {
        active = false;
      }
    },
    async *stream(request: ChatRequest, options?: CallOptions) {
      acquire(request, options);
      try {
        yield* adapter.stream(request, options);
      } catch (error) {
        throw managedError(error);
      } finally {
        active = false;
      }
    },
  };
}

function createManagedAdapter<A, X extends object>(
  endpoint: LocalAdapterEndpoint, factory: ChatAdapterFactory<A, X>, extra: X | undefined,
  unix: NonNullable<LocalAdapterOptions["unix"]>,
): A {
  if (endpoint.baseUrl !== APPLE_FM_BASE_URL || endpoint.socket !== "managed:apple-fm") {
    throw new TypeError("managed Unix endpoint must name managed:apple-fm at its fixed base URL");
  }
  const config = (extra ?? {}) as Record<string, unknown>;
  if ("credentials" in config || "fetch" in config || "socket" in config) {
    throw new TypeError("managed Unix credentials, fetch and socket paths cannot come from a profile");
  }
  let headers: Headers;
  try {
    headers = new Headers(config["headers"] as HeadersInit | undefined);
  } catch {
    // Native Headers errors may echo a rejected credential value; retain no message or cause from them.
    throw new TypeError("managed Unix headers are malformed");
  }
  headers.forEach((_value, name) => {
    if (FORBIDDEN_LOOPBACK_HEADERS.has(name)) throw new TypeError("no auth header to a managed Unix model server");
  });
  return managedAdapter(factory({
    ...(extra ?? ({} as X)), baseUrl: APPLE_FM_BASE_URL, credentials: NO_AUTH,
    fetch: createUnixFetch(unix.socket, unix), maxTokensField: "max_completion_tokens",
  }));
}

/**
 * Build a chat_completions adapter for a discovered local endpoint. Only an endpoint that answered as a model server
 * (`ok` or `empty`) is accepted; an unreachable or refused one is the caller's bug.
 *
 * RULING: a loopback model server never gets credentials: the factory always receives `NO_AUTH`, and an `extra` that
 * carries `credentials` or an authorization/proxy-authorization/cookie header is a TypeError (not silently dropped:
 * the caller believes it is sending a key). A non-loopback base URL is a TypeError unless `allowNonLoopback` is set.
 * Managed Unix mode instead requires managed:apple-fm and its fixed origin, supplies its own fetch and NO_AUTH,
 * and wraps a real chat adapter with the system-only, no-images/no-reasoning policy and one active inference.
 */
export function createLocalChatAdapter<A, X extends object = object>(
  endpoint: LocalAdapterEndpoint,
  factory: ChatAdapterFactory<A, X>,
  extra?: X,
  options?: LocalAdapterOptions,
): A {
  if (endpoint.state !== "ok" && endpoint.state !== "empty") throw new TypeError(`local endpoint is not usable (${endpoint.state})`);
  if (options?.unix) return createManagedAdapter(endpoint, factory, extra, options.unix);
  if (endpoint.socket !== undefined) throw new TypeError("managed socket endpoint needs a guarded Unix transport");
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
