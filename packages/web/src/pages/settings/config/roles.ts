// Catalog-backed role fields. Runtime config validation remains authoritative.
import type { Field } from './model.ts';
import { normalizeList } from '../../models/model.ts';
/** The roles that select a model. The schema also accepts `embedding` and `rerank`, but they select none: the memory engine takes its
 *  models from `engine.embedding` and `engine.reranker` (packages/core/src/engine-config.ts), shown read-only by engine.ts. */
export const MODEL_ROLES = ['chat', 'reasoning', 'capture', 'dream', 'decision', 'summarize'] as const;
export type ModelRole = typeof MODEL_ROLES[number];
export function roleFields(config: unknown, catalog: unknown): Field[] {
  const cfg = config as { modelRoles?: Record<string, string> } | null;
  const choices = normalizeList(catalog).models.filter(m => m.kind === 'chat' || m.kind === 'unknown').map(m => ({
    value: `${m.provider}/${m.id}`, label: `${m.displayName} (${m.provider})`, ...(m.status === 'unavailable' ? { disabled: 'unavailable' as const } : {}),
  }));
  return MODEL_ROLES.map(role => ({ key: `modelRoles.${role}`, kind: 'enum', value: cfg?.modelRoles?.[role], def: '',
    options: ['', ...choices.map(m => m.value)], choices, restartClass: 'live', readOnly: false }));
}
