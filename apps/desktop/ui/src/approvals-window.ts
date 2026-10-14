import { approvalCards, type ApprovalCard } from "./views/approvals.ts";
import { resolveLocale, translate, type MessageKey, type LocaleChoice } from "./i18n.ts";
import { element } from "./components/dom.ts";

export type ApprovalsHost = {
  settings(): Promise<{ theme: "system" | "light" | "dark"; locale: LocaleChoice }>;
  appInfo(): Promise<{ platform: string; locale: string }>;
  list(): Promise<{ cards: ApprovalCard[]; decideEnabled: boolean }>;
  open(id: string): Promise<void>;
  decide(id: string, decision: "approve" | "deny"): Promise<void>;
  onChanged(listener: () => void): Promise<unknown>;
};

/** The approvals window: a failed read shows an alert instead of a blank window, and only the newest read is drawn. */
export async function mountApprovals(root: HTMLElement, host: ApprovalsHost): Promise<void> {
  let t = (key: MessageKey) => translate("en", key);
  try {
    const [settings, info] = await Promise.all([host.settings(), host.appInfo()]);
    const locale = resolveLocale(settings.locale, info.locale);
    document.documentElement.lang = locale;
    document.documentElement.dataset.platform = info.platform;
    document.documentElement.dataset.theme = settings.theme === "system" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : settings.theme;
    t = key => translate(locale, key);
  } catch { /* Defaults keep the window usable; cards carry their own facts. */ }
  let latest = 0;
  const render = async () => {
    const mine = ++latest;
    try {
      const data = await host.list();
      if (mine === latest) root.replaceChildren(approvalCards(data.cards, t, id => host.open(id), data.decideEnabled, (id, decision) => host.decide(id, decision)));
    } catch {
      if (mine !== latest) return;
      const main = element("main", "content settings-stack");
      const alert = element("p", undefined, t("host.failed"));
      alert.setAttribute("role", "alert");
      main.append(alert);
      root.replaceChildren(main);
    }
  };
  await host.onChanged(() => { void render(); }).catch(() => {});
  await render();
}
