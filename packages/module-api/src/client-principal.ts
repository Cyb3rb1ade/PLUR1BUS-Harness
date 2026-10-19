import type { CallContext } from './rpc-server.ts';
const clients = new WeakSet<CallContext>();
/** Server-established scoped IPC context; request JSON can never set it. */
export function bindClientContext(ctx: CallContext): void { clients.add(ctx); }
export function isClientContext(ctx: CallContext): boolean { return clients.has(ctx); }
