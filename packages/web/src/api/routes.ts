// Every path the typed API client talks to, in ONE place. Origin/main serves only the REST routes under `rest`
// (session, csrf, health, whoami, agents). `rpc` and `events` are the documented contract of docs/rpc.md and the
// direct-chat design (§6.4: notifications forwarded on SSE `/events`); until the Harness API serves them, the client
// maps their 404/405 to the `unavailable` failure. Changing a path when the backend settles it is a one-liner here.
export const API_ROUTES = {
  /** POST, one JSON-RPC 2.0 request per call, answered with one JSON-RPC response. */
  rpc: "/rpc",
  /** GET, `text/event-stream`; resumable with `Last-Event-ID`. */
  events: "/events",
  /** Prefix of the REST routes (docs/api-surface.md). */
  rest: "/api/v1",
  agents: "/api/v1/agents",
} as const;
