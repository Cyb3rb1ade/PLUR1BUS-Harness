// Settings > Modules & Updates: the installed modules, one row each. A row shows the state, whether the configuration enables the
// module, what it depends on and what needs it, and, for Owner and Admin, the start, stop and restart buttons.
import { h } from "preact";
import type { View } from "../../../view.ts";
import { Badge, type BadgeTone } from "../../../components/card.ts";
import { t, type Key } from "../../../i18n.ts";
import { cycleMembers, dependencies, dependents, isRunning, unresolved, type ModuleAction, type ModuleEntry } from "./model.ts";
import type { ModuleGraph } from "./rpc-types.ts";
import type { ExtItem } from "../../common/surfaces-rpc.ts";

const STATE_TONE: Record<string, BadgeTone> = { ready: "ok", starting: "info", stopping: "info", degraded: "warn", orphaned: "warn", stopped: "neutral", crashed: "err" };
const ACTION_KEY: Record<ModuleAction, Key> = { start: "modules.action.start", stop: "modules.action.stop", restart: "modules.action.restart" };

const stateOf = (m: ModuleEntry): { tone: BadgeTone; text: string } => {
  const state = m.child?.process.state;
  if (state === undefined) return { tone: "neutral", text: t("modules.state.notRunning") };
  return { tone: STATE_TONE[state] ?? "neutral", text: t(`modules.state.${state}` as Key) };
};
const names = (xs: readonly string[]): string => (xs.length > 0 ? xs.join(", ") : t("modules.none"));

export type ModuleListProps = {
  rows: ModuleEntry[];
  extensions?: ExtItem[];
  onExtension?: (name: string) => void;
  graph: ModuleGraph | null;
  /** Owner and Admin: start, stop and restart. */
  canOperate: boolean;
  /** Owner only: uninstall (the install itself lives in the card head). */
  canInstall: boolean;
  onAction: (action: ModuleAction, m: ModuleEntry) => void;
  onUninstall: (m: ModuleEntry) => void;
};

export function ModuleList(props: ModuleListProps): View {
  return h("ul", { class: "plain-list modules-list", "aria-label": t("modules.list.label") },
    props.rows.map((m) => h(ModuleRow, { key: m.name, m, ...props })),
    (props.extensions ?? []).filter(item => !props.rows.some(row => row.name === item.name)).map(item => h("li", { key: `extension:${item.name}`, class: "modules-row", "data-extension": item.name },
      h("div", { class: "modules-who" }, h("strong", { class: "modules-name" }, item.name), h("span", { class: "modules-id" }, item.version)),
      h("div", { class: "modules-meta" }, h(Badge, {}, item.kind), h(Badge, {}, item.trust), h(Badge, { tone: item.partial ? "warn" : item.enabled ? "ok" : "neutral" }, t(item.partial ? "extensions.bundle.partial" : item.enabled ? "extensions.status.enabled" : "extensions.status.disabled"))),
      h("button", { type: "button", class: "btn btn-quiet", onClick: () => props.onExtension?.(item.name) }, t("extensions.action.details")))));
}

function ModuleRow({ m, graph, canOperate, canInstall, onAction, onUninstall, extensions }: { m: ModuleEntry } & ModuleListProps): View {
  const state = stateOf(m);
  const missing = unresolved(graph, m.name);
  const cycle = cycleMembers(graph, m.name);
  const actions: ModuleAction[] = isRunning(m) ? ["stop", "restart"] : ["start"];
  const extension = extensions?.find(item => item.name === m.name);
  return h("li", { class: "modules-row", "data-module": m.name },
    h("div", { class: "modules-who" },
      h("strong", { class: "modules-name" }, m.name),
      h("span", { class: "modules-id" },
        m.version !== null ? t("modules.field.version", { version: m.version }) : null,
        m.version !== null && m.apiVersion !== null ? " · " : null,
        m.apiVersion !== null ? t("modules.field.api", { version: m.apiVersion }) : null)),
    h("div", { class: "modules-meta" },
      h(Badge, {}, extension?.kind ?? "module"),
      extension ? h(Badge, {}, extension.trust) : null,
      h(Badge, { tone: state.tone }, state.text),
      h(Badge, { tone: m.enabled ? "info" : "warn" }, m.enabled ? t("modules.enabled.on") : t("modules.enabled.off")),
      m.child !== null && m.child.restarts > 0 ? h(Badge, {}, t("modules.field.restarts", { n: m.child.restarts })) : null),
    m.availableVersion ? h("p", { class: "modules-deps" }, t("modules.update.available", { version: m.availableVersion })) : null,
    m.updateBlockedReason ? h("p", { class: "modules-warn" }, t(m.updateBlockedReason === "signature" ? "modules.update.signature" : "modules.update.minimum")) : null,
    m.feedCheckedAt ? h("p", { class: "field-hint" }, t("modules.update.checked", { at: m.feedCheckedAt })) : null,
    h("p", { class: "modules-deps" }, t("modules.needs", { names: names(dependencies(graph, m.name)) })),
    h("p", { class: "modules-deps" }, t("modules.neededBy", { names: names(dependents(graph, m.name)) })),
    missing.length > 0 ? h("p", { class: "modules-warn" }, t("modules.unresolved", { names: missing.join(", ") })) : null,
    cycle.length > 0 ? h("p", { class: "modules-warn" }, t("modules.cycle", { names: cycle.join(", ") })) : null,
    m.errors.length > 0 ? h("p", { class: "modules-warn" }, t("modules.errors", { reason: m.errors.join("; ") })) : null,
    canOperate || canInstall
      ? h("div", { class: "modules-actions" },
        canOperate ? actions.map((a) => h("button", {
          key: a, type: "button", class: "btn btn-quiet",
          "aria-label": t("modules.action.aria", { action: t(ACTION_KEY[a]), name: m.name }),
          onClick: () => { onAction(a, m); },
        }, t(ACTION_KEY[a]))) : null,
        canInstall ? h("button", {
          type: "button", class: "btn btn-quiet",
          "aria-label": t("modules.action.aria", { action: t("modules.action.uninstall"), name: m.name }),
          onClick: () => { onUninstall(m); },
        }, t("modules.action.uninstall")) : null)
      : null);
}
