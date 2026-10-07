// Mock /rpc for the Agents page tests: config.get / config.set over an in-memory `agents` map with a revision counter, ext.list.
import { rpcError } from "./mock-rpc.ts";
import type { MockHarnessServer } from "./mock-server.ts";

export type Entry = { displayName: string; createdAt: string; skills: string[]; state?: string };
export type World = { agents: Record<string, Entry>; revision: number; skills: string[]; sets: number };

export const world = (over: Partial<World> = {}): World => ({
  agents: {
    main: { displayName: "Main", createdAt: "2026-09-01T09:00:00.000Z", skills: ["web-search", "calendar"] },
    scribe: { displayName: "Scribe", createdAt: "2026-09-20T09:00:00.000Z", skills: [], state: "archived" },
  },
  revision: 1, skills: ["web-search", "calendar", "notes"], sets: 0, ...over,
});

export function installAgents(server: MockHarnessServer, w: World = world()): World {
  const rpc = server.rpc;
  rpc.handle("config.get", (p) => {
    const key = (p as { key?: string } | undefined)?.key;
    if (key === "agents") return { key, tier: null, value: w.agents, restartClass: "live", restart: "live", revision: `r${w.revision}` };
    return { key: null, tier: null, value: { agents: w.agents }, restartClass: null, restart: null, revision: `r${w.revision}` };
  }, { write: false });
  rpc.handle("config.set", (p) => {
    const q = p as { changes: { key: string; value: Entry }[]; ifRevision?: string };
    if (q.ifRevision !== undefined && q.ifRevision !== `r${w.revision}`) throw rpcError("E_CONFLICT", "changed", "config-changed");
    for (const c of q.changes) w.agents[c.key.replace(/^agents\./, "")] = c.value;
    w.revision += 1; w.sets += 1;
    return { applied: true, dryRun: false, changed: q.changes.map((c) => c.key), restart: {}, revision: `r${w.revision}`, restarted: [], durationMs: 1 };
  });
  rpc.handle("ext.list", () => ({ items: w.skills.map((name) => ({ name, kind: "skill" })) }), { write: false });
  return w;
}

export const callsOf = (server: MockHarnessServer, method: string): { method: string; params: unknown }[] => server.rpc.calls.filter((c) => c.method === method);
