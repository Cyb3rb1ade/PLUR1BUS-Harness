import { authenticatedPrincipal } from '../rbac/guard.ts';
import type { Handler } from '../rpc/server.ts';
import type { ChannelHandoff } from './service.ts';
import { RpcError } from '../rpc/errors.ts';
export function handoffMethods(service: () => ChannelHandoff | null): Record<string, Handler> {
    const get = () => { const s = service(); if (!s)
        throw new RpcError('E_NOT_AVAILABLE', 'channel history unavailable'); return s; };
    return {
        'channel.history.list': async (_p, ctx) => get().list(authenticatedPrincipal(ctx).userId),
        'channel.history.get': async (p: any, ctx) => get().get(p.sessionId, authenticatedPrincipal(ctx).userId),
        'channel.handoff.create': async (p: any, ctx) => { const { token: _token, ...out } = get().issue(p.sessionId, authenticatedPrincipal(ctx).userId); return out; },
        'channel.handoff.redeem': async (p: any, ctx) => get().redeem(p.token, authenticatedPrincipal(ctx).userId),
    };
}
