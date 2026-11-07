import type { HarnessConfig, LearnSettings, LearnTargetConfig } from '@plur1bus/config-schema';
import { DEFAULT_LEARN_CONFIG, type LearnConfig, type Target } from './types.ts';
export function targetSettings(config: HarnessConfig, target: Target): LearnTargetConfig | undefined {
  const s = config.dreams?.learn;
  if (target.scope === 'installation') return s?.installation;
  const map = target.scope === 'agent' ? s?.agents : s?.projects;
  const key = target.projectId ?? target.agentId;
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}
export function learnConfig(config: HarnessConfig, target: Target): LearnConfig {
  const s = config.dreams?.learn ?? {}, t = targetSettings(config, target);
  return { ...DEFAULT_LEARN_CONFIG, windowDays: s.windowDays ?? 7, maxSessions: s.maxSessions ?? 50, maxTokens: s.maxTokens ?? 100_000,
    focus: t?.focus ?? '', enabled: t?.enabled === true && t.owner === target.owner && (target.scope === 'agent' || t.agentId === target.agentId) };
}
export function learnTargets(config: HarnessConfig): Target[] {
  const s: LearnSettings = config.dreams?.learn ?? {}, result: Target[] = [];
  for (const [agentId, t] of Object.entries(s.agents ?? {})) if (t.owner) result.push({ scope: 'agent', owner: t.owner, agentId });
  for (const [projectId, t] of Object.entries(s.projects ?? {})) if (t.owner && t.agentId) result.push({ scope: 'project', owner: t.owner, agentId: t.agentId, projectId });
  if (s.installation?.owner && s.installation.agentId) result.push({ scope: 'installation', owner: s.installation.owner, agentId: s.installation.agentId });
  return result;
}
