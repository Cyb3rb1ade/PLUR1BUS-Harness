// Single additive composition block, kept here so unrelated composition work does not conflict.
import { join } from 'node:path';
import type { HarnessConfig } from '@plur1bus/config-schema';
import type { createTurnProvider } from '../composition/provider.ts';
import { createSessionRoleProvider } from './role-routing.ts';
import { readOnlyCatalog } from './catalog.ts';
export function sessionRoleFactory(create: typeof createTurnProvider, config: HarnessConfig | (() => HarnessConfig)): typeof createTurnProvider {
  return options => {
    const read = () => typeof config === 'function' ? config() : config;
    let key = '', current: ReturnType<typeof createSessionRoleProvider>;
    const get = () => {
      const cfg = read(), next = JSON.stringify([cfg.modelRoles, cfg.session.compaction.summaryMaxTokens]);
      if (next !== key) {
        current = createSessionRoleProvider(create, { ...options, requireTriage: !!cfg.modelRoles.decision }, cfg.modelRoles, cfg.session.compaction.summaryMaxTokens);
        key = next;
      }
      return current!;
    };
    return { id: get().id, telemetry: get().telemetry,
      modelProfiles: () => get().modelProfiles?.() ?? [],
      contextModels: (text, profile) => get().contextModels?.(text, profile) ?? [],
      roleModels: role => get().roleModels?.(role) ?? [],
      stream: req => get().stream(req),
    };
  };
}
export function sessionMaintenance(home: string, config: HarnessConfig) {
  const compaction = config.session.compaction;
  return { compaction: { windowTokens: 8192, softRatio: compaction.softRatio, hardRatio: compaction.hardRatio, summaryMaxTokens: compaction.summaryMaxTokens, maxMessageTokens: compaction.maxMessageTokens, summarizer: compaction.summarizer }, prune: compaction.prune, catalog: readOnlyCatalog(join(home,'catalog','models.json')) };
}
