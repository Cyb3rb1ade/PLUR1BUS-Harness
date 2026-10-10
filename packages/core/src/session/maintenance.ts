// Single additive composition block, kept here so unrelated composition work does not conflict.
import { join } from 'node:path';
import type { HarnessConfig } from '@plur1bus/config-schema';
import type { createTurnProvider } from '../composition/provider.ts';
import { createSessionRoleProvider } from './role-routing.ts';
import { readOnlyCatalog } from './catalog.ts';
export function sessionRoleFactory(create: typeof createTurnProvider, config: HarnessConfig): typeof createTurnProvider {
  return options => createSessionRoleProvider(create, options, config.modelRoles, config.session.compaction.summaryMaxTokens);
}
export function sessionMaintenance(home: string, config: HarnessConfig) {
  const compaction = config.session.compaction;
  return { compaction: { windowTokens: 8192, softRatio: compaction.softRatio, hardRatio: compaction.hardRatio, summaryMaxTokens: compaction.summaryMaxTokens, maxMessageTokens: compaction.maxMessageTokens, summarizer: compaction.summarizer }, prune: compaction.prune, catalog: readOnlyCatalog(join(home,'catalog','models.json')) };
}
