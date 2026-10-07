// Shared mock setup for the Settings > Secrets tests (names and metadata only; there is no secret.get in the mock on purpose).
import { rpcError, type MockRpc } from "./mock-rpc.ts";

export type Meta = { name: string; backend: string; createdAt: string; updatedAt: string };
export const meta = (name: string, over: Partial<Meta> = {}): Meta => ({ name, backend: "keyring", createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-02T10:00:00.000Z", ...over });

export function seedSecrets(rpc: MockRpc, initial: Meta[] = [meta("anthropic.apiKey"), meta("telegram.token", { backend: "file" })]): { secrets: Meta[] } {
  const s = { secrets: [...initial] };
  rpc.handle("secret.list", () => ({ secrets: s.secrets }), { write: false });
  rpc.handle("secret.status", () => ({ backend: "keyring", degraded: false, keyring: { available: true }, file: { enabled: false, available: null }, count: s.secrets.length, activeLeases: 2 }), { write: false });
  rpc.handle("secret.set", (p) => {
    const { name } = p as { name: string; value: string };
    const old = s.secrets.find((m) => m.name === name);
    const next = meta(name, { ...(old ? { createdAt: old.createdAt } : {}), updatedAt: "2026-10-07T08:00:00.000Z" });
    s.secrets = [...s.secrets.filter((m) => m.name !== name), next];
    return next;
  });
  rpc.handle("secret.delete", (p) => {
    const { name } = p as { name: string };
    if (!s.secrets.some((m) => m.name === name)) throw rpcError("E_NOT_FOUND", "no such secret");
    s.secrets = s.secrets.filter((m) => m.name !== name);
    return { removed: true };
  });
  return s;
}
