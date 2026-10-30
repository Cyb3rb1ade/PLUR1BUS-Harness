import type { ApiPrincipal, ApiTransport, AudienceTarget } from "@plur1bus/module-api";
/** What the API needs of the core: one call. `@plur1bus/module-api`'s `CoreClient` satisfies it; tests pass a fake. */
export interface CoreRpc {
  call<T = unknown>(method: string, params?: object): Promise<T>;
  serviceCall?<T = unknown>(method: string, params?: object): Promise<T>;
  callAs?<T = unknown>(method: string, params: object, principal: ApiPrincipal, endpoint: "core" | "supervisor", connectionKey?: string, transport?: ApiTransport): Promise<T>;
  subscribeAs?(principal: ApiPrincipal, listener: (method: string, params: unknown, delivery: { audience: readonly AudienceTarget[] | null; connectionId: string }) => void, closed: () => void, connectionKey?: string): Promise<() => void>;
  /** Supervisor progress for one authenticated maintenance run; it never opens a Core event feed. */
  subscribeImportAs?(principal: ApiPrincipal, runId: string, listener: (params: unknown) => void, closed: () => void, connectionKey?: string): Promise<() => void>;
}
