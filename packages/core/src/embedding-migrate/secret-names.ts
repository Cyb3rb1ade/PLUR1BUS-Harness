// The secret names the planned target of an embedding migration needs (P4D-29, ruling R-20-38).
//
// A migration to a cloud or self-hosted provider is a configuration that does not hold yet and needs credentials already:
// the engine probes the target's provider while it plans, and embeds every card with it before `engine.embedding` is
// switched. Its target therefore counts for the engine's secret names as an `engine.embedding` block that is there
// (`engineSecretNames`): the name the plan's parameters gave (`apiKeyEnv`), when it is a valid secret name, and the names
// the schema marks as the block's defaults. Nothing here writes a name down; both come from that one definition.
//
// When it counts: while the engine is asked for the plan, and from the plan on while the checkpoint says engine work is
// ahead (`planned` until its confirmation expires, `running`, `validating`, `ready-to-switch`). Not after an abort (a run
// that goes on counts again from its first batch), not after a failure, and not after the switch: from then on the
// configuration names what the engine may resolve. A local target names nothing.
import { engineSecretNames } from "../engine/secret-scope.ts";
import type { Checkpoint, Phase, StateStore } from "./state.ts";

/** The engine's own bound for a confirmation (driver.ts, `CONFIRMATION_TTL_MS`), for a checkpoint written before `expiresAt` was. */
const CONFIRMATION_TTL_MS = 60 * 60 * 1000;
/** The phases in which the engine has work ahead for the target. */
const UNDER_WAY: readonly Phase[] = ["planned", "running", "validating", "ready-to-switch"];
const NONE: ReadonlySet<string> = new Set();

export interface PlannedTargets {
  /** A plan the engine is asked for from now on: its target counts until the returned function is called (once the plan
   *  is in the checkpoint, or was refused). */
  planning(remote: { apiKeyEnv: string } | undefined): () => void;
  /** The names of the target that is planned or under way right now; empty without one. Never throws. */
  names(): ReadonlySet<string>;
}

/** The target of the checkpoint `c` while it counts at `now`, or null. */
export function plannedRemoteOf(c: Checkpoint | null, now: number): { apiKeyEnv: string } | null {
  if (!c?.remote || !UNDER_WAY.includes(c.phase)) return null;
  if (c.phase === "planned" && now >= (c.expiresAt ?? c.createdAt + CONFIRMATION_TTL_MS)) return null;
  return c.remote;
}

const namesOf = (remote: { apiKeyEnv: string }): ReadonlySet<string> => engineSecretNames({ engine: { embedding: { apiKeyEnv: remote.apiKeyEnv } } });

export function createPlannedTargets(d: { store: Pick<StateStore, "read">; now?: () => number }): PlannedTargets {
  const now = d.now ?? Date.now;
  const asked = new Set<{ apiKeyEnv: string }>();
  return {
    planning(remote) {
      if (!remote) return () => {};
      const held = { apiKeyEnv: remote.apiKeyEnv };
      asked.add(held);
      return () => { asked.delete(held); };
    },
    names() {
      try {
        const stored = plannedRemoteOf(d.store.read(), now());
        if (!stored && asked.size === 0) return NONE;
        const out = new Set<string>();
        for (const remote of [...asked, ...(stored ? [stored] : [])]) for (const name of namesOf(remote)) out.add(name);
        return out;
      } catch {
        // A checkpoint that cannot be read is no migration under way; a plan that is being asked for still counts.
        const out = new Set<string>();
        try { for (const remote of asked) for (const name of namesOf(remote)) out.add(name); } catch { return NONE; }
        return out;
      }
    },
  };
}
