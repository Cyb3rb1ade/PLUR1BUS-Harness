// Mock /rpc for the Agents page tests: config.get / config.set over an in-memory `agents` map with a revision counter, ext.list,
// and lifecycle RPCs (agent.pause, agent.resume, agent.archive, agent.unarchive, agent.export, agent.delete).
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
  rpc.handle("agent.pause", (p) => {
    const id = (p as { agentId: string }).agentId;
    if (w.agents[id]) w.agents[id].state = "paused";
    return { agentId: id, paused: true, archived: false, deleted: false };
  });
  rpc.handle("agent.resume", (p) => {
    const id = (p as { agentId: string }).agentId;
    if (w.agents[id]) w.agents[id].state = "active";
    return { agentId: id, paused: false, archived: false, deleted: false };
  });
  rpc.handle("agent.archive", (p) => {
    const id = (p as { agentId: string }).agentId;
    if (w.agents[id]) w.agents[id].state = "archived";
    return { agentId: id, paused: false, archived: true, deleted: false };
  });
  rpc.handle("agent.unarchive", (p) => {
    const id = (p as { agentId: string }).agentId;
    if (w.agents[id]) w.agents[id].state = "active";
    return { agentId: id, paused: false, archived: false, deleted: false };
  });
  rpc.handle("agent.export", (p) => {
    const id = (p as { agentId: string }).agentId;
    return {
      agentId: id,
      offerId: "off_1",
      expiresAt: Date.now() + 60000,
      bundle: {
        format: "plur1bus.agent-export/1",
        files: [],
        manifest: { format: "plur1bus.agent-export/1", agentId: id, files: [] },
        manifestHash: "h1",
        algorithm: "Ed25519",
        publicKey: "k",
        signature: "s",
      },
    };
  });
  rpc.handle("agent.delete", (p) => {
    const id = (p as { agentId: string }).agentId;
    delete w.agents[id];
    return { agentId: id, deleted: true };
  });
  return w;
}

export const callsOf = (server: MockHarnessServer, method: string): { method: string; params: unknown }[] => server.rpc.calls.filter((c) => c.method === method);
