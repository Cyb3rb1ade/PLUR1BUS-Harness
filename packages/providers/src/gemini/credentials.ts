import type { GeminiCredentials, SecretReader } from "./types.ts";

/**
 * The key of one profile, read from the secret store on every call (a rotated key is picked up without a restart;
 * nothing is cached here). `ref` is the profile's `secret_ref`, a handle and never a value. A store failure or a
 * missing entry yields no key, which the adapter turns into an `auth` error before any request is made.
 */
export function secretStoreKey(store: SecretReader, ref: string): GeminiCredentials {
  return {
    async apiKey() {
      return await store.get(ref);
    },
  };
}
