// The engine side of the ADR-007 Q4 back-fill (docs/import.md §2.4, owner decision of 2026-10-05): `MetadataRebindPort`
// (backfill.ts) implemented on Engine.memory.rebind / unbind (engine contract 1.12.0). Additive: nothing in the identity
// service, the backfill or the recall scope changes. The engine moves the owner metadata of the user-scope cards of ONE
// channel identity to the harness user; it never copies card text, never rewrites a vector, never goes through /share and
// keeps its own sidecar of exactly the rows it touched, which is the receipt that makes the step reversible.
import type { AgentContext, Engine, Principal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { MetadataRebindPort } from "./backfill.ts";
import { deriveUserPrincipal } from "./principals.ts";
import type { IdentityService } from "./service.ts";
import { IdentityError } from "./store.ts";

/** What the engine needs to name a channel identity; resolved from the service's active link, never guessed. */
export interface RebindTarget { humanId: string; channel: string; accountId: string; userId: string }
export type RebindLookup = (v1Principal: string) => RebindTarget | null;

/** Finds the ACTIVE link behind a `user:v1:` principal. A removed link resolves to nothing, so it can never be back-filled. */
export function rebindLookupFromService(service: IdentityService): RebindLookup {
  return (v1Principal) => {
    for (const human of service.list({}).humans) {
      for (const link of human.identities) {
        if (link.revokedAt === null && link.v1Principal === v1Principal) return { humanId: link.humanId, channel: link.channel, accountId: link.accountId, userId: link.userId };
      }
    }
    return null;
  };
}

const SYSTEM: AgentContext = { origin: "system", background: false };

/** `agentId`: the agent whose store is back-filled (the engine rebinds per agent; call once per agent that holds person memories). */
export function createEngineRebindPort(o: { engine: Pick<Engine, "memory">; agentId: string; lookup: RebindLookup }): MetadataRebindPort {
  const operator: Principal = { agentId: o.agentId, channel: "cli", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" } as Principal;
  const guard = (e: unknown): never => {
    const code = (e as { code?: string } | null)?.code;
    if (code === "identity-already-bound") throw new IdentityError("conflict", "this channel identity is already bound to another user in the engine; unlink and relink instead");
    if (code === "invalid-input" || code === "denied") throw new IdentityError("invalid-params", `the engine refused the back-fill (${code})`);
    throw new IdentityError("storage", `the engine failed the back-fill${code ? ` (${code})` : ""}`);
  };
  return {
    async rebind(p) {
      const t = o.lookup(p.from);
      if (!t) throw new IdentityError("not-found", "no active link for this principal");
      if (deriveUserPrincipal(t.humanId) !== p.to) throw new IdentityError("conflict", "the target principal does not belong to the linked user");
      try {
        const r = await o.engine.memory.rebind(
          { agentId: o.agentId, fromIdentity: { channel: t.channel as never, identityKey: t.userId, accountId: t.accountId }, toUser: t.humanId, dryRun: p.dryRun },
          operator, SYSTEM,
        );
        return p.dryRun ? { count: r.matched } : { count: r.rebound, receipt: r.rebindId };
      } catch (e) { return guard(e); }
    },
    async reverse(p) {
      try {
        const r = await o.engine.memory.unbind({ rebindId: p.receipt, dryRun: p.dryRun }, operator, SYSTEM);
        return { count: p.dryRun ? r.matched : r.unbound };
      } catch (e) { return guard(e); }
    },
  };
}
