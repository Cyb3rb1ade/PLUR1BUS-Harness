import defaults from './classes.defaults.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
export const MODEL_CLASSES = ['small', 'medium', 'large', 'frontier'] as const;
export type ModelClass = typeof MODEL_CLASSES[number];
export type ClassDistribution = Record<ModelClass, number>;
/** Profile labels, not live vendor model IDs. Deployment maps allowed profiles into these rows. */
export const CLASS_TABLE: Readonly<Record<string, Readonly<Partial<Record<ModelClass, string>>>>> = Object.freeze(Object.fromEntries(Object.entries(defaults).map(([family, row]) => [family, Object.freeze(row)])));
/** Read at a task boundary; a bad edit fails the decision safely rather than changing a running task. */
export function loadClassProfiles(path: string, fallback: Readonly<Record<string, string>> = {}): Readonly<Partial<Record<ModelClass, string>>> {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([k, v]) => !MODEL_CLASSES.includes(k as ModelClass) || typeof v !== 'string' || !v.trim() || v.length > 128)) throw Error('invalid class profile table');
  return value as Partial<Record<ModelClass, string>>;
}

export function resolveClass(modelClass: ModelClass, providers: readonly string[], allowedProfiles: ReadonlySet<string>): { provider: string; profile: string } | undefined {
  for (const provider of providers) { const profile = CLASS_TABLE[provider]?.[modelClass]; if (profile && allowedProfiles.has(`${provider}:${profile}`)) return { provider, profile }; } return undefined;
}
