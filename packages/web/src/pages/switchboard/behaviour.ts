import { h } from 'preact';
import { useState } from 'preact/hooks';
import type { View } from '../../view.ts';
import { t } from '../../i18n.ts';
import { getApi } from '../common/load.ts';

export interface BehaviourView {
  agentId: string; editableKey: string; layer: Record<string, unknown>;
  direct: { profile: Record<string, Record<string, unknown>>; origins: Record<string, string[]> };
  group: { profile: Record<string, Record<string, unknown>>; origins: Record<string, string[]> };
}
export function BehaviourPanel({ data, reload }: { data: BehaviourView; reload(): void }): View {
  const [kind, setKind] = useState<'direct' | 'group'>('group');
  const [draft, setDraft] = useState(JSON.stringify(data.layer, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const effective = data[kind];
  const save = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const value: unknown = JSON.parse(draft);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('switchboard.behaviour.object'));
      const api = getApi();
      const current = await api.rpc('config.get', { key: data.editableKey }, { write: false }) as { revision?: string; value?: unknown };
      if (JSON.stringify(current.value ?? {}) !== JSON.stringify(data.layer)) throw new Error('changed');
      await api.rpc('config.set', { changes: [{ key: data.editableKey, value }], ...(current.revision ? { ifRevision: current.revision } : {}) });
      reload();
    } catch { setError(t('switchboard.behaviour.failed')); }
    finally { setBusy(false); }
  };
  return h('section', { class: 'card' },
    h('h3', { class: 'card-title' }, t('switchboard.behaviour.title')),
    h('p', null, t('switchboard.behaviour.agent', { agent: data.agentId })),
    h('label', null, t('switchboard.behaviour.kind'), h('select', { value: kind, onChange: (event: Event) => setKind((event.currentTarget as HTMLSelectElement).value as 'direct' | 'group') },
      h('option', { value: 'direct' }, t('switchboard.behaviour.direct')), h('option', { value: 'group' }, t('switchboard.behaviour.group')))),
    h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('switchboard.behaviour.field')), h('th', { scope: 'col' }, t('switchboard.behaviour.value')), h('th', { scope: 'col' }, t('switchboard.behaviour.origins')))),
      h('tbody', null, Object.entries(effective.profile).flatMap(([section, fields]) => Object.entries(fields).map(([field, value]) => {
        const key = `${section}.${field}`;
        return h('tr', { key }, h('th', { scope: 'row' }, key), h('td', null, JSON.stringify(value)), h('td', null, (effective.origins[key] ?? []).join(' → ')));
      })))),
    h('p', { class: 'field-hint' }, t('switchboard.behaviour.editHint')),
    h('label', null, t('switchboard.behaviour.layer'), h('textarea', { value: draft, rows: 8, spellcheck: false, onInput: (event: Event) => setDraft((event.currentTarget as HTMLTextAreaElement).value) })),
    error ? h('p', { role: 'alert' }, error) : null,
    h('button', { type: 'button', class: 'btn', disabled: busy, onClick: () => void save() }, t('switchboard.action.save')));
}
