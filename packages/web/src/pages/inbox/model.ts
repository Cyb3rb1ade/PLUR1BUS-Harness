// Pure logic of the inbox page: where an entry leads, how its title is translated, and how the list changes locally after an
// action. No DOM and no RPC here, so the tests can run it without a browser.
import { ALL_ITEMS, HIDDEN_ITEMS } from "../../nav.ts";
import { INBOX_KINDS, type InboxEntry, type InboxKind, type InboxParamValue } from "./rpc-types.ts";

const SEVERITIES: ReadonlySet<unknown> = new Set(["info", "warning", "critical"]);
const MAX_TIME = 8.64e15; // the range of a JavaScript Date; anything else cannot be shown as a time

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_TIME;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a value from `inbox.list` has the shape of an entry. The page draws only such entries: one that does not (an unusable
 *  time, a missing part, an unknown kind) is left out, and never takes the other entries down with it. */
export function isEntry(v: unknown): v is InboxEntry {
  if (!isRecord(v)) return false;
  if (typeof v.id !== "string" || v.id === "" || typeof v.titleKey !== "string") return false;
  if (!(INBOX_KINDS as readonly unknown[]).includes(v.kind) || !SEVERITIES.has(v.severity)) return false;
  if (!isRecord(v.params) || !Object.values(v.params).every((p) => typeof p === "string" || typeof p === "number" || typeof p === "boolean")) return false;
  if (!isTime(v.createdAt) || !(v.readAt === null || isTime(v.readAt))) return false;
  if (!(v.dismissedAt === null || isTime(v.dismissedAt))) return false;
  if (v.ref === null) return true;
  return isRecord(v.ref) && (v.ref.route === undefined || typeof v.ref.route === "string") && (v.ref.objectId === undefined || typeof v.ref.objectId === "string");
}

/** The entries of an answer that the page can draw, each id once (the first one wins). Not an array gives an empty list. */
export function usableEntries(raw: unknown): InboxEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: InboxEntry[] = [];
  for (const e of raw) { if (isEntry(e) && !seen.has(e.id)) { seen.add(e.id); out.push(e); } }
  return out;
}

/** Routes an entry may link to: every app route. A `ref.route` the UI does not know is dropped, never put into an href. */
const KNOWN_PATHS: ReadonlySet<string> = new Set([...ALL_ITEMS, ...HIDDEN_ITEMS].map((i) => i.path));

/** Routes whose detail view is addressed as `<route>/<objectId>` (docs/web-ui.md). The other routes are linked bare. */
const DETAIL_ROUTES: ReadonlySet<string> = new Set(["/approvals"]);

export type EntryLink = { href: string };

/** Where an entry leads, or null when there is nothing to link to (no route, an unknown route, or the inbox itself). */
export function linkFor(entry: InboxEntry): EntryLink | null {
  const route = entry.ref?.route;
  if (!route || route === "/inbox" || !KNOWN_PATHS.has(route)) return null;
  const id = entry.ref?.objectId;
  const path = id && DETAIL_ROUTES.has(route) ? `${route}/${encodeURIComponent(id)}` : route;
  return { href: `#${path}` };
}

/** Params as the translator wants them. `expiresAt` (and any other `*At` millisecond timestamp) is formatted, the rest is
 *  passed through as text. */
export function displayParams(params: Record<string, InboxParamValue>, formatTime: (ms: number) => string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "number" && /At$|expiresAt$/.test(k)) out[k] = formatTime(v);
    else out[k] = String(v);
  }
  return out;
}

/** Appends the next page to the list without showing an entry twice (a new entry can arrive between two pages). */
export function appendPage(list: readonly InboxEntry[], next: readonly InboxEntry[]): InboxEntry[] {
  const seen = new Set(list.map((e) => e.id));
  return [...list, ...next.filter((e) => !seen.has(e.id))];
}

/** The list after `inbox.markRead` (`ids`, or every entry for `all`). A read entry keeps its place in the list. */
export function markReadLocal(list: readonly InboxEntry[], ids: readonly string[] | "all", now: number): InboxEntry[] {
  const hit = ids === "all" ? null : new Set(ids);
  return list.map((e) => (e.readAt === null && (hit === null || hit.has(e.id)) ? { ...e, readAt: now } : e));
}

/** The list after `inbox.dismiss`: dismissed entries leave the list (the page never shows them). */
export function dismissLocal(list: readonly InboxEntry[], ids: readonly string[]): InboxEntry[] {
  const hit = new Set(ids);
  return list.filter((e) => !hit.has(e.id));
}

/** The kinds in the order the filter shows them. */
export const KIND_FILTERS: readonly InboxKind[] = INBOX_KINDS;

/** Whether an entry matches the current filter. `kinds` empty means every kind. */
export function matches(e: InboxEntry, filter: { kinds: readonly InboxKind[]; unreadOnly: boolean }): boolean {
  if (filter.kinds.length > 0 && !filter.kinds.includes(e.kind)) return false;
  return !filter.unreadOnly || e.readAt === null;
}
