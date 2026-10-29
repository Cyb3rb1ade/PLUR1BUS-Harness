import type { HarnessConfig } from "@plur1bus/config-schema";
import { authorize } from "../rbac/authorize.ts";
import type { Principal } from "../rbac/types.ts";
import { channelSwitches } from "./config.ts";
import { NO_SCOPES, type Exposure, type ExposureChannel, type ScopeAccess } from "./types.ts";

/** What the principal may read of the agent's memory, by the RBAC table (`memory.*.read`, ADR-007 "Privacy"): the user
 *  scope only its own, the workspace scope with at least `use` on the agent, the agent-private scope with `manage`. */
export function readRights(principal: Principal | null | undefined, agentId: string): ScopeAccess {
  if (!principal) return NO_SCOPES;
  const allowed = (action: string, resource: Parameters<typeof authorize>[2]) => authorize(principal, action, resource).effect === "allow";
  return {
    workspace: allowed("memory.workspace.read", { kind: "memory", scope: "workspace", agentId }),
    // An agent acting through a tool has no person behind it: there is no user scope to read.
    user: principal.kind !== "agent" && allowed("memory.user.read", { kind: "memory", scope: "user", ownerUserId: principal.userId }),
    agentPrivate: allowed("memory.agent-private.read", { kind: "memory", scope: "agent-private", agentId }),
  };
}

/** The effective memory exposure of `agentId` on `channel` for the person (or agent) who asked: a scope is read only when
 *  the agent's switch is on and the principal holds the right. A switch can narrow, never widen. */
export function resolveExposure(a: { channel: ExposureChannel; agentId: string; principal: Principal | null | undefined; config: HarnessConfig }): Exposure {
  const switches = channelSwitches(a.config, a.agentId, a.channel);
  const rights = readRights(a.principal, a.agentId);
  return {
    channel: a.channel,
    agentId: a.agentId,
    switches,
    rights,
    recall: {
      workspace: switches.recall.workspace && rights.workspace,
      user: switches.recall.user && rights.user,
      agentPrivate: switches.recall.agentPrivate && rights.agentPrivate,
    },
    // A capture is attributed to a person; without one there is nothing to attribute it to.
    capture: switches.capture && !!a.principal && a.principal.kind !== "agent",
  };
}
