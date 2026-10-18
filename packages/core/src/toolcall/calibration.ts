import defaults from './calibration.defaults.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
import type { CapabilityStats } from './sqlite-registry.ts';
export interface CalibrationConfig { minOffers: number; maxBonus: number; maxPenalty: number; halfLifeDays: number; successTarget: number; successWeight: number; searchWeight: number }
/** File data, validated on load; callers may provide an installation-specific file without recompiling. */
export function loadCalibration(path?: string | URL): CalibrationConfig {
  const value = (path ? JSON.parse(readFileSync(path, 'utf8')) : structuredClone(defaults)) as CalibrationConfig;
  const fields: (keyof CalibrationConfig)[] = ['minOffers', 'maxBonus', 'maxPenalty', 'halfLifeDays', 'successTarget', 'successWeight', 'searchWeight'];
  if (!value || fields.some(k => !Number.isFinite(value[k]) || value[k] < 0) || value.minOffers < 1 || value.halfLifeDays <= 0 || value.maxBonus > 1 || value.maxPenalty > 1 || value.successTarget > 1 || Object.keys(value).some(k => !fields.includes(k as keyof CalibrationConfig))) throw Error('invalid capability calibration');
  return value;
}
/** A prior changes ranking only. Search and visibility never consume it. Counts may be time-decayed fractional values. */
export function usagePrior(agent: CapabilityStats, global: CapabilityStats, config: CalibrationConfig): number {
  const stats = agent.offered >= config.minOffers ? agent : global;
  if (stats.offered < config.minOffers) return 0;
  const success = stats.used ? (stats.succeeded + 1) / (stats.used + 2) : config.successTarget;
  const missed = Math.min(1, stats.foundBySearch / stats.offered);
  return Math.max(-config.maxPenalty, Math.min(config.maxBonus, config.successWeight * (success - config.successTarget) + config.searchWeight * missed));
}
