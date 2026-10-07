// Data plumbing shared by the pages: failure classification, a small load hook and the signed-in role. UI code never calls
// fetch; pages talk to `getApi()` (src/api/shared.ts). Moved here from the Memories page so the M3 part 2 pages use the same
// five states (loading, empty, error, forbidden, unavailable) and the same mapping of a rejected call onto them.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { sessionState } from "../../session.ts";

export { getApi } from "../../api/shared.ts";

export type FailureKind = "forbidden" | "unavailable" | "not-found" | "error";
export type Failure = { kind: FailureKind; message: string };

/** Maps whatever a call rejected with onto the five states of a page area. A JSON-RPC "method not found" (-32601) is the
 *  backend not having the method (yet): unavailable. */
export function failureOf(e: unknown): Failure {
  const o = typeof e === "object" && e !== null ? (e as { kind?: unknown; code?: unknown; errorCode?: unknown; message?: unknown }) : {};
  const message = typeof o.message === "string" ? o.message : "";
  if (o.kind === "forbidden") return { kind: "forbidden", message };
  if (o.kind === "unavailable") return { kind: "unavailable", message };
  if (o.kind === "rpc-error" && o.code === -32601) return { kind: "unavailable", message };
  if (o.kind === "rpc-error" && o.errorCode === "E_NOT_FOUND") return { kind: "not-found", message };
  return { kind: "error", message };
}

export type Loaded<T> = { status: "loading" } | { status: "ok"; data: T } | { status: "fail"; failure: Failure };

/** Runs `fn` on mount and whenever `deps` change (back to "loading"), and again on `reload()` or when `refresh` changes (the
 *  data stays visible meanwhile). A stale answer never overwrites a newer one; an aborted call is silent. */
export function useLoad<T>(fn: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], refresh = 0): { state: Loaded<T>; reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const lastDeps = useRef<readonly unknown[]>(deps);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const changed = lastDeps.current.length !== deps.length || lastDeps.current.some((d, i) => !Object.is(d, deps[i]));
    lastDeps.current = deps;
    const ctl = new AbortController();
    if (changed) setState({ status: "loading" });
    fnRef.current(ctl.signal).then(
      (data) => { if (!ctl.signal.aborted) setState({ status: "ok", data }); },
      (e: unknown) => { if (!ctl.signal.aborted && (e as { kind?: string }).kind !== "aborted") setState({ status: "fail", failure: failureOf(e) }); },
    );
    return () => { ctl.abort(); };
  }, [...deps, tick, refresh]);

  const reload = useCallback(() => { setTick((n) => n + 1); }, []);
  return { state, reload };
}

/** The signed-in principal's role (`owner` is the only one the API emits today), or undefined when not signed in. */
export function currentRole(): string | undefined {
  const s = sessionState.value;
  return s.status === "authenticated" ? s.user.role : undefined;
}

export const ROLE_PRESETS = ["owner", "admin", "operator", "member", "viewer"] as const;
export type RolePreset = (typeof ROLE_PRESETS)[number];

/** Whether a role may use something that docs/rbac.md grants to `roles`. A role this UI does not know is allowed to try: the
 *  server decides, and its refusal is shown as the forbidden state. An undefined role (not signed in) is allowed too for the same reason. */
export function roleIn(role: string | undefined, roles: readonly RolePreset[]): boolean {
  if (role === undefined || !(ROLE_PRESETS as readonly string[]).includes(role)) return true;
  return roles.includes(role as RolePreset);
}
