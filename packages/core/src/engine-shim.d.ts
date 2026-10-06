declare module "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js" {
  export const createEngine: typeof import("@cyb3rb1ade/plur1bus-memory/types/engine.js").createEngine;
}
declare module "@cyb3rb1ade/plur1bus-memory/lib/memory-request-context.js" {
  export function resolveMemoryRequestContext(commandCtx: Record<string, unknown>, options?: Record<string, unknown>): { userPrincipal: string; workspaceIdentity: string; agentId: string };
}
declare module "@cyb3rb1ade/plur1bus-memory/lib/group-reasoning-filter.js" {
  export function isForeignReasoningMessage(text: unknown, opts?: { prefixes?: string[] }): boolean;
  export function createGroupReasoningFilter(opts?: {
    enabled?: boolean;
    prefixes?: string[];
    logger?: { info?: (...args: unknown[]) => void };
  }): (event: Record<string, unknown>, ctx: Record<string, unknown>) => { handled: true } | undefined;
}
declare module "@cyb3rb1ade/plur1bus-memory/lib/snapshot/store-snapshot.js" {
  export class SnapshotError extends Error { readonly reason: "source-busy" | "insufficient-disk" | "digest-mismatch" | "not-found" | "unsafe-path" }
  export function createSnapshot(o: { stateDir: string; baseDbPath: string; snapshotsDir?: string; label?: string; pluginVersion?: string; now?: () => number; maxKeep?: number }):
    Promise<{ id: string; dir: string; bytes: number; files: number; pruned: string[]; warnings: string[] }>;
  export function verifySnapshot(o: { dir: string }): Promise<unknown>;
}
