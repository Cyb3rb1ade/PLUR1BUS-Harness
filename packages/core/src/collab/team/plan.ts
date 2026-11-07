/** D124 plan contracts: shape from RPC schema; references and byte-safe D104 bounds here. */
import { createHash } from 'node:crypto';
import { validateDefinition, type TeamPlan, type TeamScope } from '@plur1bus/rpc-schema';
import { HANDOFF_TOKEN_CAP, handoffTokenBound } from '../handoff.ts';
import { CollabError } from '../errors.ts';

export function teamHash(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)]));
    if (typeof v === 'number' && !Number.isFinite(v)) throw new CollabError('invalid', 'non-finite team fact');
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function assertTeamPlan(value: unknown): asserts value is TeamPlan {
  const schema = validateDefinition('TeamPlan', value);
  const fail = (reason: string): never => { throw new CollabError('invalid', 'invalid team plan', { reason }); };
  if (!schema.ok) fail('team-plan-schema');
  const plan = value as TeamPlan;
  const sections = new Map(plan.sections.map((s, i) => [s.key, i]));
  const packages = new Map(plan.packages.map(p => [p.key, p]));
  if (sections.size !== plan.sections.length || packages.size !== plan.packages.length) fail('team-plan-duplicate');
  if (plan.targetBranch.startsWith('-') || /[\s~^:?*\[\\]|\.\.|@\{|\/$|\.lock$/.test(plan.targetBranch)) fail('team-target-branch');
  for (const key of ['tokens', 'wallTimeMs'] as const) if (!Number.isSafeInteger(plan.sections.reduce((n, s) => n + s.budget[key], 0))) fail('team-budget-overflow');
  for (const section of plan.sections) {
    const keys = plan.packages.filter(p => p.section === section.key).map(p => p.key).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...section.mergeOrder].sort())) fail('team-plan-merge-order');
  }
  for (const pkg of plan.packages) {
    if (!sections.has(pkg.section)) fail('team-plan-section');
    if (handoffTokenBound(JSON.stringify(pkg)) > HANDOFF_TOKEN_CAP) fail('team-plan-brief-limit');
    if (new Set(pkg.dependsOn.map(d => d.package)).size !== pkg.dependsOn.length) fail('team-plan-duplicate-dependency');
    for (const dep of pkg.dependsOn) {
      const other = packages.get(dep.package);
      if (!other) fail('team-plan-dependency');
      if (sections.get(other!.section)! > sections.get(pkg.section)!) fail('team-plan-later-section');
    }
    for (const check of pkg.checks) if (check.criterion >= pkg.doneWhen.length) fail('team-plan-criterion');
    const globs = [...pkg.owns.map(o => o.glob), ...pkg.checks.flatMap(c => c.kind === 'paths' ? c.paths : [])];
    if (globs.some(g => g.split('/').some(s => s === '.' || s === '..'))) fail('team-plan-path');
  }
}

export function scopePackages(plan: TeamPlan, scope: TeamScope): string[] {
  if (scope.kind === 'plan' || scope.kind === 'auto') return plan.packages.map(p => p.key);
  if (scope.kind === 'package') return plan.packages.some(p => p.key === scope.package) ? [scope.package] : [];
  if (scope.kind !== 'section') return [];
  const index = plan.sections.findIndex(s => s.key === scope.through);
  return index < 0 ? [] : plan.packages.filter(p => plan.sections.findIndex(s => s.key === p.section) <= index).map(p => p.key);
}
