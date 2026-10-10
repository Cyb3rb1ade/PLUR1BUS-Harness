// Binds the switchboard host to the core's own services. `core.ts` calls this once; everything here is a thin adapter from a core
// service to the host's port, so the host itself stays testable without a core.
import { join } from "node:path";
import { OutputStore } from "../../../media/src/index.ts";
import type { AgentRegistry } from "../agents.ts";
import type { PermissionRuntime } from "../approvals/runtime.ts";
import type { IdentityService } from "../identity/service.ts";
import type { Layout } from "../paths.ts";
import { SecretError } from "../secrets/types.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { SessionService } from "../session/service.ts";
import { DEFAULT_BINDINGS } from "./bindings.ts";
import { systemClock, type Clock } from "./clock.ts";
import { createSwitchboard, type ChannelBinding, type ConfigPort, type SecretsPort, type Switchboard } from "./switchboard.ts";
import type { ChannelLogger } from "./types.ts";

export interface CoreHostDeps {
  layout: Layout;
  config: ConfigPort;
  secrets: SecretStore;
  identity: () => IdentityService | null;
  sessions: () => SessionService | null;
  agents: AgentRegistry;
  permissions: () => PermissionRuntime | null;
  clock?: () => number;
  log: ChannelLogger;
  /** Tests of the core wiring replace the real adapters. */
  bindings?: readonly ChannelBinding[];
  adapterDeps?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const LEASE = { purpose: "channel", profileId: "switchboard", ttlMs: 5_000 } as const;

/** Channel secrets are read as the core itself (`lease`, audited), never as the owner and never through `reveal`. */
export function channelSecrets(store: SecretStore): SecretsPort {
  const read = async (name: string): Promise<string | null> => {
    try {
      const lease = await store.lease({ kind: "core" }, name, LEASE);
      try { return lease.value; } finally { store.revokeLease({ kind: "core" }, lease.leaseId); }
    } catch (e) {
      if (e instanceof SecretError && (e.code === "not-found" || e.code === "invalid-name")) return null;
      throw e;
    }
  };
  return { read, has: async (name) => (await read(name)) !== null };
}

function agentIdOf(agents: AgentRegistry): string {
  const ids = agents.list();
  if (ids.length === 1) return ids[0]!; // D92 §6: a single agent is the agent
  if (ids.includes("main")) return "main";
  throw new Error("several agents are registered and none is named main; channel chats need a default agent");
}

export function openChannelSwitchboard(d: CoreHostDeps): Switchboard {
  const clock: Clock = d.clock ? { now: d.clock, setTimer: systemClock.setTimer } : systemClock;
  let outputs: OutputStore | null = null;
  return createSwitchboard({
    config: d.config,
    secrets: channelSecrets(d.secrets),
    identity: d.identity,
    turns: () => {
      const s = d.sessions();
      return s ? { store: s.store, runner: s.runner, agentId: () => agentIdOf(d.agents) } : null;
    },
    approvals: () => d.permissions()?.current()?.service ?? null,
    outputs: { store: () => (outputs ??= new OutputStore(join(d.layout.home, "media", "outputs"))) },
    clock,
    log: d.log,
    bindings: d.bindings ?? DEFAULT_BINDINGS,
    ...(d.adapterDeps ? { adapterDeps: d.adapterDeps } : {}),
    stateDir: join(d.layout.state, "channels"),
  });
}
