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
declare module "@cyb3rb1ade/plur1bus-memory/lib/reembedding/fingerprint.js" {
  export function embeddingFingerprintId(fingerprint: Record<string, unknown>): string;
  export function compareEmbeddingFingerprints(left: Record<string, unknown>, right: Record<string, unknown>): { equal: boolean; requiresMigration: boolean; leftId: string; rightId: string };
}
