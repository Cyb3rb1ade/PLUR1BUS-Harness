// Session-authenticated JSON-RPC and person-bound SSE are served by the Harness API.
// Paths are shared by the real transport and the typed mock.
export const API_ROUTES = {
  /** POST, one JSON-RPC 2.0 request per call, answered with one JSON-RPC response. */
  rpc: "/rpc",
  /** GET, `text/event-stream`; resumable with `Last-Event-ID`. */
  events: "/events",
  /** Prefix of the REST routes (docs/api-surface.md). */
  rest: "/api/v1",
  agents: "/api/v1/agents",
} as const;
