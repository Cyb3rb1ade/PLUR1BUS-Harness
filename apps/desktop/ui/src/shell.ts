import "./theme/base.css";
import type { DesktopTransport, Platform, Settings, ThemeChoice } from "./ipc.ts";
import { resolveLocale, translate, type Locale, type MessageKey } from "./i18n.ts";
import { routeFromHash, hashFor, type Route, type Section, type SettingsPage } from "./router.ts";
import { element, append } from "./components/dom.ts";
import { button } from "./components/button.ts";
import { rail } from "./components/rail.ts";
import { segmented } from "./components/segmented.ts";
import { chip } from "./components/chip.ts";
import { banner } from "./components/banner.ts";
import { progressList } from "./components/progress-list.ts";
import { openDialog } from "./components/dialog.ts";
import { openSheet } from "./components/sheet.ts";
import { wordmark } from "./components/wordmark.ts";

function resolvedTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const light = window.matchMedia("(prefers-color-scheme: light)");
  return media.matches ? "dark" : light.matches ? "light" : "dark";
}

export function createShell(root: HTMLElement, transport: DesktopTransport) {
  const mount = element("div", "shell-mount");
  root.append(mount);
  let settings: Settings = { theme: "system", locale: "system" };
  let persisted: Settings = settings;
  const preferenceQueue: Array<{ change: Partial<Settings>; resolve: () => void }> = [];
  let saving = false;
  let platform: Platform = "mac";
  let systemLocale = "en";
  let route = routeFromHash(window.location.hash);
  let notice: "load" | "save" | "saved" | null = null;
  let lastSection = route.section;
  const mark = wordmark(() => navigate("home"));
  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const lightMedia = window.matchMedia("(prefers-color-scheme: light)");
  themeMedia.addEventListener("change", render);
  lightMedia.addEventListener("change", render);
  window.addEventListener("hashchange", () => {
    const next = routeFromHash(window.location.hash);
    if (next.section !== route.section || next.page !== route.page) { route = next; render(); focusPage(); }
  });
  const settingsLoad = transport.settingsGet().then(stored => {
    persisted = stored;
    settings = preferenceQueue.reduce((value, entry) => ({ ...value, ...entry.change }), stored);
    render();
  }).catch(() => { notice = "load"; render(); });
  void transport.appInfo().then(info => { platform = info.platform; systemLocale = info.locale; render(); }).catch(() => {});
  render();

  function t(key: MessageKey, values?: Record<string, string>) { return translate(resolveLocale(settings.locale, systemLocale), key, values); }
  function focusPage() { mount.querySelector<HTMLElement>("h1")?.focus(); }
  function navigate(section: Section, page: SettingsPage = "runtime") {
    const next = { section, page };
    window.location.hash = hashFor(next);
    route = next;
    render();
    focusPage();
  }
  function renderWithFocus() {
    const focusedField = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("fieldset[data-preference]")?.dataset.preference : undefined;
    render();
    if (focusedField) root.querySelector<HTMLElement>(`fieldset[data-preference="${focusedField}"] button[aria-pressed="true"]`)?.focus();
  }
  function setPreferences(change: Partial<Settings>): Promise<void> {
    root.querySelector('.toast:not([role="alert"])')?.remove();
    settings = { ...settings, ...change };
    const completed = new Promise<void>(resolve => preferenceQueue.push({ change, resolve }));
    renderWithFocus();
    void flushPreferences();
    return completed;
  }
  async function flushPreferences() {
    if (saving) return;
    saving = true;
    await settingsLoad;
    let failed = false;
    const completed: Array<() => void> = [];
    while (preferenceQueue.length) {
      const entry = preferenceQueue.shift()!;
      try { persisted = await transport.settingsSet({ ...persisted, ...entry.change }); }
      catch { failed = true; }
      settings = preferenceQueue.reduce((value, queued) => ({ ...value, ...queued.change }), persisted);
      renderWithFocus();
      completed.push(entry.resolve);
    }
    saving = false;
    notice = failed ? "save" : "saved";
    renderWithFocus();
    completed.forEach(resolve => resolve());
  }
  function setPlatform(value: Platform) { platform = value; render(); }
  function heading(title: string, lead: string): HTMLElement {
    const header = element("header", "page-header");
    append(header, element("p", "eyebrow", t("app.name")), element("h1", undefined, title), element("p", "lead", lead));
    return header;
  }
  function panel(): HTMLElement {
    const side = element("aside", "related-panel");
    append(side, element("p", "eyebrow", t("app.name")), element("h2", undefined, t("panel.title")), element("p", undefined, t("panel.body")));
    return side;
  }
  function relatedButton(label: string, body: string): HTMLButtonElement {
    const trigger = button(label, () => openSheet(label, element("p", undefined, body), t("panel.close")), "secondary");
    trigger.classList.add("related-button");
    trigger.dataset.focusKey = "related";
    return trigger;
  }
  function pageCard(title: string, body: string, action?: HTMLButtonElement): HTMLElement {
    const card = element("section", "page-card");
    append(card, element("h2", "card-title", title), element("p", undefined, body), action);
    return card;
  }
  function home(): HTMLElement {
    const body = element("div", "content home-content");
    const hero = element("section", "home-hero");
    append(hero, element("p", "eyebrow", t("home.eyebrow")), element("h1", undefined, t("home.title")), element("p", "lead", t("home.lead")), chip(t("status.ready"), "ok"));
    const cards = element("div", "home-cards");
    append(cards,
      pageCard(t("home.connectionTitle"), t("home.connectionBody"), button(t("home.openConnections"), () => navigate("connections"), "primary")),
      pageCard(t("home.settingsTitle"), t("home.settingsBody"), button(t("home.openSettings"), () => navigate("settings"))));
    append(body, hero, cards, banner(t("banner.note")));
    return body;
  }
  function preferenceCard(title: string, description: string, control: HTMLElement): HTMLElement {
    const card = pageCard(title, description);
    card.append(control);
    return card;
  }
  function appearance(): HTMLElement {
    const stack = element("div", "settings-stack");
    const theme = segmented(t("settings.appearance"), [
      { value: "system", label: t("settings.system") }, { value: "light", label: t("settings.light") }, { value: "dark", label: t("settings.dark") },
    ] as const, settings.theme, value => void setPreferences({ theme: value }));
    theme.dataset.preference = "theme";
    theme.querySelectorAll<HTMLButtonElement>("button").forEach((control, index) => { control.dataset.focusKey = `theme-${index}`; });
    const language = segmented(t("settings.language"), [
      { value: "system", label: t("settings.system") }, { value: "en", label: t("settings.english") }, { value: "de", label: t("settings.german") },
    ] as const, settings.locale, value => void setPreferences({ locale: value }));
    language.dataset.preference = "locale";
    language.querySelectorAll<HTMLButtonElement>("button").forEach((control, index) => { control.dataset.focusKey = `locale-${index}`; });
    append(stack,
      preferenceCard(t("settings.appearance"), t("settings.appearanceBody"), theme),
      preferenceCard(t("settings.language"), t("settings.languageBody"), language));
    return stack;
  }
  function settingsPage(): HTMLElement {
    const container = element("div", "content settings-content");
    const header = heading(t("settings.title"), t("settings.lead"));
    const sections: [SettingsPage, MessageKey][] = [["runtime", "nav.runtime"], ["updates", "nav.updates"], ["version", "nav.version"], ["advanced", "nav.advanced"]];
    const openSections = button(t("nav.sections"), () => {
      const menu = element("nav", "sheet-sections");
      menu.setAttribute("aria-label", t("nav.sections"));
      for (const [page, key] of sections) menu.append(button(t(key), () => { navigate("settings", page); document.querySelector<HTMLButtonElement>(".sheet-close")?.click(); }, "quiet"));
      openSheet(t("nav.sections"), menu, t("panel.close"), () => root.querySelector<HTMLElement>(".sections-button")?.focus());
    }, "secondary");
    openSections.classList.add("sections-button");
    openSections.dataset.focusKey = "sections";
    const layout = element("div", "settings-layout");
    const main = element("div", "settings-main");
    if (route.page === "advanced") {
      const stack = element("div", "settings-stack");
      const intro = element("div", "settings-section-header");
      append(intro, element("h2", undefined, t("settings.advancedTitle")), element("p", undefined, t("settings.advancedBody")));
      append(stack, intro, appearance());
      main.append(stack);
    } else {
      const titleKey = `settings.${route.page}Title` as MessageKey;
      const bodyKey = `settings.${route.page}Body` as MessageKey;
      main.append(pageCard(t(titleKey), t(bodyKey)));
    }
    append(layout, main, panel());
    append(container, header, openSections, relatedButton(t("panel.open"), t("panel.body")), layout);
    return container;
  }
  function connections(): HTMLElement {
    const container = element("div", "content connections-content");
    const header = heading(t("connections.title"), t("connections.lead"));
    const layout = element("div", "connections-layout");
    const list = element("aside", "connections-side");
    append(list, element("h2", "card-title", t("home.connectionTitle")), chip(t("status.empty")));
    const main = element("div", "connections-main");
    append(main, pageCard(t("connections.emptyTitle"), t("connections.emptyBody")), progressList(t("progress.title"), [{ label: t("progress.waiting"), state: "waiting" }]));
    const detail = pageCard(t("connections.detailTitle"), t("connections.detailBody"));
    detail.classList.add("connections-detail");
    append(layout, list, main, detail);
    append(container, header, relatedButton(t("connections.detailTitle"), t("connections.detailBody")), layout);
    return container;
  }
  function render() {
    const focusKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined;
    const locale: Locale = resolveLocale(settings.locale, systemLocale);
    document.documentElement.lang = locale;
    document.documentElement.dataset.theme = resolvedTheme(settings.theme);
    document.documentElement.dataset.platform = platform;
    document.documentElement.dataset.section = route.section;
    const changingSection = lastSection !== route.section;
    const sectionLabel = route.section === "home" ? t("wordmark.home") : route.section === "connections" ? t("wordmark.connections") : t("wordmark.settings");
    const spoken = t("nav.home");
    mark.set(sectionLabel, spoken, changingSection, route.section === "home" ? t("wordmark.subtitle") : undefined);
    lastSection = route.section;
    const app = element("div", "app-frame");
    const sidebar = rail({ main: t("nav.main"), home: t("nav.home"), settings: t("nav.settings"), connections: t("nav.connections"), open: t("nav.open"), close: t("nav.close"), runtime: t("nav.runtime"), updates: t("nav.updates"), version: t("nav.version"), advanced: t("nav.advanced") }, route.section, route.page, navigate, page => navigate("settings", page));
    const body = element("div", "app-body");
    const top = element("header", "app-top");
    const status = chip(t("status.empty"));
    status.classList.add("top-status");
    append(top, mark.node, status);
    const main = element("main", "page-main");
    main.id = "main-content";
    main.append(route.section === "home" ? home() : route.section === "connections" ? connections() : settingsPage());
    const footer = element("footer", "app-footer");
    append(footer, element("span", undefined, t("footer.hint")), button(t("dialog.open"), () => openDialog(t("dialog.title"), t("dialog.body"), t("dialog.cancel"), t("dialog.confirm")), "quiet"));
    append(body, top, main, footer);
    append(app, sidebar, body);
    mount.replaceChildren(app);
    const title = mount.querySelector<HTMLElement>("h1");
    if (title) { title.tabIndex = -1; title.dataset.focusKey = "page-title"; }
    mark.node.dataset.focusKey = "wordmark-home";
    footer.querySelector<HTMLElement>("button")!.dataset.focusKey = "preferences-help";
    mount.querySelectorAll<HTMLElement>(".home-cards button").forEach((control, index) => { control.dataset.focusKey = `home-action-${index}`; });
    if (focusKey) Array.from(root.querySelectorAll<HTMLElement>("[data-focus-key]")).find(node => node.dataset.focusKey === focusKey)?.focus();
    if (notice) {
      const message = notice === "saved" ? t("settings.saved") : t(notice === "load" ? "settings.loadError" : "settings.saveError");
      const region = banner(message, notice === "saved" ? "info" : "error");
      region.classList.add("toast");
      if (notice !== "saved") {
        const dismiss = button(t("notice.dismiss"), () => { region.remove(); focusPage(); }, "quiet");
        region.append(dismiss);
      }
      root.append(region);
      if (notice === "saved") window.setTimeout(() => region.remove(), 3000);
      notice = null;
    }
  }
  return { setPreferences, setPlatform, navigate };
}
