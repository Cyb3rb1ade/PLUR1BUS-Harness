import { h } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { View } from '../../view.ts';
import { t } from '../../i18n.ts';
import { getApi } from '../common/load.ts';

interface Verification { flowId?: string; emoji?: { symbol: string; description: string }[]; decimals?: number[]; done?: boolean; cancelled?: boolean }
export function MatrixCryptoPanel(): View {
  const [userId, setUser] = useState(''); const [deviceId, setDevice] = useState('');
  const [flowId, setFlow] = useState(''); const [view, setView] = useState<Verification>({});
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const lock = useRef(false);
  const act = async (action: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(false);
    try {
      const result = await getApi().rpc('channel.crypto', { id: 'matrix', action, userId, deviceId, ...(flowId ? { flowId } : {}), ...(action === 'confirm' ? { confirmed } : {}) }) as Verification;
      setView(result); setConfirmed(false); if (result.flowId) setFlow(result.flowId);
    } catch { setError(true); }
    finally { lock.current = false; setBusy(false); }
  };
  const field = (label: string, value: string, change: (value: string) => void) => h('label', null, label, h('input', { value, disabled: busy, onInput: (event: Event) => { change((event.currentTarget as HTMLInputElement).value); setConfirmed(false); setView({}); } }));
  return h('section', { class: 'card' }, h('h3', { class: 'card-title' }, t('switchboard.crypto.title')),
    h('p', { class: 'field-hint' }, t('switchboard.crypto.warning')),
    field(t('switchboard.crypto.user'), userId, setUser), field(t('switchboard.crypto.device'), deviceId, setDevice),
    field(t('switchboard.crypto.flow'), flowId, setFlow),
    h('div', { class: 'chip-row' }, ...(['start', 'accept', 'inspect', 'cancel'] as const).map(action => h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy || action !== 'start' && !flowId, onClick: () => void act(action) }, t(`switchboard.crypto.${action}`)))),
    view.emoji ? h('p', { 'aria-live': 'polite' }, view.emoji.map(emoji => `${emoji.symbol} ${emoji.description}`).join(' · ')) : null,
    view.decimals ? h('p', { 'aria-live': 'polite' }, view.decimals.join(' · ')) : null,
    view.done ? h('p', { role: 'status' }, t('switchboard.crypto.done')) : view.cancelled ? h('p', { role: 'status' }, t('switchboard.crypto.cancelled')) : null,
    view.emoji || view.decimals ? h('label', null, h('input', { type: 'checkbox', checked: confirmed, onChange: (event: Event) => setConfirmed((event.currentTarget as HTMLInputElement).checked) }), t('switchboard.crypto.compare')) : null,
    h('button', { type: 'button', class: 'btn', disabled: busy || !confirmed || view.done || view.cancelled, onClick: () => void act('confirm') }, t('switchboard.crypto.confirm')),
    error ? h('p', { role: 'alert' }, t('switchboard.crypto.failed')) : null);
}
