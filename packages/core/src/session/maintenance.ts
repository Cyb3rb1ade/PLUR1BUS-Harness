// Single additive composition block, kept here so unrelated composition work does not conflict.
import { DecisionClient } from '../decision/client.ts';
import { createRoleBackend } from '../decision/role.ts';
import type { DecisionOptions } from '../decision/types.ts';
import { join } from 'node:path';
import type { HarnessConfig } from '@plur1bus/config-schema';
import type { createTurnProvider } from '../composition/provider.ts';
import { createSessionRoleProvider } from './role-routing.ts';
import { readOnlyCatalog } from './catalog.ts';
export function sessionRoleFactory(create: typeof createTurnProvider, config: HarnessConfig | (() => HarnessConfig), hooks: { onClient?: (client: DecisionClient) => void; emit?: DecisionOptions['emit']; backends?: DecisionOptions['backends'] } = {}): typeof createTurnProvider {
  return options => {
    const read = () => typeof config === 'function' ? config() : config;
    const decisions = new DecisionClient({ config: read, backends: { ...hooks.backends, role: createRoleBackend(create, options, read) }, ...(hooks.emit ? { emit: hooks.emit } : {}) });
    hooks.onClient?.(decisions);
    let key = '', current: ReturnType<typeof createSessionRoleProvider>;
    const get = () => {
      const cfg = read(), next = JSON.stringify([cfg.modelRoles, cfg.session.compaction.summaryMaxTokens]);
      if (next !== key) {
        current = createSessionRoleProvider(create, { ...options, requireTriage: !!cfg.modelRoles.decision, triageTimeoutMs: () => Number(read().decision.timeoutMs ?? 2000) }, cfg.modelRoles, cfg.session.compaction.summaryMaxTokens, decisions);
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
