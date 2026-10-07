import { signal } from "@preact/signals";
import { h } from "preact";
import type { View } from "../view.ts";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { t } from "../i18n.ts";
import { icon } from "../icons.ts";
import { compact } from "../layout.ts";
import { BOTTOM, GROUPS, LANDING, type NavItem } from "../nav.ts";
import { route } from "../router.ts";
import { shortcut } from "../palette/hotkey.ts";
import { openPalette } from "../palette/state.ts";

export const menuOpen = signal(false);
export const closeMenu = (): void => { menuOpen.value = false; };

function link(item: NavItem, activeId: string | null): View {
  const label = t(item.label);
  return h("li", { key: item.id }, h("a", {
    class: "nav-link", href: `#${item.path}`, title: label,
    ...(item.id === activeId ? { "aria-current": "page" } : {}),
  }, icon(item.icon), h("span", { class: "label" }, label)));
}

/** One sidebar element, three presentations by CSS: full 256 (normal, wide), rail 64 (compact), overlay 288 (compact,
 * opened by the menu button). Labels stay in the DOM in the rail (visually hidden), so names are accessible. */
export function Sidebar(): View {
  const open = menuOpen.value && compact.value;
  const r = route.value;
  const activeId = r.kind === "page" ? r.item.id : null;
  const root = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Layout effect: focus moves in the same commit that opens or closes the overlay.
  useLayoutEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>(".nav-link")?.focus();
    else if (wasOpen.current) menuButton.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // The overlay is for compact windows only; route changes close it too.
  useEffect(() => { if (!compact.value) closeMenu(); }, [compact.value]);
  useEffect(() => { closeMenu(); }, [activeId]);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!open) return;
    if (e.key === "Escape") { e.stopPropagation(); closeMenu(); return; }
    if (e.key !== "Tab") return;
    const focusable = Array.from(root.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return h("div", { class: "sidebar-slot" },
    h("aside", { class: "sidebar", id: "sidebar", ref: root, "data-open": String(open), onKeyDown },
      h("div", { class: "sidebar-head" },
        h("button", {
          type: "button", ref: menuButton, class: "icon-btn menu-btn", "aria-expanded": open, "aria-controls": "sidebar-nav",
          onClick: () => { menuOpen.value = !menuOpen.value; },
        }, icon(open ? "close" : "menu"), h("span", { class: "sr-only" }, open ? t("nav.close") : t("nav.menu"))),
        h("a", { class: "wordmark", href: `#${LANDING}`, "aria-label": "PLUR1BUS" }, "PLUR", h("span", { class: "one" }, "1"), "BUS")),
      // Opens the command palette (palette/); ⌘K / Ctrl+K and "/" do the same from anywhere.
      h("button", { type: "button", class: "search-pill", "aria-haspopup": "dialog", "aria-keyshortcuts": `${shortcut()} /`, onClick: openPalette }, icon("search"), h("span", { class: "label" }, t("nav.search"))),
      h("nav", { id: "sidebar-nav", "aria-label": t("nav.main") },
        GROUPS.map((g) => h("div", { class: "nav-group", key: g.id },
          h("p", { class: "group-label", id: `grp-${g.id}` }, t(g.label)),
          h("ul", { "aria-labelledby": `grp-${g.id}` }, g.items.map((i) => link(i, activeId))))),
        h("ul", { class: "nav-bottom" }, BOTTOM.map((i) => link(i, activeId))))),
    h("div", { class: "scrim", onClick: closeMenu }));
}
