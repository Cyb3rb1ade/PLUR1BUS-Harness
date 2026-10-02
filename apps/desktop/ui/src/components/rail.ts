import { element, append } from "./dom.ts";
import { button } from "./button.ts";
import { openSheet } from "./sheet.ts";
import type { Section } from "../router.ts";
import type { SettingsPage } from "../router.ts";
import { icon } from "./icon.ts";

export function rail(labels: { home: string; settings: string; connections: string; open: string; close: string; runtime: string; updates: string; version: string; advanced: string }, active: Section, activePage: SettingsPage, navigate: (section: Section) => void, navigateSettings: (page: SettingsPage) => void): HTMLElement {
  const aside = element("aside", "sidebar");
  const nav = element("nav", "sidebar-nav");
  nav.setAttribute("aria-label", labels.open);
  const overlayNav = () => {
    const menu = element("nav", "overlay-nav");
    menu.setAttribute("aria-label", labels.open);
    for (const section of ["home", "connections", "settings"] as const) {
      menu.append(button(labels[section], () => { navigate(section); document.querySelector<HTMLButtonElement>(".sheet-close")?.click(); }, "quiet"));
    }
    return menu;
  };
  const opener = button("", () => openSheet(labels.open, overlayNav(), labels.close, () => document.querySelector<HTMLElement>(".rail-menu")?.focus(), "left"), "quiet");
  opener.classList.add("rail-menu");
  opener.setAttribute("aria-label", labels.open);
  opener.append(icon("menu"));
  const links = element("div", "rail-links");
  for (const section of ["home", "connections", "settings"] as const) {
    const item = button("", () => navigate(section), "quiet");
    item.classList.add("rail-link");
    if (active === section) item.setAttribute("aria-current", "page");
    item.setAttribute("aria-label", labels[section]);
    item.append(icon(section), element("span", "rail-label", labels[section]));
    links.append(item);
    if (section === "settings" && active === "settings") {
      const children = element("div", "rail-subsections");
      for (const page of ["runtime", "updates", "version", "advanced"] as const) {
        const child = button(labels[page], () => navigateSettings(page), "quiet");
        if (activePage === page) child.setAttribute("aria-current", "page");
        children.append(child);
      }
      links.append(children);
    }
  }
  append(nav, opener, links);
  aside.append(nav);
  return aside;
}
