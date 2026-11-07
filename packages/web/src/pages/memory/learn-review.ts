import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../i18n.ts';
import { PageState } from '../../components/page-state.ts';
import { Facts, FailureState, Panel } from './common.ts';
import { failureOf, getApi, useLoad, type Failure } from './data.ts';
import type { LearnRow, LearnTarget } from './learn-types.ts';
import type { View } from '../../view.ts';

function ReviewDetail({ id, refresh }: { id: string; refresh(): void }): View {
  const { state, reload } = useLoad(signal => getApi().rpc('dreams.learn.get', { id }, { write: false, signal }), [id]);
  const [action, setAction] = useState<'accepted' | 'rejected' | 'rollback' | null>(null);
  const [stale, setStale] = useState<'' | 'correct' | 'forget'>('');
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<Failure | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  if (state.status === 'loading') return h(PageState, { state: 'loading' });
  if (state.status === 'fail') return h(FailureState, { failure: state.failure, unavailable: t('memory.learn.unavailable'), onRetry: reload });
  const data = state.data, f = data.finding;
  const submit = async () => {
    if (pending.current || !action) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setFailure(null);
    try {
      if (action === 'rollback') await getApi().rpc('dreams.learn.rollback', { id }, { write: true, signal: controller.signal });
      else await getApi().rpc('dreams.learn.decide', { id, contentHash: data.contentHash, outcome: action, ...(stale ? { staleAction: stale } : {}) }, { write: true, signal: controller.signal });
      if (!controller.signal.aborted) { setAction(null); reload(); refresh(); }
    } catch (e) { if (!controller.signal.aborted) setFailure(failureOf(e)); }
    finally { pending.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  const blocked = busy || failure?.kind === 'forbidden' || (data.action !== null && data.action.state === 'started');
  return h('div', { class: 'm-stack' },
    h('p', { class: 'm-wrap' }, f.text),
    h(Facts, { rows: [[t('memory.learn.score'), String(f.score)], [t('memory.learn.tier'), f.desiredTier],
      [t('memory.learn.prevalence'), `${f.prevalence.sessions}/${f.prevalence.total} · ${f.prevalence.days}`],
      [t('memory.learn.skeptic'), t(`memory.learn.verdict.${f.skeptic}`)], [t('memory.learn.verify'), f.verify]] }),
    f.previousDecision ? h('p', {}, t('memory.learn.previous')) : null,
    h('details', {}, h('summary', {}, t('memory.learn.evidence')), data.evidence.map(e => h('section', { key: `${e.ref.sessionId}:${e.ref.sourceId}` },
      h('p', { class: 'm-muted' }, `${e.ref.sessionId} · ${e.ref.day} · ${e.ref.trust}`), h('pre', { class: 'm-pre' }, e.excerpt)))),
    data.action?.state === 'started' ? h('p', { role: 'status' }, t('memory.learn.uncertain')) : null,
    f.status === 'waiting-h3' ? h('p', { role: 'status' }, t('memory.learn.waiting')) : null,
    f.status === 'pending' && f.kind === 'knowledge' ? h('div', { class: 'm-stack' },
      f.change === 'stale' ? h('label', {}, t('memory.learn.stale'), h('select', { value: stale, onChange: (e: Event) => setStale((e.target as HTMLSelectElement).value as typeof stale) },
        h('option', { value: '' }, t('memory.learn.choose')), h('option', { value: 'correct' }, t('memory.learn.correct')), h('option', { value: 'forget' }, t('memory.learn.forget')))) : null,
      h('div', { class: 'm-row' },
        h('button', { class: 'btn', disabled: blocked || (f.change === 'stale' && !stale), onClick: () => setAction('accepted') }, t('memory.learn.accept')),
        h('button', { class: 'btn', disabled: blocked, onClick: () => setAction('rejected') }, t('memory.learn.reject')))) : null,
    data.action?.state === 'completed' && typeof data.action.receipt.runId === 'string' ? h('button', { class: 'btn', disabled: busy, onClick: () => setAction('rollback') }, t('memory.learn.rollback')) : null,
    action ? h('div', { class: 'm-stack' }, h('p', {}, t('memory.learn.confirm')),
      h('button', { class: 'btn', disabled: blocked, onClick: () => { void submit(); } }, t('memory.curation.confirm')),
      h('button', { class: 'btn', disabled: busy, onClick: () => setAction(null) }, t('memory.curation.cancel'))) : null,
    failure ? h(FailureState, { failure, unavailable: t('memory.learn.unavailable') }) : null);
}
function Finding({ row, refresh }: { row: LearnRow; refresh(): void }): View {
  const [open, setOpen] = useState(false);
  return h('details', { class: 'm-item', open, onToggle: (e: Event) => setOpen((e.target as HTMLDetailsElement).open) },
    h('summary', {}, `${t(`memory.learn.status.${row.status}`)} · ${row.desiredTier} · ${t(`memory.learn.verdict.${row.skeptic}`)} · ${row.id.slice(0, 12)}`),
    open ? h(ReviewDetail, { id: row.id, refresh }) : null);
}
export function LearnReview({ target, tick = 0 }: { target: LearnTarget; tick?: number }): View {
  const [refresh, setRefresh] = useState(0);
  const { state, reload } = useLoad(signal => getApi().rpc('dreams.learn.list', target, { write: false, signal }), [target.scope, target.agentId, target.projectId], tick + refresh);
  return h(Panel, { title: t('memory.learn.title') },
    h('p', {}, t('memory.learn.shadow')),
    state.status === 'loading' ? h(PageState, { state: 'loading' }) : state.status === 'fail'
      ? h(FailureState, { failure: state.failure, unavailable: t('memory.learn.unavailable'), onRetry: reload })
      : state.data.items.length ? state.data.items.map(row => h(Finding, { key: row.id, row, refresh: () => setRefresh(n => n + 1) })) : h('p', { role: 'status' }, t('memory.learn.empty')));
}
