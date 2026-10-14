import { computed, signal } from "@preact/signals";
import { ALL_ITEMS, GALLERY_ENABLED, GALLERY_ITEM, HIDDEN_ITEMS, LANDING, type NavItem } from "./nav.ts";

export type Route =
  | { kind: "login" }
  | { kind: "join" }
  /** `sub` is the path after the first segment (`/memories/dreams` -> "dreams", `/chat/ses_1` -> "ses_1"), absent when empty. */
  | { kind: "page"; item: NavItem; sub?: string }
  | { kind: "not-found"; path: string };

/** Longest route path that is looked at; anything longer is not a route (a crafted link must not make every render carry megabytes). */
const MAX_PATH = 2048;

/** `s` percent-decoded; a malformed escape leaves it as it is instead of throwing. */
export function decodeSegment(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** One path segment of a route, encoded so a name with `?`, `#`, `%` or `/` stays one segment (`/skills/what%3F`). */
export const encodeSegment = (s: string): string => encodeURIComponent(s);

/** A route path from raw names: `routePath("skills", "a/b?")` -> `/skills/a%2Fb%3F`. Use it for every name that is not a fixed word. */
export function routePath(...segments: readonly string[]): string {
  return `/${segments.map(encodeSegment).join("/")}`;
}

/** The decoded segments of a `Route.page.sub`: `"a%2Fb/c"` -> `["a/b", "c"]`. `sub` itself stays encoded; this is the one decoder for pages
 * that have not decoded it themselves. `resolve` already refused malformed escapes, so decoding cannot throw here. */
export function subSegments(sub: string | undefined): string[] {
  return sub === undefined ? [] : sub.split("/").filter((seg) => seg !== "").map(decodeSegment);
}

/** Drops trailing slashes without a regex: `/\/+$/` is quadratic on a long run of slashes followed by anything else. */
function trimSlashes(p: string): string {
  let end = p.length;
  while (end > 0 && p.charCodeAt(end - 1) === 47) end--;
  return p.slice(0, end);
}

function currentPath(): string {
  const raw = globalThis.location?.hash ?? "";
  const p = raw.startsWith("#") ? raw.slice(1) : raw;
  const q = p.indexOf("?");
  const clean = trimSlashes(q < 0 ? p : p.slice(0, q));
  if (clean === "" && new URLSearchParams(globalThis.location?.search ?? "").has("code")) return "/join";
  return clean === "" ? "/" : clean;
}

/** The query of the current hash route (`#/settings/general?focus=core.logLevel` -> focus=core.logLevel); empty when there is none. */
function currentQuery(): URLSearchParams {
  const raw = globalThis.location?.hash ?? "";
  const i = raw.indexOf("?");
  return new URLSearchParams(i < 0 ? "" : raw.slice(i + 1));
}

/** Routes that moved: a deep link to the old path lands on its new home. `/identities` is the Identities tab of Settings > Users & roles. */
const MOVED: Readonly<Record<string, string>> = { identities: "/settings/users?tab=identities" };

/** Where `p` has moved to, or null. Any sub-path of a moved route goes to the same place. */
export function movedTo(p: string): string | null {
  const first = p.split("/").find((seg) => seg !== "") ?? "";
  return Object.hasOwn(MOVED, first) ? MOVED[first]! : null;
}

export const path = signal(currentPath());
/** Query of the current route; pages read `?focus=<key>`, `?trace=<id>` and the like from it. A new object on every route change. */
export const query = signal(currentQuery());

/** A segment that would walk out of the route (`.`/`..`, also percent-encoded) or whose escapes are malformed. */
function badSegment(seg: string): boolean {
  try {
    const d = decodeURIComponent(seg);
    return d === "." || d === "..";
  } catch { return true; }
}

/** `sub` keeps the segments as they are in the address (encoded); decode with `subSegments`. Dot segments and malformed escapes are not-found,
 * so a page that decodes `sub` itself cannot throw on it. */
export function resolve(p: string): Route {
  if (p.length > MAX_PATH) return { kind: "not-found", path: p.slice(0, MAX_PATH) };
  if (p === "/join" || p.startsWith("/invite/")) return { kind: "join" };
  if (p === "/login") return { kind: "login" };
  const segs = p.split("/").filter((seg) => seg !== "");
  if (segs.some(badSegment)) return { kind: "not-found", path: p };
  const [rawFirst = "", ...rest] = segs;
  const first = decodeSegment(rawFirst);
  const found = ALL_ITEMS.find((i) => i.path === `/${first}`) ?? HIDDEN_ITEMS.find((i) => i.path === `/${first}`) ?? (GALLERY_ENABLED && first === GALLERY_ITEM.id ? GALLERY_ITEM : undefined);
  if (found) return rest.length === 0 ? { kind: "page", item: found } : { kind: "page", item: found, sub: rest.join("/") };
  return { kind: "not-found", path: p };
}

export const route = computed<Route>(() => resolve(path.value === "/" ? LANDING : path.value));

/** Asked before the route changes: false keeps the person where they are. `to` is the target as `navigate` takes it (path and query). */
export type LeaveGuard = (to: string) => boolean;
const guards = new Set<LeaveGuard>();

/** Registers a guard for navigation through `navigate`, a link, the sidebar, the palette, the back button or an edited address; returns the
 * disposer (call it when the page unmounts). The first guard that says no stops the navigation; a guard that throws counts as yes. */
export function registerLeaveGuard(guard: LeaveGuard): () => void {
  const own: LeaveGuard = (to) => guard(to);
  guards.add(own);
  return () => { guards.delete(own); };
}

function allowed(to: string): boolean {
  for (const g of [...guards]) {
    try { if (!g(to)) return false; } catch { /* a broken guard must not trap the person on the page */ }
  }
  return true;
}

let unsavedWarn: ((e: Event) => void) | null = null;
const dirtyChecks = new Set<() => boolean>();

/** Convenience for a page with unsaved edits: while `isDirty()` is true, leaving asks with `message()` (the page's own text, in its language),
 * and closing or reloading the tab gets the browser's own warning. Returns the disposer. */
export function registerDirtyGuard(isDirty: (to: string) => boolean, message: () => string): () => void {
  const off = registerLeaveGuard((to) => {
    if (!isDirty(to)) return true;
    return typeof globalThis.confirm === "function" ? globalThis.confirm(message()) : true;
  });
  const check = (): boolean => isDirty("");
  dirtyChecks.add(check);
  if (unsavedWarn === null) {
    unsavedWarn = (e) => {
      if (![...dirtyChecks].some((c) => { try { return c(); } catch { return false; } })) return;
      e.preventDefault();
      (e as BeforeUnloadEvent).returnValue = "";
    };
    globalThis.addEventListener?.("beforeunload", unsavedWarn);
  }
  return () => {
    off();
    dirtyChecks.delete(check);
    if (dirtyChecks.size === 0 && unsavedWarn !== null) { globalThis.removeEventListener?.("beforeunload", unsavedWarn); unsavedWarn = null; }
  };
}

/** The hash the address bar showed after the last accepted navigation; a hashchange to anything else came from outside (link, back, typing). */
let committed = globalThis.location?.hash ?? "";

/** Goes to `to` (path and optional query). Returns false when a guard refused. `force` skips the guards: for redirects the app makes itself
 * (sign-in after an expired session), never for a person's own navigation. */
export function navigate(to: string, opts: { replace?: boolean; force?: boolean } = {}): boolean {
  if (opts.force !== true && !allowed(to)) return false;
  if (opts.replace) {
    globalThis.history.replaceState(null, "", `#${to}`);
    committed = globalThis.location?.hash ?? "";
    path.value = currentPath(); query.value = currentQuery();
  } else {
    globalThis.location.hash = to;
    committed = globalThis.location.hash;
  }
  return true;
}

/** Replaces a moved deep link in the address bar before anything renders it; true when it did. */
function redirectMoved(): boolean {
  const to = movedTo(currentPath());
  if (to === null || globalThis.history === undefined) return false;
  navigate(to, { replace: true, force: true });
  return true;
}

/** A hashchange nobody asked `navigate` for: ask the guards, and put the address bar back when one says no. */
function onHashChange(): void {
  const now = globalThis.location?.hash ?? "";
  if (now !== committed) {
    const to = now.startsWith("#") ? now.slice(1) : now;
    if (!allowed(to === "" ? "/" : to)) {
      // replaceState fires no hashchange, and the route signals never moved, so the page stays as it was.
      try { globalThis.history.replaceState(null, "", `${globalThis.location.pathname}${globalThis.location.search}${committed}`); } catch { /* keep the new address */ }
      if ((globalThis.location?.hash ?? "") === committed) return;
    }
  }
  if (redirectMoved()) return;
  committed = globalThis.location?.hash ?? "";
  path.value = currentPath(); query.value = currentQuery();
}

redirectMoved();
globalThis.addEventListener?.("hashchange", onHashChange);
