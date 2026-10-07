// Dependency defaults. Everything environmental (network, clock, randomness, secrets) is injected so tests need none of it.
import { defaultSleep } from "./retry.ts";
import type { AdapterDeps, ResolvedDeps } from "./types.ts";

export function resolveDeps(deps: AdapterDeps): ResolvedDeps {
  if (typeof deps?.getSecret !== "function") throw new TypeError("deps.getSecret is required: adapters never read secrets from the environment");
  return {
    getSecret: deps.getSecret,
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    sleep: deps.sleep ?? defaultSleep,
    random: deps.random ?? Math.random,
    now: deps.now ?? Date.now,
  };
}
