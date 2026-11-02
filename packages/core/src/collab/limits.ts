/** D124: resolve collaboration limits once, from schema defaults and narrowing project overrides. */
import { defaults, type CollaborationLimitsConfig, type CollaborationTaskClass } from '@plur1bus/config-schema';
import { CollabError } from './errors.ts';
import type { CollabSettings } from './types.ts';

export type TaskClass = CollaborationTaskClass;
export type CallClass = 'read' | 'write' | 'review';
export interface CollabLimits extends CollaborationLimitsConfig {
  returnTokens: number;
  allowCrossProject: boolean;
  repeatWindowMs: number;
  tokenBudget: number | null;
}

export const DEFAULT_COLLAB_LIMITS = defaults().collaboration.limits;

/** Invalid numbers never widen a bound; legacy project keys remain compatible with project.* RPC. */
export function resolveCollabLimits(config: CollaborationLimitsConfig = DEFAULT_COLLAB_LIMITS, project: Partial<CollabSettings> = {}): CollabLimits {
  const narrow = (value: number | undefined, maximum: number) =>
    Number.isFinite(value) && value! >= 0 ? Math.min(Math.floor(value!), maximum) : maximum;
  return {
    readHelpers: { perTurn: narrow(project.maxFanout, config.readHelpers.perTurn), depth: narrow(project.maxDepth, config.readHelpers.depth) },
    writers: { ...config.writers },
    consults: { perPairPerTurn: narrow(project.maxPairPerTurn, config.consults.perPairPerTurn) },
    workTokens: config.workTokens,
    taskClasses: Object.fromEntries(Object.entries(config.taskClasses).map(([name, limits]) => [name, {
      rounds: narrow(project.maxTurns, limits.rounds),
      wallTimeMs: narrow(project.timeoutMs, limits.wallTimeMs),
      stallTimeMs: Math.min(limits.stallTimeMs, narrow(project.timeoutMs, limits.wallTimeMs)),
    }])) as CollabLimits['taskClasses'],
    returnTokens: narrow(project.returnTokens, 2000),
    allowCrossProject: project.allowCrossProject === true,
    repeatWindowMs: typeof project.repeatWindowMs === 'number' && Number.isFinite(project.repeatWindowMs) && project.repeatWindowMs >= 0 ? project.repeatWindowMs : 30_000,
    tokenBudget: project.tokenBudget == null ? null : typeof project.tokenBudget === 'number' && Number.isFinite(project.tokenBudget) && project.tokenBudget >= 0 ? project.tokenBudget : 0,
  };
}

/** Compatibility projection for project.* RPC; execution uses the complete resolved task-class limits. */
export function legacyCollabSettings(limits: CollabLimits): CollabSettings {
  return {
    maxDepth: limits.readHelpers.depth, maxFanout: limits.readHelpers.perTurn,
    maxPairPerTurn: limits.consults.perPairPerTurn, maxTurns: limits.taskClasses.consult.rounds,
    timeoutMs: limits.taskClasses.consult.wallTimeMs, returnTokens: limits.returnTokens,
    allowCrossProject: limits.allowCrossProject, repeatWindowMs: limits.repeatWindowMs, tokenBudget: limits.tokenBudget,
  };
}

/** A trusted per-delegation budget shared by acceptance, work, retries and return repair. */
export interface DelegationWorkBudget {
  readonly limit: number;
  readonly used: number;
  reserve(tokens: number): { settle(actual: number): void; release(): void };
}

/** Reserve before a provider call, so concurrent nested calls cannot spend the same allocation twice. */
export function delegationWorkBudget(limit: number, parent?: DelegationWorkBudget): DelegationWorkBudget {
  let used = 0, reserved = 0;
  return {
    limit, get used() { return used; },
    reserve(tokens) {
      if (!Number.isSafeInteger(tokens) || tokens < 0 || used + reserved + tokens > limit) {
        throw new CollabError('guardrail', 'delegation work allocation exceeded', { guardrail: 'token-budget' });
      }
      const upstream = parent?.reserve(tokens);
      reserved += tokens;
      let active = true;
      return {
        settle(actual) { if (!active) return; active = false; reserved -= tokens; used += actual; upstream?.settle(actual); },
        release() { if (!active) return; active = false; reserved -= tokens; upstream?.release(); },
      };
    },
  };
}
