import { SecretError, type BackendProbe, type SecretBackend, type SecretMeta } from "./types.ts";

/** The in-memory test backend (ADR-005 action 5). `available` can be flipped by a test. */
export function createMemoryBackend(o: { available?: boolean } = {}): SecretBackend & { available: boolean; dump(): Map<string, string> } {
  const entries = new Map<string, { value: string; createdAt: string; updatedAt: string }>();
  const self = {
    kind: "memory" as const,
    available: o.available ?? true,
    async probe(): Promise<BackendProbe> { return self.available ? { available: true } : { available: false, reason: "memory-backend-off" }; },
    async get(name: string) { guard(); return entries.get(name)?.value ?? null; },
    async put(name: string, value: string, now: Date): Promise<SecretMeta> {
      guard();
      const at = now.toISOString();
      const old = entries.get(name);
      entries.set(name, { value, createdAt: old?.createdAt ?? at, updatedAt: at });
      return { name, backend: "memory", createdAt: old?.createdAt ?? at, updatedAt: at };
    },
    async delete(name: string) { guard(); return entries.delete(name); },
    async list(): Promise<SecretMeta[]> {
      guard();
      return [...entries].map(([name, e]) => ({ name, backend: "memory" as const, createdAt: e.createdAt, updatedAt: e.updatedAt })).sort((a, b) => a.name.localeCompare(b.name));
    },
    dump: () => new Map([...entries].map(([k, v]) => [k, v.value])),
  };
  function guard(): void { if (!self.available) throw new SecretError("backend-unavailable", "memory backend is off"); }
  return self;
}
