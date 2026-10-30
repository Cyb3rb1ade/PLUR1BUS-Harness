import type { HarnessConfig } from "@plur1bus/config-schema";
import { authorize } from "../rbac/authorize.ts";
import type { Principal } from "../rbac/types.ts";
import { channelSwitches } from "./config.ts";
import { NO_SCOPES, type Exposure, type ExposureChannel, type ScopeAccess } from "./types.ts";

/** Bound personal API tokens keep kind=agent for human-only RBAC, but Core verifies their backing person.
 *  True agents without a personal token id cannot acquire that person's user scope or capture attribution. */
function personBacked(principal: Principal, agentId: string): boolean {
  return principal.kind !== "agent" || !!(principal.tokenId && principal.binding?.agentId === agentId);
}

/** Capture writes must retain a current memory write grant, including any token action narrowing. */
function canCapture(principal: Principal, agentId: string): boolean {
  if (!personBacked(principal, agentId)) return false;
  const resources = [
    ["memory.workspace.write", { kind: "memory", scope: "workspace", agentId }],
    ["memory.user.write", { kind: "memory", scope: "user", ownerUserId: principal.userId }],
    ["memory.agent-private.write", { kind: "memory", scope: "agent-private", agentId }],
  ] as const;
  return resources.some(([action, resource]) => authorize(principal, action, resource).effect === "allow");
}

/** What the principal may read of the agent's memory, by the RBAC table (`memory.*.read`, ADR-007 "Privacy"): the user
 *  scope only its own, the workspace scope with at least `use` on the agent, the agent-private scope with `manage`. */
export function readRights(principal: Principal | null | undefined, agentId: string): ScopeAccess {
  if (!principal) return NO_SCOPES;
  const allowed = (action: string, resource: Parameters<typeof authorize>[2]) => authorize(principal, action, resource).effect === "allow";
  return {
    workspace: allowed("memory.workspace.read", { kind: "memory", scope: "workspace", agentId }),
    // A true agent has no user scope; a personal token remains narrowed by its explicit action scopes.
    user: personBacked(principal, agentId) && allowed("memory.user.read", {
      kind: "memory", scope: "user", ownerUserId: principal.userId,
    }),
    agentPrivate: allowed("memory.agent-private.read", { kind: "memory", scope: "agent-private", agentId }),
  };
}

/** The effective memory exposure of `agentId` on `channel` for the person (or agent) who asked: a scope is read only when
 *  the agent's switch is on and the principal holds the right. A switch can narrow, never widen. */
export function resolveExposure(a: { channel: ExposureChannel; agentId: string; principal: Principal | null | undefined; config: HarnessConfig }): Exposure {
  const switches = channelSwitches(a.config, a.agentId, a.channel);
  const rights = readRights(a.principal, a.agentId);

  const memOverride = a.principal?.binding?.memory;
  const groups = a.principal?.binding?.groups;
  const groupsAllowMemory = groups === undefined || groups.includes("memory");

  const discloseNever = memOverride?.disclose === "never";

  const effectiveWorkspace = groupsAllowMemory && !discloseNever && switches.recall.workspace && rights.workspace && (memOverride?.recall?.workspace ?? true);
  const effectiveUser = groupsAllowMemory && !discloseNever && switches.recall.user && rights.user && (memOverride?.recall?.user ?? true);
  const effectiveAgentPrivate = groupsAllowMemory && !discloseNever && switches.recall.agentPrivate && rights.agentPrivate && (memOverride?.recall?.agentPrivate ?? true);

  const effectiveCapture = groupsAllowMemory && switches.capture && !!a.principal
    && canCapture(a.principal, a.agentId) && (memOverride?.capture ?? true);

  return {
    channel: a.channel,
    agentId: a.agentId,
    switches,
    rights,
    recall: {
      workspace: effectiveWorkspace,
      user: effectiveUser,
      agentPrivate: effectiveAgentPrivate,
    },
    // A capture is attributed to a person; without one there is nothing to attribute it to.
    capture: effectiveCapture,
  };
}
