import { effect } from "@preact/signals";
import { h } from "preact";
import type { View } from "./view.ts";
import { useLayoutEffect, useRef } from "preact/hooks";
import { HeaderActions } from "./components/controls.ts";
import { closeMenu, menuOpen, Sidebar } from "./components/sidebar.ts";
import { lang, t } from "./i18n.ts";
import { ALL_ITEMS, LANDING } from "./nav.ts";
import { LoginPage } from "./pages/login.ts";
import { NotFoundPage } from "./pages/not-found.ts";
import { PlaceholderPage } from "./pages/placeholder.ts";
import { navigate, path, route, type Route } from "./router.ts";
import { sessionState } from "./session.ts";

let returnTo: string | null = null;

/** Auth gate and document-level effects. Returns a disposer. */
export function bindApp(): () => void {
  const stops = [
    effect(() => {
      const s = sessionState.value;
      const r = route.value;
      if (s.status === "checking") return;
      if (s.status === "anonymous" && r.kind !== "login") {
        const p = path.value;
        returnTo = ALL_ITEMS.some((i) => i.path === p) ? p : null;
        navigate("/login", { replace: true });
      } else if (s.status === "authenticated" && r.kind === "login") {
        const to = returnTo ?? LANDING;
        returnTo = null;
        navigate(to, { replace: true });
      }
    }),
    effect(() => { document.documentElement.lang = lang.value; }),
    effect(() => {
      const r = route.value;
      const name = r.kind === "page" ? t(r.item.label) : r.kind === "login" ? t("login.title") : t("notfound.title");
      document.title = `${name} · PLUR1BUS`;
    }),
  ];
  return () => stops.forEach((s) => s());
}

function Page({ r }: { r: Route }): View {
  if (r.kind === "page") return h(PlaceholderPage, { item: r.item });
  return h(NotFoundPage, {});
}

function Shell({ r }: { r: Route }): View {
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  const key = r.kind === "page" ? r.item.id : r.kind;
  // Move focus to the page heading on navigation (not on first load), so keyboard and screen-reader users land on the new page.
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    main.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [key]);

  return h("div", { class: "app", "data-menu": menuOpen.value ? "open" : "closed" },
    // A real in-page link so assistive tech and axe treat it as a skip link; the hash router must not see it, hence preventDefault.
    h("a", { href: "#main", class: "skip-link", onClick: (e: Event) => { e.preventDefault(); main.current?.querySelector<HTMLElement>("h1")?.focus(); } }, t("app.skip")),
    h(Sidebar, {}),
    h("div", { class: "content", inert: menuOpen.value, onKeyDown: (e: KeyboardEvent) => { if (e.key === "Escape") closeMenu(); } },
      h("header", { class: "topbar" }, h(HeaderActions, {})),
      h("main", { id: "main", ref: main, class: "page" }, h(Page, { r }))));
}

export function App(): View | null {
  const s = sessionState.value;
  const r = route.value;
  if (s.status === "checking") return h("div", { class: "boot", role: "status" }, t("app.loading"));
  if (r.kind === "login") return h(LoginPage, {});
  if (s.status !== "authenticated") return h("div", { class: "boot", role: "status" }, t("app.loading"));
  return h(Shell, { r });
}
