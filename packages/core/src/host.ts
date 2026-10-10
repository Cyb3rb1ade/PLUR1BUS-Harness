import { voiceEngineConfig } from "./voice/turn-profile.ts";
import type { EngineConfig, HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { AgentRegistry } from "./agents.ts";
import { journalBacklog } from "./journal.ts";
import { engineLoggerFrom, type HarnessLogger } from "./logger.ts";
import type { Layout } from "./paths.ts";
import { createPlatformCapabilities } from "./platform.ts";

export function createHarnessHost(o: { layout: Layout; logger: HarnessLogger; config: HarnessConfig; engineConfig: Record<string, unknown>; agents: AgentRegistry; events: (name: string, payload: unknown) => void; clock?: () => number;
  /** Set only under a supervisor (B7): the engine's config changes go to the supervisor's `config.set`. */
  mutateConfig?: (patch: Record<string, unknown>) => Promise<void>;
  /** When given, `mutateConfig` is offered only while it answers true (read at each access). */
  canMutateConfig?: () => boolean }): HostServices {
  const host: HostServices = {
    logger: engineLoggerFrom(o.logger.child({ src: "engine" })),
    stateDir: o.layout.state,
    configPath: () => o.layout.configPath,
    // routing, pathOverrides: absent on purpose (spec §6.3)
    // E4: read by engine.status() under its own 50 ms cap; a throw or a timeout there is `journal: null`.
    capabilities: { journalBacklog: () => journalBacklog(o.layout.journal) },
    workspaceDir: async (agentId) => o.agents.workspaceOf(agentId),
    config: () => voiceEngineConfig(o.engineConfig) as EngineConfig,
    events: { emit: (name, payload) => o.events(name, payload) },
    clock: o.clock ?? Date.now,
    platform: createPlatformCapabilities({ logger: o.logger }),
    runtime: null,
  };
  // Absent without a supervisor: nothing else owns config.json while the core runs on its own.
  const mutate = o.mutateConfig;
  if (mutate) {
    Object.defineProperty(host, "mutateConfig", { enumerable: true, get: () => (o.canMutateConfig?.() === false ? undefined : mutate) });
  }
  return host;
}
