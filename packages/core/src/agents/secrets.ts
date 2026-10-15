// Required credentials are names in the target installation's provider/channel configuration, never imported values.
import type { HarnessConfig } from "@plur1bus/config-schema";
import { secretName } from "./import.ts";
export function agentRequiredSecrets(config: HarnessConfig, agent: HarnessConfig["agents"][string]): string[] {
  const names = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value)) {
      if (/(Secret|KeyRef|secret_ref|secretRef)$/.test(key) && secretName(v)) names.add(v);
      else if (typeof v === "object") visit(v);
    }
  };
  // Names come from config values: only own entries count ("toString", "constructor" are not channels or profiles).
  for (const name of agent.channels ?? []) if (Object.hasOwn(config.channels, name)) visit(config.channels[name as keyof HarnessConfig["channels"]]);
  const profile = agent.model && Object.hasOwn(config.modelProfiles, agent.model) ? config.modelProfiles[agent.model] : undefined;
  for (const model of [...(profile?.candidates.map(c => c.model) ?? []), ...(profile?.aggregator ? [profile.aggregator] : [])]) {
    const provider = model.slice(0, model.indexOf("/"));
    if (Object.hasOwn(config.providers, provider)) visit(config.providers[provider]);
  }
  return [...names].sort();
}
