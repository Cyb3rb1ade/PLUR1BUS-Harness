import { h } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { sessionState } from '../../session.ts';
import { t } from '../../i18n.ts';
import { getApi, currentRole, failureOf, useLoad, type Failure } from './data.ts';
import { Facts, FailureState, time } from './common.ts';
import type { View } from '../../view.ts';
import type { LearnTarget } from './learn-types.ts';
const gateKey = { 'shadow-incomplete': 'shadowIncomplete', 'precision-below-gate': 'precisionBelowGate', 'revert-unavailable': 'revertUnavailable' } as const;
type Settings = { enabled?: boolean; owner?: string; agentId?: string; focus?: string };
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function LearnControls({ target, refresh }: { target: LearnTarget; refresh(): void }): View {
  const state = sessionState.value, owner = state.status === 'authenticated' && currentRole() === 'owner' ? state.user.id : null;
  const [bump, setBump] = useState(0), [failure, setFailure] = useState<Failure | null>(null), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false);
  const sent = useRef(false);
  const loaded = useLoad(async signal => {
    const [status, calibration, config] = await Promise.all([
      getApi().rpc('dreams.learn.status', target, { write: false, signal }), getApi().rpc('dreams.learn.calibration', target, { write: false, signal }),
      owner ? getApi().rpc('config.get', { key: 'dreams.learn' }, { write: false, signal }) : Promise.resolve(null),
    ]);
    const values = object(config?.value), map = object(values[target.scope === 'agent' ? 'agents' : 'projects']);
    const setting = object(target.scope === 'installation' ? values.installation : map[target.projectId ?? target.agentId]) as Settings;
    return { status: status.status, calibration: calibration.record, setting, revision: config?.revision };
  }, [target.scope, target.agentId, target.projectId, owner], bump);
  if (loaded.state.status === 'loading') return h('p', { role: 'status' }, t('state.loading'));
  if (loaded.state.status === 'fail') return h(FailureState, { failure: loaded.state.failure, unavailable: t('memory.learn.unavailable'), onRetry: loaded.reload });
  const data = loaded.state.data;
  const editable = !!owner && (!data.setting.owner || data.setting.owner === owner);
  async function act(toggle: boolean): Promise<void> {
    if (sent.current || !editable) return;
    sent.current = true; setBusy(true); setFailure(null);
    try {
      if (toggle) {
        const id = target.projectId ?? target.agentId;
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || !data.revision) throw Error('invalid learning configuration');
        const key = target.scope === 'installation' ? 'dreams.learn.installation' : `dreams.learn.${target.scope === 'agent' ? 'agents' : 'projects'}.${id}`;
        await getApi().rpc('config.set', { changes: [{ key, value: { ...data.setting, owner, enabled: !data.setting.enabled, ...(target.scope !== 'agent' ? { agentId: target.agentId } : {}) } }], ifRevision: data.revision } as never, { write: true });
        setSaved(true);
      } else await getApi().rpc('dreams.learn.run', target, { write: true });
      setBump(n => n + 1); refresh();
    } catch (error) { setFailure(failureOf(error)); }
    finally { sent.current = false; setBusy(false); }
  }
  const targetLabel = target.scope === 'installation' ? t('memory.learn.installation') : target.projectId ?? target.agentId;
  return h('section', { class: 'm-stack', 'aria-label': `${t('memory.learn.settings')}: ${targetLabel}` },
    h('p', {}, t(target.scope === 'installation' ? 'memory.learn.metadataPrivacy' : 'memory.learn.privacy')),
    h(Facts, { rows: [[t('memory.learn.lastRun'), data.status.lastRun ? time(data.status.lastRun.startedAt) : t('memory.none')],
      [t('memory.learn.nextRun'), data.status.nextRunAt ? time(data.status.nextRunAt) : t('memory.none')]] }),
    editable ? h('div', { class: 'm-row' },
      h('button', { class: 'btn', disabled: busy, onClick: () => { void act(true); } }, t(data.setting.enabled ? 'memory.learn.disable' : 'memory.learn.enable')),
      h('button', { class: 'btn', disabled: busy || !data.status.enabled || data.status.breakerOpen, onClick: () => { void act(false); } }, t('memory.learn.runNow')))
      : h('p', { role: 'status' }, t('memory.learn.ownerOnly')),
    saved ? h('p', { role: 'status' }, t('memory.learn.saved')) : null,
    (['A', 'B'] as const).map(tier => { const p = data.calibration[tier]; return h('p', { key: tier },
      t('memory.learn.calibration', { tier, precision: p.precision === null ? '—' : `${Math.round(p.precision * 100)}%`, remaining: Math.max(0, 50 - p.decided) }), ' ', t(`memory.learn.gate.${gateKey[p.reason]}`)); }),
    data.calibration.predictions ? h('p', {}, t('memory.learn.confirmationRate', { rate: data.calibration.predictions.confirmationRate === null ? '—' : `${Math.round(data.calibration.predictions.confirmationRate * 100)}%` })) : null,
    failure ? h(FailureState, { failure, unavailable: t('memory.learn.unavailable') }) : null);
}
