import { SCHEMA, validateParams, validateResult } from '@plur1bus/rpc-schema';
import type { CoreRpc } from './core-rpc.ts';
import type { RouteSpec, Handler, HandlerInput } from './routes.ts';
import { errors, fromCoreError, ApiError } from './errors.ts';
import { inlineSchema } from './chat-routes.ts';
const defs = (SCHEMA as any).$defs.methods;
const routes = [['history.list', 'GET', '/api/v1/channel-dms', 'channel.history.list', 'read'], ['history.get', 'GET', '/api/v1/channel-dms/{sessionId}', 'channel.history.get', 'read'], ['handoff.create', 'POST', '/api/v1/channel-handoffs', 'channel.handoff.create', 'write'], ['handoff.redeem', 'POST', '/api/v1/channel-handoffs/redeem', 'channel.handoff.redeem', 'write']] as const;
export const CHANNEL_HANDOFF_ROUTES: readonly RouteSpec[] = routes.map(([name, method, path, rpc, permission]) => ({ id: `channel.${name}`, method, path, summary: 'Own channel DM continuation', tag: 'chats', auth: 'session', authz: { action: `chat:${permission}` }, csrf: method === 'POST', rate: method === 'POST' ? 'write' : 'read', stability: 'experimental', since: '1.0.0', ...(method === 'GET' ? { extra: {400: {description: 'Query parameters are refused.', schema: {$ref: '#/components/schemas/Error'}}} } : {}),
    successStatus: 200, success: { description: 'Authenticated own channel result; no channel writes.', schema: inlineSchema(defs[rpc].result) }, ...(method === 'POST' ? { requestBody: inlineSchema(defs[rpc].params) } : {}) }));
export function channelHandoffHandlers(core: CoreRpc): Record<string, Handler> {
    return Object.fromEntries(routes.map(([name, method, _path, rpc]) => [`channel.${name}`, async (i: HandlerInput) => {
            if (i.query?.size)
                throw errors.badRequest('query', 'channel queries are refused');
            const params = method === 'POST' ? i.body ?? {} : i.pathParams ?? {};
            if (!validateParams(rpc, params).ok)
                throw errors.badRequest('channel-params', 'invalid channel parameters');
            try {
                const body = await core.call<Record<string, unknown>>(rpc, params as object);
                if (!validateResult(rpc, body).ok)
                    throw new ApiError(502, 'E_CORE_UNAVAILABLE', 'invalid channel result');
                return { body };
            }
            catch (e) {
                throw fromCoreError(e);
            }
        }]));
}
