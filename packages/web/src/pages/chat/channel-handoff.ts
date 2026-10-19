import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useLoad, getApi } from '../common/load.ts';
import { t } from '../../i18n.ts';
import { navigate } from '../../router.ts';
import { refreshList } from './store.ts';
import type { View } from '../../view.ts';
import type { ChannelHistoryListResult, ChannelHistoryGetResult, ChannelHandoffCreateResult, ChannelHandoffRedeemResult } from '../../../../rpc-schema/generated/types.ts';
declare module '../../api/index.ts' {
    interface RpcMethods {
        'channel.history.list': {
            params: Record<string, never>;
            result: ChannelHistoryListResult;
        };
        'channel.history.get': {
            params: {
                sessionId: string;
            };
            result: ChannelHistoryGetResult;
        };
        'channel.handoff.create': {
            params: {
                sessionId: string;
            };
            result: ChannelHandoffCreateResult;
        };
        'channel.handoff.redeem': {
            params: {
                token: string;
            };
            result: ChannelHandoffRedeemResult;
        };
    }
}
export function ChannelHistory(): View {
    const load = useLoad(async (signal) => getApi().rpc('channel.history.list', {}, { write: false, signal }), []);
    if (load.state.status !== 'ok' || !load.state.data.sessions.length)
        return h('span', { hidden: true });
    return h('section', { 'aria-label': t('chat.channel.history') }, h('h2', null, t('chat.channel.history')), h('ul', { class: 'plain-list' }, load.state.data.sessions.map(s => h('li', { key: s.id }, h('a', { href: `#/chat/channel/${encodeURIComponent(s.id)}` }, `${s.channel} · ${s.title || s.channel} · `, t('chat.channel.readOnly'))))));
}
export function ChannelReadOnly({ sessionId }: {
    sessionId: string;
}): View {
    const load = useLoad(async (signal) => getApi().rpc('channel.history.get', { sessionId }, { write: false, signal }), [sessionId]);
    const [error, setError] = useState(false), [busy, setBusy] = useState(false);
    const locked = useRef(false);
    const proceed = async () => { if (locked.current)
        return; locked.current = true; setBusy(true); setError(false); try {
        const out = await getApi().rpc('channel.handoff.create', { sessionId });
        if (!/^#\/chat\/handoff\/[A-Za-z0-9_-]{43}$/.test(out.path))
            throw new Error();
        navigate(out.path.slice(1));
    }
    catch {
        locked.current = false;
        setBusy(false);
        setError(true);
    } };
    if (load.state.status !== 'ok')
        return h('p', { role: 'status' }, t(load.state.status === 'fail' ? 'chat.channel.failed' : 'state.loading'));
    return h('section', { 'aria-label': t('chat.channel.readOnly') }, h('h2', null, `${load.state.data.session.channel} · `, t('chat.channel.readOnly')), h('p', null, t('chat.channel.separate')), h('button', { class: 'btn btn-primary', disabled: busy, onClick: () => void proceed() }, t('chat.channel.continue')), error ? h('p', { role: 'alert' }, t('chat.channel.failed')) : null, h('ol', { class: 'plain-list' }, load.state.data.messages.map((m, n) => h('li', { key: n }, h('strong', null, m.role), h('p', { class: 'chat-channel-text' }, m.text)))));
}
export function HandoffArrival({ token }: {
    token: string;
}): View {
    const [error, setError] = useState(false);
    const attempted = useRef(false);
    useEffect(() => {
        if (attempted.current)
            return;
        attempted.current = true;
        // Tokens stay out of HTTP URLs and are removed from the visible browser history before POST.
        if (globalThis.location && globalThis.history)
            history.replaceState(null, '', location.pathname + location.search + '#/chat/handoff');
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
            setError(true);
            return;
        }
        void getApi().rpc('channel.handoff.redeem', { token }).then(out => { void refreshList(true); navigate(`/chat/${encodeURIComponent(out.sessionId)}`); }, () => setError(true));
    }, [token]);
    return h('section', { 'aria-label': t('chat.channel.continue') }, h('h2', null, t('chat.channel.continue')), h('p', { role: error ? 'alert' : 'status' }, t(error ? 'chat.channel.invalid' : 'chat.channel.opening')));
}
