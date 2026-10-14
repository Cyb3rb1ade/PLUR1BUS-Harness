import { rpcRoute } from "./rpc-route.ts";
import { webPrincipal, webConnection } from "./principal.ts";
import type { CoreRpc } from "./core-rpc.ts";
import type { Handler } from "./routes.ts";
import type { RouteSpec } from "./routes.ts";
/** POSTs all need CSRF: the current RPC schema has no read/write annotation. */
export const TRANSPORT_ROUTES: readonly RouteSpec[] = [
  { id: "web.rpc", method: "POST", path: "/rpc", tag: "transport", summary: "One session-authenticated JSON-RPC request; Core RBAC applies", auth: "session", authz: "delegated", csrf: true, rate: "rpc", stability: "experimental", since: "1.0.0", requestBody: { type: "object", required: ["jsonrpc", "id", "method"], properties: { jsonrpc: { const: "2.0" }, id: { oneOf: [{ type: "integer" }, { type: "string" }] }, method: { type: "string" }, params: { type: "object" } } }, successStatus: 200, success: { description: "JSON-RPC response. Application errors retain error.data.error and use HTTP 200.", schema: { type: "object", required: ["jsonrpc", "id"], properties: { jsonrpc: { const: "2.0" }, id: { oneOf: [{ type: "integer" }, { type: "string" }, { type: "null" }] }, result: {}, error: { type: "object" } } } } },
  { id: "web.events", method: "GET", path: "/events", tag: "transport", summary: "Person-bound resumable SSE stream; Last-Event-ID; 25 second heartbeat", auth: "session", authz: "delegated", csrf: false, rate: "stream", stability: "experimental", since: "1.0.0", successStatus: 200, success: { description: "text/event-stream; restart event when cursor is stale; closes on logout or expiry.", schema: { type: "string" } }, extra: { 400: { description: "Query parameters are refused.", schema: { $ref: "#/components/schemas/Error" } }, 503: { description: "Core event feed unavailable.", schema: { $ref: "#/components/schemas/Error" } } } },
];

export function buildTransportHandlers(core: CoreRpc): Record<string, Handler> {
  return {
    "web.rpc": async i => ({ body: await rpcRoute(core, i.body, webPrincipal(i.rbac!, i.principal?.kind === "owner"), webConnection(i.session!)) }),
    "web.events": () => ({ body: {} }), // server hands this authenticated route to its streaming handler
  };
}
