/** What the API needs of the core: one call. `@plur1bus/module-api`'s `CoreClient` satisfies it; tests pass a fake. */
export interface CoreRpc { call<T = unknown>(method: string, params?: object): Promise<T> }
