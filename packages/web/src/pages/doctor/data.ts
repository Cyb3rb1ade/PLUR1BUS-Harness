// Loads the three live parts of the Doctor page. Each part ends as its own `Part`, so one missing route or one refusal
// never blanks the rest. Only a lost session (401) rejects: the page then hands over to the sign-in flow.
import { API_ROUTES, isApiError, type Api } from "../../api/index.ts";
import "./rpc-types.ts";
import { parseAgents, parseCoreStatus, parseHealth, type Agent, type CoreStatus, type Health } from "./model.ts";

export type Part<T> = { kind: "ok"; value: T } | { kind: "unavailable" | "forbidden" | "error" } | { kind: "down"; body: T | null };
export type Snapshot = { health: Part<Health>; core: Part<CoreStatus>; agents: Part<Agent[]>; at: number };

export const HEALTH_ROUTE = `${API_ROUTES.rest}/health`;

async function part<T>(call: () => Promise<unknown>, parse: (v: unknown) => T | null, downOn503: boolean): Promise<Part<T>> {
  try {
    const v = parse(await call());
    return v === null ? { kind: "unavailable" } : { kind: "ok", value: v };
  } catch (e) {
    if (!isApiError(e)) return { kind: "error" };
    switch (e.kind) {
      case "unauthenticated": case "session-expired": case "aborted": throw e;
      case "forbidden": return { kind: "forbidden" };
      case "unavailable": return downOn503 && e.status === 503 ? { kind: "down", body: parse(e.body) } : { kind: "unavailable" };
      default: return { kind: "error" };
    }
  }
}

/** One round of checks. The health route answers 503 `status: down` when the core is unreachable: that is `down`, not
 *  "unavailable"; the body of that 503 (health/1) is kept, so the API version can still be shown. */
export async function loadSnapshot(api: Api, signal: AbortSignal): Promise<Snapshot> {
  const [health, core, agents] = await Promise.all([
    part(() => api.get(HEALTH_ROUTE, { signal }), parseHealth, true),
    part(() => api.rpc("core.status", undefined, { write: false, signal }), parseCoreStatus, false),
    part(() => api.get(API_ROUTES.agents, { signal }), parseAgents, false),
  ]);
  return { health, core, agents, at: Date.now() };
}
