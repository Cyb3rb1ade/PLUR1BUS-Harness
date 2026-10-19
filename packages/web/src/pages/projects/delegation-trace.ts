import { h } from 'preact';
import { useState } from 'preact/hooks';
import { t } from '../../i18n.ts';
import { getApi } from '../common/load.ts';
import type { View } from '../../view.ts';
export interface TraceSpan { spanId: string; parentSpanId: string | null; agentId: string; startedAt: number; endedAt: number | null; status: string; inputTokens: number; outputTokens: number; sessionId?: string }
export interface ProjectTrace { traceId: string; projectId: string; status: string; spans: TraceSpan[] }
export function traceForest(spans: TraceSpan[]): { span: TraceSpan; children: ReturnType<typeof traceForest> }[] {
  const known = new Set(spans.map(s => s.spanId));
  const walk = (parent: string | null, seen: Set<string>): ReturnType<typeof traceForest> => spans.filter(s => !seen.has(s.spanId) && (parent === null ? !s.parentSpanId || !known.has(s.parentSpanId) : s.parentSpanId === parent)).map(span => ({ span, children: walk(span.spanId, new Set([...seen, span.spanId])) }));
  return walk(null, new Set());
}
function Span({ span, trace }: { span: TraceSpan; trace: ProjectTrace }): View {
  const [replay, setReplay] = useState<string | null>(null), [failed, setFailed] = useState(false), [loading, setLoading] = useState(false);
  const load = async (e: Event) => {
    e.preventDefault(); setLoading(true); setFailed(false);
    try {
      const result = await getApi().rpc('collab.session.replay', { traceId: trace.traceId, spanId: span.spanId }, { write: false });
      setReplay(JSON.stringify(result, null, 2));
    } catch { setReplay(null); setFailed(true); }
    finally { setLoading(false); }
  };
  return h('div', { class: 'delegation-span' },
    h('strong', {}, `${span.agentId} · ${span.status}`),
    h('p', {}, `${t('projects.tokens')}: ${span.inputTokens + span.outputTokens} · ${t('projects.trace.duration' as any)}: ${span.endedAt === null ? '…' : Math.max(0, span.endedAt - span.startedAt)} ms`),
    span.sessionId ? h('a', { href: `#/projects/${encodeURIComponent(trace.projectId)}?trace=${encodeURIComponent(trace.traceId)}&span=${encodeURIComponent(span.spanId)}`, onClick: load, 'aria-busy': loading }, t('projects.trace.transcript' as any)) : null,
    failed ? h('p', { role: 'alert' }, t('projects.trace.unavailable' as any)) : null,
    replay !== null ? h('pre', { class: 'delegation-transcript', tabIndex: 0 }, replay) : null);
}
export function DelegationTrace({ trace }: { trace: ProjectTrace }): View {
  const render = (nodes: ReturnType<typeof traceForest>): View => h('ol', { class: 'trace-timeline' }, nodes.map(({ span, children }) => h('li', { key: span.spanId }, h(Span, { span, trace }), children.length ? render(children) : null)));
  return h('details', {}, h('summary', {}, `${trace.traceId} · ${trace.status}`), render(traceForest(trace.spans)));
}
