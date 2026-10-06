import { computed, signal } from "@preact/signals";
import { ALL_ITEMS, LANDING, type NavItem } from "./nav.ts";

export type Route =
  | { kind: "login" }
  | { kind: "page"; item: NavItem }
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
  const found = ALL_ITEMS.find((i) => i.path === p);
  if (found) return { kind: "page", item: found };
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
