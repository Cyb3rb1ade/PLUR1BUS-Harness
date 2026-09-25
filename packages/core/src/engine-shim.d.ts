declare module "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js" {
  export const createEngine: typeof import("@cyb3rb1ade/plur1bus-memory/types/engine.js").createEngine;
}
declare module "@cyb3rb1ade/plur1bus-memory/lib/memory-request-context.js" {
  export function resolveMemoryRequestContext(commandCtx: Record<string, unknown>, options?: Record<string, unknown>): { userPrincipal: string; workspaceIdentity: string; agentId: string };
}
