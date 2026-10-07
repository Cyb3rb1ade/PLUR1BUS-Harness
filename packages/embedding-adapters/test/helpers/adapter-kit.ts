// Shared scaffolding for adapter tests: no sleeping, deterministic jitter, a fixed fake secret.
import type { AdapterDeps } from "../../src/types.ts";
import { fixtureFetch, type StepSource } from "./fixture-fetch.ts";

export const FAKE_SECRET = "test-secret-0123456789abcdef";

export function kit(source: StepSource, extra: Partial<AdapterDeps> = {}) {
  const { fetch, requests } = fixtureFetch(source);
  const sleeps: number[] = [];
  const deps: AdapterDeps = {
    getSecret: (name) => (name === "missing" ? undefined : FAKE_SECRET),
    fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
    now: () => 1_700_000_000_000,
    ...extra,
  };
  return { deps, requests, sleeps };
}
