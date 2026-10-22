import { authenticatedPrincipal } from '../rbac/guard.ts';
import type { Handler } from '../rpc/server.ts';
import type { DeliveryTargets } from './service.ts';
export function deliveryMethods(service: () => DeliveryTargets | null): Record<string, Handler> {
    const get = () => { const s = service(); if (!s)
        throw new Error('delivery unavailable'); return s; };
    return {
        'delivery.target.list': async (_p, ctx) => ({ targets: get().list(authenticatedPrincipal(ctx)), identities: get().eligible(authenticatedPrincipal(ctx)) }),
        'delivery.target.add': async (p: any, ctx) => get().add(p.identity, authenticatedPrincipal(ctx)),
        'delivery.target.confirm': async (p: any, ctx) => get().challenge(p.id, authenticatedPrincipal(ctx)),
        'delivery.target.remove': async (p: any, ctx) => get().remove(p.id, authenticatedPrincipal(ctx)),
        'delivery.target.subscribe': async (p: any, ctx) => get().subscribe(p.id, p.source, p.job, p.agentId, authenticatedPrincipal(ctx)),
    };
}
