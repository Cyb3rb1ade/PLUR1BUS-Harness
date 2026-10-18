// Catalog-backed role fields. Runtime config validation remains authoritative.
import type { Field } from './model.ts';
import { normalizeList } from '../../models/model.ts';
export const MODEL_ROLES = ['chat', 'reasoning', 'capture', 'dream', 'embedding', 'rerank', 'decision', 'summarize'] as const;
export type ModelRole = typeof MODEL_ROLES[number];
export function roleFields(config: unknown, catalog: unknown, licenceBlocked: readonly string[] = []): Field[] {
  const cfg = config as { modelRoles?: Record<string, string> } | null;
  const models = normalizeList(catalog).models;
  return MODEL_ROLES.map(role => {
    const kinds = role === 'embedding' || role === 'rerank' ? [role, 'unknown'] : ['chat', 'unknown'];
    const choices = models.filter(m => kinds.includes(m.kind)).map(m => ({
      value: role === "embedding" || role === "rerank" ? m.id : `${m.provider}/${m.id}`, label: `${m.displayName} (${m.provider})`,
      ...(m.status === 'unavailable' ? { disabled: 'unavailable' as const } : licenceBlocked.includes(m.id) ? { disabled: 'licenceRequired' as const } : {}),
    }));
    return { key: `modelRoles.${role}`, kind: 'enum', value: cfg?.modelRoles?.[role], def: '',
      options: ['', ...choices.map(m => m.value)], choices, restartClass: 'live', readOnly: false };
  });
}
