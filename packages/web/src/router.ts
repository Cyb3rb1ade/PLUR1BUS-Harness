import { computed, signal } from "@preact/signals";
import { ALL_ITEMS, GALLERY_ENABLED, GALLERY_ITEM, HIDDEN_ITEMS, LANDING, type NavItem } from "./nav.ts";

export type Route =
  | { kind: "login" }
  /** `sub` is the path after the first segment (`/memories/dreams` -> "dreams", `/chat/ses_1` -> "ses_1"), absent when empty. */
  | { kind: "page"; item: NavItem; sub?: string }
  | { kind: "not-found"; path: string };

function currentPath(): string {
  const raw = globalThis.location?.hash ?? "";
  const p = raw.startsWith("#") ? raw.slice(1) : raw;
  const clean = p.split("?")[0] ?? "";
  return clean === "" ? "/" : clean.replace(/\/+$/, "") || "/";
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

export function resolve(p: string): Route {
  if (p === "/login") return { kind: "login" };
  const [first = "", ...rest] = p.split("/").filter((seg) => seg !== "");
  const found = ALL_ITEMS.find((i) => i.path === `/${first}`) ?? HIDDEN_ITEMS.find((i) => i.path === `/${first}`) ?? (GALLERY_ENABLED && first === GALLERY_ITEM.id ? GALLERY_ITEM : undefined);
  if (found) return rest.length === 0 ? { kind: "page", item: found } : { kind: "page", item: found, sub: rest.join("/") };
  return { kind: "not-found", path: p };
}

export const route = computed<Route>(() => resolve(path.value === "/" ? LANDING : path.value));

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = `#${to}`;
  if (opts.replace) globalThis.history.replaceState(null, "", url);
  if (opts.replace) { path.value = to.split("?")[0] ?? to; query.value = currentQuery(); }
  else globalThis.location.hash = to;
}

/** Replaces a moved deep link in the address bar before anything renders it; true when it did. */
function redirectMoved(): boolean {
  const to = movedTo(currentPath());
  if (to === null || globalThis.history === undefined) return false;
  navigate(to, { replace: true });
  return true;
}

redirectMoved();
globalThis.addEventListener?.("hashchange", () => {
  if (redirectMoved()) return;
  path.value = currentPath(); query.value = currentQuery();
});
