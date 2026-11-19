import type { ConfigActor } from "@plur1bus/module-api";
import type { Principal } from "./types.ts";

/**
 * For whom the core writes the configuration when it carries out somebody's request (P4D-39). The supervisor takes
 * the core for the local owner; without this a method the core opens to an admin would change the blocks that hold a
 * credential in the owner's name. Only a principal a resolver authenticated as a person carries their role: an agent,
 * or a principal of no stated kind, is judged as a viewer there. The supervisor records the write under this user.
 */
export function configActor(principal: Principal): ConfigActor {
  return { kind: "person", userId: principal.userId, role: principal.kind === "person" ? principal.role : "viewer" };
}
