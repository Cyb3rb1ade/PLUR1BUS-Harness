import { h } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { View } from '../../../view.ts';
import { Dialog } from '../../../components/dialog.ts';
import { Field } from '../../common/field.ts';
import { t } from '../../../i18n.ts';
import type { SaveResult } from './dialogs.ts';
/** Metadata only: this dialog has no credential input and never calls secret.get or secret.set. */
export function DescriptionDialog({ name, description, onSave, onClose }: { name: string; description: string; onSave: (text: string) => Promise<SaveResult>; onClose: () => void }): View {
  const [text, setText] = useState(description), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const saving = useRef(false);
  const save = async () => {
    if (saving.current) return; saving.current = true; setBusy(true); setError('');
    let result: SaveResult;
    try { result = await onSave(text.trim()); } catch { result = { ok: false, message: t('secrets.err.save') }; }
    if (result.ok) { onClose(); return; }
    saving.current = false; setBusy(false); setError(result.message);
  };
  return h(Dialog, { title: t('secrets.describe.title', { name }), onClose, actions: h('button', { type: 'button', class: 'btn btn-primary', disabled: busy, onClick: () => { void save(); } }, t('secrets.describe.save')) },
    h(Field, { id: 'secret-description-only', label: t('secrets.col.description'), hint: t('secrets.describe.hint') },
      h('input', { id: 'secret-description-only', type: 'text', value: text, maxLength: 200, disabled: busy, onInput: (event: Event) => setText((event.target as HTMLInputElement).value) })),
    error ? h('p', { role: 'alert', class: 'form-error' }, error) : null);
}
