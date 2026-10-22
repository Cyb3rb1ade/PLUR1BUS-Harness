import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { View } from '../../../view.ts';
import { t } from '../../../i18n.ts';
import { sessionState } from '../../../session.ts';
import { getApi, useLoad } from '../../common/load.ts';
import { ConfigSection } from './config.ts';
import type { SectionProps } from '../page.ts';

type Status = { backend: string; installed: string[]; requests: number; failures: number; errorRate: number; p50Ms: number; p95Ms: number };
type Diagnostic = { ok: boolean; durationMs: number; outcome: string };
/** Session cookies identify people; Core and API still enforce the human-only settings guards. */
export function DecisionSection(props: SectionProps): View {
  const session = sessionState.value;
  const canEdit = session.status === 'authenticated' && ['owner', 'admin'].includes(session.user.role);
  return h('div', { class: 'cfg' },
    canEdit ? h(DecisionControls, props) : h('p', { class: 'form-notice' }, t('settings.decision.access')),
    h('section', { id: 'decision-evidence', 'aria-labelledby': 'decision-evidence-h', class: 'cfg-group' },
      h('h2', { id: 'decision-evidence-h' }, t('settings.decision.evidenceTitle')),
      h('p', { class: 'cfg-help' }, t('settings.decision.evidence'))));
}
function DecisionControls(props: SectionProps): View {
  const { state, reload } = useLoad(signal => getApi().rpc('decision.status', {}, { write: false, signal }) as Promise<Status>, []);
  const agents = useLoad(async signal => {
    const answer = await getApi().rpc('agent.list', {}, { write: false, signal }) as { agents?: { agentId?: unknown }[] };
    return (Array.isArray(answer?.agents) ? answer.agents : []).map(a => a?.agentId).filter((id): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)).sort()[0] ?? null;
  }, []);
  const target = agents.state.status === 'ok' ? agents.state.data : null;
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const test = async () => {
    const session = sessionState.value;
    if (session.status !== 'authenticated' || !['owner', 'admin'].includes(session.user.role) || active.current || !target) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setResult(null);
    try {
      const r = await getApi().rpc('decision.test', { agentId: target }, { signal: controller.signal }) as Diagnostic;
      if (controller.signal.aborted) return;
      setResult({ ok: r.ok === true, text: t(r.ok ? 'settings.decision.ok' : 'settings.decision.failed', { ms: Math.round(r.durationMs), outcome: r.outcome }) });
      reload();
    } catch { if (!controller.signal.aborted) setResult({ ok: false, text: t('settings.decision.refused') }); }
    finally { if (!controller.signal.aborted) { active.current = null; setBusy(false); } }
  };
  return h('div', null,
    h(ConfigSection, { ...props, section: { ...props.section, label: "settings.decision.configTitle" } }),
    h('section', { 'aria-labelledby': 'decision-status-h', class: 'cfg-group' },
      h('h2', { id: 'decision-status-h' }, t('settings.decision.statusTitle')),
      h('p', { id: 'decision-status', role: 'status', class: 'cfg-help' }, state.status === 'ok' ? t('settings.decision.status', { backend: state.data.backend, installed: state.data.installed.join(', '), requests: state.data.requests, failures: state.data.failures, errors: Math.round(state.data.errorRate * 100), p50: Math.round(state.data.p50Ms), p95: Math.round(state.data.p95Ms) }) : t(state.status === 'loading' ? 'state.loading' : 'settings.decision.unavailable')),
      h('p', { id: 'decision-test-hint', class: 'field-hint' }, t('settings.decision.testHint')),
      h('p', { class: 'field-hint', role: 'status' }, target ? t('settings.decision.target', { agent: target }) : t(agents.state.status === 'loading' ? 'state.loading' : agents.state.status === 'fail' ? 'settings.decision.agentsUnavailable' : 'settings.decision.noAgents')),
      h('div', { class: 'cfg-actions' },
        h('button', { type: 'button', class: 'btn', onClick: () => { reload(); agents.reload(); } }, t('settings.decision.refresh')),
        h('button', { id: 'decision-test', type: 'button', class: 'btn btn-primary', disabled: busy || !target, 'aria-describedby': 'decision-test-hint', onClick: () => { void test(); } }, t(busy ? 'settings.decision.running' : 'settings.decision.test'))),
      result ? h('p', { role: result.ok ? 'status' : 'alert', class: 'form-notice' }, result.text) : null));
}
