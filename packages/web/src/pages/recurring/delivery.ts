import { h } from 'preact';
import { useState } from 'preact/hooks';
import { getApi, useLoad } from '../common/load.ts';
import { Field } from '../common/field.ts';
import { t } from '../../i18n.ts';
import type { DeliveryTarget } from '../../../../core/src/delivery/service.ts';
import type { View } from '../../view.ts';
interface Identity {
    channel: string;
    accountId: string;
    userId: string;
}
declare module '../../api/index.ts' {
    interface RpcMethods {
        'delivery.target.list': {
            params: Record<string, never>;
            result: {
                targets: DeliveryTarget[];
                identities: Identity[];
            };
        };
        'delivery.target.add': {
            params: {
                identity: Identity;
            };
            result: DeliveryTarget;
        };
        'delivery.target.confirm': {
            params: {
                id: string;
            };
            result: {
                awaitingChannel: boolean;
            };
        };
        'delivery.target.remove': {
            params: {
                id: string;
            };
            result: {
                removed: boolean;
            };
        };
    }
}
export function DeliveryPanel(): View {
    const load = useLoad(async () => getApi().rpc('delivery.target.list', {}, { write: false }), []);
    const [selected, setSelected] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const action = async (fn: () => Promise<unknown>) => { if (busy)
        return; setBusy(true); setError(''); try {
        await fn();
        load.reload();
    }
    catch {
        setError(t('recurring.delivery.failed'));
    }
    finally {
        setBusy(false);
    } };
    return h('section', { 'aria-label': t('recurring.delivery.title') }, h('h2', null, t('recurring.delivery.title')), h('p', null, t('recurring.delivery.help')), load.state.status === 'ok' ? h('div', null, h(Field, { id: 'delivery-identity', label: t('recurring.delivery.identity') }, h('select', { id: 'delivery-identity', value: selected, onChange: (e: Event) => setSelected((e.target as HTMLSelectElement).value) }, h('option', { value: '' }, t('recurring.delivery.none')), load.state.data.identities.map((i, n) => h('option', { value: String(n), key: n }, `${i.channel} · ${i.userId}`)))), h('button', { class: 'btn', disabled: busy || selected === '', onClick: () => { const i = load.state.status === 'ok' ? load.state.data.identities[Number(selected)] : undefined; if (i)
            void action(() => getApi().rpc('delivery.target.add', { identity: i })); } }, t('recurring.delivery.add')), h('button', { class: 'btn', disabled: busy, onClick: load.reload }, t('recurring.delivery.refresh')), h('ul', null, load.state.data.targets.map(target => h('li', { key: target.id }, `${target.identity.channel} · ${target.identity.userId} · `, t(target.validated ? 'recurring.delivery.valid' : 'recurring.delivery.pending'), h('button', { class: 'btn', disabled: busy, onClick: () => void action(() => getApi().rpc('delivery.target.confirm', { id: target.id })) }, t('recurring.delivery.confirm')), h('button', { class: 'btn', disabled: busy, onClick: () => void action(() => getApi().rpc('delivery.target.remove', { id: target.id })) }, t('recurring.delivery.remove')))))) : h('p', null, t(load.state.status === 'fail' ? 'recurring.delivery.failed' : 'state.loading')), error ? h('p', { role: 'alert' }, error) : null);
}
export function DeliverySelect({ value, onChange }: {
    value: string;
    onChange: (id: string) => void;
}): View {
    const load = useLoad(async () => getApi().rpc('delivery.target.list', {}, { write: false }), []);
    return h(Field, { id: 'job-delivery', label: t('recurring.delivery.destination') }, h('select', { id: 'job-delivery', value, onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value) }, h('option', { value: '' }, t('recurring.delivery.none')), load.state.status === 'ok' ? load.state.data.targets.filter(t => t.validated).map(target => h('option', { key: target.id, value: target.id }, `${target.identity.channel} · ${target.identity.userId}`)) : null));
}
