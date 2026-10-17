import { PasskeysPanel } from "../security/passkeys.ts";
// Settings > Security & Permissions: a read-only overview of the rules, taken from the running configuration (`config.get`).
// Running approvals stay under Control > Approvals. Nothing is changed here; a key is edited only where a section already owns
// it (the link says where). Values come from the wire only as booleans or one of three known words, never as free text.
import { h } from "preact";
import type { View } from "../../../view.ts";
import { Badge, Card } from "../../../components/card.ts";
import { PageLoading, PageState } from "../../../components/page-state.ts";
import { t, type Key } from "../../../i18n.ts";
import { FailureState } from "../../common/states.ts";
import { currentRole, getApi, roleIn, useLoad } from "../../common/load.ts";
import { settingsHref } from "../../../settings-sections.ts";
import type { SectionProps } from "../page.ts";
import { RULES, stateOf, type Shown } from "../security/rules.ts";
import "../../../styles/security.css";
import { securityLimits, type SecurityLimits } from "../security/limits.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

async function load(signal: AbortSignal): Promise<{rows:Shown[]; limits:SecurityLimits}> {
  const res = await getApi().rpc("config.get", undefined, { write: false, signal }) as unknown;
  const config = isObj(res) ? res.value : undefined;
  return { rows: RULES.map((rule) => ({ rule, state: stateOf(rule, config) })), limits: securityLimits(config) };
}

const STATE_TEXT: Record<Shown["state"], Key> = {
  on: "settings.security.on", off: "settings.security.off", local: "settings.security.publish.local", tailnet: "settings.security.publish.tailnet",
  network: "settings.security.publish.network", other: "settings.security.other", unset: "settings.security.unset",
};
// Tones follow what widens the surface: exposure beyond this machine, shell access, unsigned code or a file store need a look.
const WARN = new Set(["remote.publish:tailnet", "remote.publish:network", "tools.hostctl.shell.allowed:on", "extensions.allowUnsigned:on", "secrets.fileFallback.enabled:on"]);

function Rules({ rows }: { rows: Shown[] }): View {
  return h(Card, { title: t("settings.security.rules"), level: 3 },
    h("dl", { class: "sec-rules" }, rows.map(({ rule, state }) => h("div", { key: rule.key, class: "sec-rule", "data-key": rule.key },
      h("dt", {}, t(rule.label)),
      h("dd", {},
        h(Badge, { tone: WARN.has(`${rule.key}:${state}`) ? "warn" : "neutral" }, t(STATE_TEXT[state])),
        h("p", { class: "field-hint" }, t(rule.hint)),
        h("p", { class: "field-hint sec-key" }, h("code", {}, rule.key),
          rule.editIn ? [" · ", h("a", { href: `#${settingsHref(rule.key)}` }, t("settings.security.editIn", { section: t(`settings.section.${rule.editIn}` as Key) }))] : [" · ", t("settings.security.readOnly")]))))));
}

function Links(): View {
  const links: [string, Key, Key][] = [
    ["#/approvals", "settings.security.link.approvals", "settings.security.link.approvals.hint"],
    ["#/breakglass", "settings.security.link.breakglass", "settings.security.link.breakglass.hint"],
    ["#/settings/devices", "settings.security.link.devices", "settings.security.link.devices.hint"],
  ];
  return h(Card, { title: t("settings.security.links"), level: 3 },
    h("ul", { class: "sec-links" }, links.map(([href, label, hint]) => h("li", { key: href }, h("a", { href }, t(label)), h("span", { class: "field-hint" }, " ", t(hint))))));
}

function Loaded(): View {
  const { state, reload } = useLoad(load, []);
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("settings.cfg.unavailable"), onRetry: reload });
  return h("div", { class: "sec" }, h(Rules, { rows: state.data.rows }), h(Card, { title: t("settings.security.limits"), level: 3 },
    h("dl", {}, Object.entries(state.data.limits).map(([key,value]) => h("div", { key }, h("dt", {}, h("code", {}, `${key.startsWith("reason") || key === "maxWindowMinutes" ? "breakglass" : "approvals"}.${key}`)), h("dd", {}, String(value))))),
    h("p", { class: "field-hint" }, t("settings.security.limits.readOnly"))), h(Links, {}));
}

export function SecuritySection({ section }: SectionProps): View {
  const allowed = roleIn(currentRole(), ["owner", "admin"]);
  return h("section", { "data-section": section.id, "aria-labelledby": "sec-h" },
    h("h2", { id: "sec-h" }, t("settings.section.security")),
    h("p", { class: "field-hint" }, t("settings.security.intro")),
    h(PasskeysPanel, {}), allowed ? h(Loaded, {}) : h(PageState, { state: "forbidden" }));
}
