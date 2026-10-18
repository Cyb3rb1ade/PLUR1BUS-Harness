// Required credentials are names in the target installation's provider/channel configuration, never imported values.
import type { HarnessConfig } from "@plur1bus/config-schema";
import { secretName } from "./import.ts";
/** A secret name an agent's configuration refers to, and where: `channel:<name>` or `provider:<name>`. */
export interface AgentSecretRef { name: string; scope: string[] }
export function agentSecretRefs(config: HarnessConfig, agent: HarnessConfig["agents"][string]): AgentSecretRef[] {
  const found = new Map<string, Set<string>>();
  const visit = (value: unknown, scope: string) => {
    if (!value || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value)) {
      if (/(Secret|KeyRef|secret_ref|secretRef)$/.test(key) && secretName(v)) { const at = found.get(v) ?? new Set<string>(); at.add(scope); found.set(v, at); }
      else if (typeof v === "object") visit(v, scope);
    }
  };
  // Names come from config values: only own entries count ("toString", "constructor" are not channels or profiles).
  for (const name of agent.channels ?? []) if (Object.hasOwn(config.channels, name)) visit(config.channels[name as keyof HarnessConfig["channels"]], `channel:${name}`);
  const profile = agent.model && Object.hasOwn(config.modelProfiles, agent.model) ? config.modelProfiles[agent.model] : undefined;
  for (const model of [...(profile?.candidates.map(c => c.model) ?? []), ...(profile?.aggregator ? [profile.aggregator] : [])]) {
    const provider = model.slice(0, model.indexOf("/"));
    if (Object.hasOwn(config.providers, provider)) visit(config.providers[provider], `provider:${provider}`);
  }
  return [...found].map(([name, scope]) => ({ name, scope: [...scope].sort() })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
export function agentRequiredSecrets(config: HarnessConfig, agent: HarnessConfig["agents"][string]): string[] {
  return agentSecretRefs(config, agent).map(r => r.name);
}
