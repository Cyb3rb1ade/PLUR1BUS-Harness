import { authenticatedPrincipal } from "./rbac/guard.ts";
import type { ActivityQuery, ActivityTracker } from "./activity.ts";
import type { Handler } from "./rpc/server.ts";

export function buildActivityMethods(tracker: ActivityTracker, agents: () => string[]): Record<string, Handler> {
  return {
    "agent.activity.list": async (p: ActivityQuery, ctx) => {
      const principal = authenticatedPrincipal(ctx);
      const visible = agents().filter(id => principal.role === "owner" || principal.role === "admin" || (Object.hasOwn(principal.agentRights ?? {}, id) && ["use", "manage"].includes(principal.agentRights![id]!)));
      return tracker.list(p ?? {}, visible);
    },
  };
}
