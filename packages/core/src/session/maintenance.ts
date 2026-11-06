// Single additive composition block, kept here so unrelated composition work does not conflict.
import { DecisionClient } from '../decision/client.ts';
import { createRoleBackend } from '../decision/role.ts';
import type { DecisionOptions } from '../decision/types.ts';
import { join } from 'node:path';
import type { HarnessConfig } from '@plur1bus/config-schema';
import type { createTurnProvider } from '../composition/provider.ts';
import { createSessionRoleProvider } from './role-routing.ts';
import { readOnlyCatalog } from './catalog.ts';
import { CODING_INSTRUCTIONS, mergeCacheSummaries } from '../coding/profile.ts';
import { TOOL_USE_INSTRUCTIONS } from '../prompt/instructions.ts';
import type { ChatRequest } from './provider.ts';
export function sessionRoleFactory(create: typeof createTurnProvider, config: HarnessConfig | (() => HarnessConfig), hooks: { onClient?: (client: DecisionClient) => void; emit?: DecisionOptions['emit']; backends?: DecisionOptions['backends']; coding?: { enabled(req: ChatRequest): boolean; prepare(req: ChatRequest): Promise<ChatRequest> } } = {}): typeof createTurnProvider {
  return options => {
    const read = () => typeof config === 'function' ? config() : config;
    const decisions = new DecisionClient({ config: read, backends: { ...hooks.backends, role: createRoleBackend(create, options, read) }, ...(hooks.emit ? { emit: hooks.emit } : {}) });
    hooks.onClient?.(decisions);
    let key = '';
    const current = new Map<boolean, ReturnType<typeof createSessionRoleProvider>>();
    const get = (coding = false) => {
      const cfg = read(), next = JSON.stringify([cfg.modelRoles, cfg.session.compaction.summaryMaxTokens]);
      if (next !== key) {
        current.clear();
        key = next;
      }
      if (!current.has(coding)) current.set(coding, createSessionRoleProvider(create, { ...options,
        ...(coding ? { system: [...(options.system ?? [TOOL_USE_INSTRUCTIONS]), CODING_INSTRUCTIONS] } : {}),
        requireTriage: !!cfg.modelRoles.decision, triageTimeoutMs: () => Number(read().decision.timeoutMs ?? 2000) },
      cfg.modelRoles, cfg.session.compaction.summaryMaxTokens, decisions));
      return current.get(coding)!;
    };
    // A stable facade: the live provider is replaced when the role config changes, so telemetry must follow it.
    const telemetry: ReturnType<typeof createSessionRoleProvider>['telemetry'] = {
      record: (prompt, usage) => get().telemetry.record(prompt, usage),
      summary: (agentId, model, sessionId) => {
        get();
        return mergeCacheSummaries([...current.values()].map(p => p.telemetry.summary(agentId, model, sessionId)));
      },
      sessionModels: (agentId, sessionId) => {
        get();
        const models = new Map<string, import('../prompt/telemetry.ts').CacheUsageSummary[]>();
        for (const p of current.values()) for (const row of p.telemetry.sessionModels(agentId, sessionId)) {
          const values = models.get(row.model) ?? [];
          values.push(row.summary); models.set(row.model, values);
        }
        return [...models].sort(([a], [b]) => a.localeCompare(b)).map(([model, values]) => ({ model, summary: mergeCacheSummaries(values)! }));
      },
    };
    return { id: get().id, telemetry,
      modelProfiles: () => get().modelProfiles?.() ?? [],
      defaultModelProfile: agentId => get().defaultModelProfile?.(agentId) ?? options.profile ?? 'default',
      contextModels: (text, profile) => get().contextModels?.(text, profile) ?? [],
      roleModels: role => get().roleModels?.(role) ?? [],
      async *stream(req) {
        const prepared = hooks.coding ? await hooks.coding.prepare(req) : req;
        yield* get(hooks.coding?.enabled(prepared) === true).stream(prepared);
      },
    };
  };
}
export function sessionMaintenance(home: string, config: HarnessConfig) {
  const compaction = config.session.compaction;
  return { compaction: { windowTokens: 8192, softRatio: compaction.softRatio, hardRatio: compaction.hardRatio, summaryMaxTokens: compaction.summaryMaxTokens, maxMessageTokens: compaction.maxMessageTokens, summarizer: compaction.summarizer }, prune: compaction.prune, catalog: readOnlyCatalog(join(home,'catalog','models.json')) };
}
