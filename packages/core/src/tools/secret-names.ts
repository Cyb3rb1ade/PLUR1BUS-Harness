// secret_names: lets an agent learn which secret slots exist for IT, without searching and without ever seeing a value.
// Scope model (there is no per-secret ACL or agent lease): a secret is listed for an agent exactly when that agent's own
// configuration refers to it (a channel it serves, or a provider of its model profile) - the secrets the core leases on
// its behalf. The result holds names, scope, presence and the owner's description only: never a value, a length, a prefix or a hint of either.
// The owner's optional description (set with the secret) is shown next to a stored secret, so the agent can tell what a
// slot is for without asking. The agent is the dispatcher's `ctx.agentId`; the tool takes no arguments, so a caller cannot ask about another agent.
import { CAPABILITIES } from "../policy/index.ts";
import type { ToolDef } from "./registry.ts";

export const SECRET_NAMES_TOOL = "secret_names";

export interface SecretNameEntry { name: string; scope: string[]; present?: boolean; /** The owner's one-line note on what the secret is for; only for a stored secret that has one. */ description?: string }
export interface SecretNamesPort {
  /** Names and scope the given agent's configuration refers to; `present` says whether the store holds one (omitted when it cannot say), `description` is the owner's note when there is one. */
  namesFor(agentId: string): Promise<readonly SecretNameEntry[]>;
}

export function secretNamesTool(port: SecretNamesPort): ToolDef {
  return {
    name: SECRET_NAMES_TOOL,
    description: "List the names and scope of the secrets that are available to this agent (never their values). Use it to know which credentials exist before asking the owner for one.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    // D109: listing names leases nothing; the call declares the slot names it exposes and carries no value.
    capability: "secrets.use", effect: CAPABILITIES.get("secrets.use")!.intrinsicEffect, risk: "low", trust: "first-party",
    classify: () => ({ flags: { secretSlotDeclared: true }, access: "read" }),
    async execute(_args, ctx) {
      const entries = await port.namesFor(ctx.agentId);
      return { secrets: entries.map(e => ({ name: e.name, scope: [...e.scope], ...(e.present !== undefined ? { present: e.present } : {}), ...(e.description ? { description: e.description } : {}) })) };
    },
  };
}
