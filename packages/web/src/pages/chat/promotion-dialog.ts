import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Dialog } from '../../components/dialog.ts';
import { t } from '../../i18n.ts';
import type { View } from '../../view.ts';
import { getChatApi } from './api.ts';
import type { SessionMessage } from './rpc-types.ts';
interface Target { kind: 'card' | 'project' | 'new_project'; projectId?: string; name?: string; title?: string }
interface Selection { kind: 'none' | 'summary' | 'selected' | 'transcript'; summary?: string; messageIds?: string[] }
interface Preview { previewId: string; content: string; target: Target; selection: string; expiresAt: number }
declare module '../../api/index.ts' {
  interface RpcMethods {
    'chat.promote.links': { params: { sessionId: string }; result: { links: { projectId: string; cardId: string | null; projectName: string }[] } };
    'chat.promote.preview': { params: { sessionId: string; target: Target; selection?: Selection }; result: Preview };
    'chat.promote.commit': { params: { previewId: string }; result: { projectId: string; cardId: string | null; selection: string; transferredMessages: number } };
  }
}
export function PromotionDialog({ sessionId, onClose }: { sessionId: string; onClose(): void }): View {
  const [links, setLinks] = useState<{ projectId: string; cardId: string | null; projectName: string }[]>([]);
  const [destination, setDestination] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]), [messages, setMessages] = useState<SessionMessage[]>([]);
  const [kind, setKind] = useState<Target['kind']>('project'), [projectId, setProjectId] = useState(''), [name, setName] = useState(''), [title, setTitle] = useState(t('chat.promotion.defaultTitle'));
  const [choice, setChoice] = useState<Selection['kind']>('none'), [summary, setSummary] = useState(''), [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(false), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const inflight = useRef(false);
  useEffect(() => {
    const ac = new AbortController(); const api = getChatApi();
    Promise.all([api.rpc('project.list', {}, { write: false, signal: ac.signal }), api.rpc('session.resume', { sessionId, limit: 500 }, { write: false, signal: ac.signal }), api.rpc('chat.promote.links', { sessionId }, { write: false, signal: ac.signal })]).then(([p, s, linked]) => { if (!ac.signal.aborted) { setProjects(p.projects); setLinks(linked.links); setMessages(s.messages.filter(m => m.role !== 'system')); setReady(true); } }).catch(() => { if (!ac.signal.aborted) setError(true); });
    return () => ac.abort();
  }, [sessionId]);
  const changed = () => { setPreview(null); setError(false); };
  const valid = ready && (kind === 'new_project' ? !!name.trim() : !!projectId) && (choice === 'summary' ? !!summary.trim() : choice !== 'selected' || selected.length > 0);
  const makePreview = async () => {
    if (inflight.current || !valid) return; inflight.current = true; setBusy(true); setError(false);
    const target: Target = { kind, ...(kind === 'new_project' ? { name } : { projectId }), title };
    const selection: Selection = { kind: choice, ...(choice === 'summary' ? { summary } : {}), ...(choice === 'selected' ? { messageIds: selected } : {}) };
    try { setPreview(await getChatApi().rpc('chat.promote.preview', { sessionId, target, selection }, { write: true })); }
    catch { setPreview(null); setError(true); } finally { inflight.current = false; setBusy(false); }
  };
  const commit = async () => {
    if (!preview || inflight.current) return; inflight.current = true; setBusy(true); setError(false);
    try { const result = await getChatApi().rpc('chat.promote.commit', { previewId: preview.previewId }, { write: true }); setDestination(result.projectId); setDone(true); setPreview(null); }
    catch { setError(true); } finally { inflight.current = false; setBusy(false); }
  };
  const select = (label: string, value: string, options: [string, string][], update: (v: string) => void) => h('label', { class: 'field' }, label, h('select', { 'aria-label': label, value, onChange: (e: Event) => { changed(); update((e.currentTarget as HTMLSelectElement).value); } }, options.map(([v, text]) => h('option', { value: v }, text))));
  return h(Dialog, { title: t('chat.promotion.title'), onClose, actions: done ? h('button', { class: 'btn', onClick: onClose }, t('dialog.close')) : h('div', {}, h('button', { class: 'btn', disabled: busy || !valid, onClick: makePreview }, t('chat.promotion.preview')), h('button', { class: 'btn btn-primary', disabled: busy || !preview, onClick: commit }, t('chat.promotion.confirm'))) },
    h('p', {}, t('chat.promotion.private')),
    links.length ? h('nav', { 'aria-label': t('chat.promotion.links') }, h('h3', {}, t('chat.promotion.links')), h('ul', {}, links.map((link, i) => h('li', { key: i }, h('a', { href: `#/projects/${encodeURIComponent(link.projectId)}` }, link.projectName))))) : null,
    error ? h('p', { role: 'alert' }, t('chat.promotion.error')) : null,
    done ? h('div', {}, h('p', { role: 'status' }, t('chat.promotion.done')), destination ? h('a', { href: `#/projects/${encodeURIComponent(destination)}` }, t('chat.promotion.openProject')) : null) : h('fieldset', { class: 'promotion-fields', disabled: busy },
      select(t('chat.promotion.destination'), kind, [['project', t('chat.promotion.link')], ['card', t('chat.promotion.card')], ['new_project', t('chat.promotion.newProject')]], v => setKind(v as Target['kind'])),
      kind === 'new_project' ? h('label', { class: 'field' }, t('chat.promotion.projectName'), h('input', { value: name, maxLength: 160, onInput: (e: Event) => { changed(); setName((e.currentTarget as HTMLInputElement).value); } })) : select(t('chat.promotion.project'), projectId, [['', t('chat.promotion.chooseProject')], ...projects.map(p => [p.id, p.name] as [string,string])], setProjectId),
      h('label', { class: 'field' }, t('chat.promotion.cardTitle'), h('input', { value: title, maxLength: 256, onInput: (e: Event) => { changed(); setTitle((e.currentTarget as HTMLInputElement).value); } })),
      select(t('chat.promotion.content'), choice, [['none', t('chat.promotion.none')], ['summary', t('chat.promotion.summary')], ['selected', t('chat.promotion.selected')], ['transcript', t('chat.promotion.transcript')]], v => setChoice(v as Selection['kind'])),
      choice === 'summary' ? h('label', { class: 'field' }, t('chat.promotion.summary'), h('textarea', { value: summary, maxLength: 65536, onInput: (e: Event) => { changed(); setSummary((e.currentTarget as HTMLTextAreaElement).value); } })) : null,
      choice === 'selected' ? h('div', { class: 'promotion-messages' }, messages.map(m => h('label', { class: 'promotion-message', key: m.id }, h('input', { type: 'checkbox', checked: selected.includes(m.id), onChange: () => { changed(); setSelected(selected.includes(m.id) ? selected.filter(id => id !== m.id) : [...selected, m.id]); } }), `${m.role}: ${m.text}`))) : null,
      preview ? h('section', { class: 'promotion-preview', 'aria-label': t('chat.promotion.preview') }, h('h3', {}, t('chat.promotion.preview')), h('p', {}, kind === 'new_project' ? name : projects.find(p => p.id === projectId)?.name), h('pre', { tabIndex: 0 }, preview.content || t('chat.promotion.noContent'))) : null));
}
