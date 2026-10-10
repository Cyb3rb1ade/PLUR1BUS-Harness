// Mock /rpc data for the Users & roles section tests (test/users-*.test.ts). Shapes follow docs/rpc.md (identity.list, config.get).
import type { MockRpc } from "./mock-rpc.ts";

export const HUMANS = [
  { id: "01-anna", displayName: "Anna Beispiel", createdAt: 1_700_000_000_000, identities: [
    { id: "l1", humanId: "01-anna", channel: "telegram", revokedAt: null }, { id: "l2", humanId: "01-anna", channel: "matrix", revokedAt: null }] },
  { id: "01-ben", displayName: "Ben Muster", createdAt: 1_700_000_100_000, identities: [] },
  { id: "01-cleo", displayName: "Cleo Test", createdAt: 1_700_000_200_000, identities: [{ id: "l3", humanId: "01-cleo", channel: "telegram", revokedAt: null }] },
];
export const PAIRINGS = [{ id: "p1", humanId: "01-ben", channel: "telegram", state: "pending", createdAt: 1, expiresAt: 2 }];
export const AGENTS = { main: { model: "x" }, research: {}, ops: {} };

export type Seed = { humans?: unknown[]; pairings?: unknown[]; agents?: unknown };

export function seed(rpc: MockRpc, o: Seed = {}): void {
  rpc.handle("identity.list", () => ({ humans: o.humans ?? HUMANS, pairings: o.pairings ?? PAIRINGS }), { write: false });
  rpc.handle("config.get", (p) => ({ key: (p as { key?: string }).key ?? null, tier: null, value: o.agents ?? AGENTS, restartClass: "live", restart: "live", revision: "r1" }), { write: false });
}

/** Methods called other than the reads: any of them would mean the page sent a mutation it must not. */
export const nonReads = (rpc: MockRpc): string[] => rpc.calls.map((c) => c.method).filter((m) => m !== "identity.list" && m !== "config.get" && m !== "user.list" && m !== "user.invite.list" && m !== "breakglass.list");
