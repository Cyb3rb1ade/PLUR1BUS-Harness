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

/**
 * Build a chat_completions adapter for a discovered local endpoint, without credentials. Only an endpoint that
 * answered as a model server (`ok` or `empty`) is accepted; an unreachable or refused one is the caller's bug.
 */
export function createLocalChatAdapter<A, X extends object = object>(
  endpoint: Pick<ProbeResult, "state" | "baseUrl">,
  factory: ChatAdapterFactory<A, X>,
  extra?: X,
): A {
  if (endpoint.state !== "ok" && endpoint.state !== "empty") throw new TypeError(`local endpoint is not usable (${endpoint.state})`);
  return factory({ ...(extra ?? ({} as X)), baseUrl: endpoint.baseUrl, credentials: NO_AUTH });
}
