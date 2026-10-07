import { computed, signal } from "@preact/signals";
import { ALL_ITEMS, GALLERY_ENABLED, GALLERY_ITEM, LANDING, type NavItem } from "./nav.ts";

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

export const path = signal(currentPath());

export function resolve(p: string): Route {
  if (p === "/login") return { kind: "login" };
  const [first = "", ...rest] = p.split("/").filter((seg) => seg !== "");
  const found = ALL_ITEMS.find((i) => i.path === `/${first}`) ?? (GALLERY_ENABLED && first === GALLERY_ITEM.id ? GALLERY_ITEM : undefined);
  if (found) return rest.length === 0 ? { kind: "page", item: found } : { kind: "page", item: found, sub: rest.join("/") };
  return { kind: "not-found", path: p };
}

export const route = computed<Route>(() => resolve(path.value === "/" ? LANDING : path.value));

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = `#${to}`;
  if (opts.replace) globalThis.history.replaceState(null, "", url);
  if (opts.replace) path.value = to;
  else globalThis.location.hash = to;
}

globalThis.addEventListener?.("hashchange", () => { path.value = currentPath(); });
