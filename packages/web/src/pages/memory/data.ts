// Data plumbing of the Memories & Dreams page: the page's own API instance, failure classification, a small load hook and the
// role gate for dangerous actions. UI code never calls fetch.
import { signal } from "@preact/signals";
import { currentRole } from "../common/load.ts";

/** The shared API client (src/api/shared.ts); a session that ended signs the UI out. The generic pieces moved to ../common/load.ts. */
export { getApi, failureOf, useLoad, currentRole } from "../common/load.ts";
export type { Failure, FailureKind, Loaded } from "../common/load.ts";

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
