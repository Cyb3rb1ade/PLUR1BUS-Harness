import type { Scope } from "../../src/media-search/types.ts";

export function scope(agentId = "a1", user?: string): Scope {
  return { agentId, workspace: "ws", ...(user ? { user } : {}), channel: "test", accountId: "acc", chat: { id: "c", kind: "dm" }, trust: "proved" } as unknown as Scope;
}
