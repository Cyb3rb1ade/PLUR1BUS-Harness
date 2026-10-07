// Data plumbing of the Memories & Dreams page: the page's own API instance, failure classification, a small load hook and the
// role gate for dangerous actions. UI code never calls fetch.
import { signal } from "@preact/signals";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { sessionNotice, sessionState } from "../../session.ts";

/** The shared API client (src/api/shared.ts); a session that ended signs the UI out. */
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

export function currentRole(): string | undefined {
  const s = sessionState.value;
  return s.status === "authenticated" ? s.user.role : undefined;
}

export type GuardedAction = "dreams.run" | "dreams.schedule";
// docs/rbac.md: dreams.run -> jobs.run (Owner, Admin, Operator); dreams.enable|disable|schedule.set -> settings.write (Owner, Admin).
const ROLES: Record<GuardedAction, readonly string[]> = { "dreams.run": ["owner", "admin", "operator"], "dreams.schedule": ["owner", "admin"] };
const KNOWN_ROLES = ["owner", "admin", "operator", "member", "viewer"];

/** Whether the role may do it. A role this UI does not know is allowed to try: the server decides, and its refusal disables the action. */
export function roleAllows(role: string | undefined, action: GuardedAction): boolean {
  if (role === undefined || !KNOWN_ROLES.includes(role)) return true;
  return ROLES[action].includes(role);
}

/** Actions the server has refused in this page session (E_DENIED): disabled from then on, with the explanation shown. */
export const refused = signal<ReadonlySet<GuardedAction>>(new Set());
export function markRefused(a: GuardedAction): void { refused.value = new Set([...refused.value, a]); }
export function allowed(a: GuardedAction): boolean { return roleAllows(currentRole(), a) && !refused.value.has(a); }
