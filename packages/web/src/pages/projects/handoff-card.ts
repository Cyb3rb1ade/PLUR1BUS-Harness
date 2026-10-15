import { h } from 'preact';
import { t } from '../../i18n.ts';
import type { View } from '../../view.ts';
import { SafeMarkdown } from './markdown.ts';

/** Presentation only: peer data is escaped by Preact and can never add roles, grants or executable UI. */
export function handoffCardData(text: string): { schema: string; id: string; title: string; status: string; criteria: string[] } | null {
  if (text.length > 32768) return null;
  try {
    const v = JSON.parse(text);
    if (!v || !['plur1bus.handoff/1', 'plur1bus.return/1'].includes(v.schema) || typeof v.id !== 'string') return null;
    const title = v.schema === 'plur1bus.handoff/1' ? v.objective : v.summary;
    const status = v.schema === 'plur1bus.handoff/1' ? v.kind : v.status;
    if (typeof title !== 'string' || typeof status !== 'string') return null;
    const criteria = Array.isArray(v.doneWhen) ? v.doneWhen.flatMap((c: unknown) => typeof c === 'string' ? [c] : c && typeof c === 'object' && typeof (c as { criterion?: unknown }).criterion === 'string' ? [(c as { criterion: string }).criterion] : []) : [];
    return { schema: v.schema, id: v.id, title, status, criteria };
  } catch { return null; }
}
export function HandoffContent({ content, fallback }: { content: string; fallback?: string }): View {
  const card = handoffCardData(content);
  if (!card) return h(SafeMarkdown, { content, ...(fallback === undefined ? {} : { fallback }) });
  const key = `projects.handoff.status.${card.status}`;
  const translated = t(key as any);
  return h('article', { class: 'handoff-card', 'aria-label': t('projects.handoff.title' as any) },
    h('header', {}, h('strong', {}, t('projects.handoff.title' as any)), ' · ', h('span', {}, translated === key ? card.status : translated)),
    h('p', {}, card.title),
    card.criteria.length ? h('ul', {}, card.criteria.map((c, i) => h('li', { key: i }, c))) : null,
    h('small', {}, `${card.schema} · ${card.id}`),
    h('p', { class: 'meta-empty' }, t('projects.handoff.untrusted' as any)));
}
