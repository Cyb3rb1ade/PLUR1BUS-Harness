// Usage & Quota page (`/usage`, M3 E8): budget.status (usage per period and agent, every limit with its use and state) and
// budget.set (docs/rpc.md, M2 L8). origin/main serves no /rpc yet; a 404 shows the "unavailable" state. Documented scopes are
// global and agent; limits per project or user are not in the RPC, so the page says so instead of drawing them.
import { getApi } from "../../api/shared.ts";
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card } from "../../components/card.ts";
import { Page } from "../../components/page.ts";
import { PageState } from "../../components/page-state.ts";
import { Tabs } from "../../components/tabs.ts";
import { formatNumber, t, type Key } from "../../i18n.ts";
import { navigate } from "../../router.ts";
import type { PageProps } from "../registry.ts";
import { LimitDialog, RemoveLimitDialog } from "./dialogs.ts";
import { groupLimits, limitView, normalizeStatus, type Limit, type Status } from "./model.ts";
import type { BudgetPeriod, UsageTotals } from "./rpc-types.ts";
import { amount, failState, fullTitle, isAborted, limitKey, limitTitle, money, when, type FailState } from "./shared.ts";

type Load = { kind: "loading" } | { kind: "ready"; status: Status } | { kind: "fail"; state: FailState };
type Dlg = null | { kind: "limit"; limit?: Limit } | { kind: "remove"; limit: Limit };

const editable = (l: Limit): boolean => l.scope === "global" || l.scope === "agent";

function Row({ label, value }: { label: string; value: string }): View { return h("div", {}, h("dt", {}, label), h("dd", {}, value)); }

function LimitCard({ limit, level, onEdit, onRemove }: { limit: Limit; level: 2 | 3; onEdit: () => void; onRemove: () => void }): View {
  const v = limitView(limit);
  const title = limitTitle(limit);
  const used = amount(limit.metric, limit.used);
  const tone = v.status === "ok" ? "ok" : v.status === "warn" ? "warn" : "err";
  const stateText = t(v.status === "ok" ? "budget.state.ok" : v.status === "warn" ? "budget.state.soft" : "budget.state.hard");
  const bound = v.bound === null ? null : amount(limit.metric, v.bound);
  return h(Card, { title, level, aside: h(Badge, { tone }, stateText) },
    bound !== null && v.bound !== null && v.bound > 0
      ? h("meter", { class: `meter meter-${tone}`, min: 0, max: v.bound, value: v.barValue, "aria-label": t("budget.meter", { title, used, limit: bound }) }, `${used} / ${bound}`)
      : null,
    h("p", {}, bound === null ? t("budget.noBound", { used }) : t("budget.usedOf", { used, limit: bound, percent: v.percent })),
    h("dl", { class: "facts facts-cols" },
      h(Row, { label: t("budget.field.used"), value: used }),
      h(Row, { label: t("budget.field.soft"), value: limit.soft === null ? t("budget.field.notSet") : amount(limit.metric, limit.soft) }),
      h(Row, { label: t("budget.field.hard"), value: limit.hard === null ? t("budget.field.notSet") : amount(limit.metric, limit.hard) })),
    editable(limit) ? h("div", { class: "state-actions" },
      h("button", { type: "button", class: "btn", "aria-label": t("budget.dlg.editTitle", { title: fullTitle(limit) }), onClick: onEdit }, t("budget.editLimit")),
      h("button", { type: "button", class: "btn btn-quiet", "aria-label": t("budget.dlg.removeLabel", { title: fullTitle(limit) }), onClick: onRemove }, t("budget.removeLimit"))) : null);
}

function LimitList({ limits, byAgent, onEdit, onRemove }: { limits: readonly Limit[]; byAgent: boolean; onEdit: (l: Limit) => void; onRemove: (l: Limit) => void }): View {
  if (!byAgent) return h("div", {}, limits.map((l) => h(LimitCard, { key: limitKey(l), limit: l, level: 2, onEdit: () => onEdit(l), onRemove: () => onRemove(l) })));
  const groups = new Map<string, Limit[]>();
  for (const l of limits) {
    const name = l.scope === "agent" ? l.agentId ?? "" : `${l.scope}${l.agentId ? ` · ${l.agentId}` : ""}`;
    const g = groups.get(name); if (g) g.push(l); else groups.set(name, [l]);
  }
  return h("div", {}, [...groups].map(([name, list]) => h("section", { key: name },
    h("h2", { class: "group-label" }, name),
    list.map((l) => h(LimitCard, { key: limitKey(l), limit: l, level: 3, onEdit: () => onEdit(l), onRemove: () => onRemove(l) })))));
}

function TotalsRows({ u }: { u: UsageTotals }): View[] {
  return [
    h(Row, { key: "e", label: t("budget.usage.events"), value: formatNumber(u.events) }),
    h(Row, { key: "i", label: t("budget.usage.input"), value: formatNumber(u.inputTokens) }),
    h(Row, { key: "o", label: t("budget.usage.output"), value: formatNumber(u.outputTokens) }),
    h(Row, { key: "cr", label: t("budget.usage.cacheRead"), value: formatNumber(u.cacheReadTokens) }),
    h(Row, { key: "cw", label: t("budget.usage.cacheWrite"), value: formatNumber(u.cacheWriteTokens) }),
    h(Row, { key: "c", label: t("budget.usage.cost"), value: money(u.costMicros) }),
    h(Row, { key: "u", label: t("budget.usage.unpriced"), value: formatNumber(u.unpricedEvents) }),
  ];
}

function PeriodCard({ p }: { p: BudgetPeriod }): View {
  return h(Card, { title: t(p.period === "day" ? "budget.usage.day" : "budget.usage.month", { key: p.key }) },
    h("dl", { class: "facts" }, TotalsRows({ u: p.total })),
    p.total.unpricedEvents > 0 ? h("p", { class: "reading" }, t("budget.usage.unpricedNote")) : null,
    p.agents.length > 0 ? h("div", {},
      h("h3", { class: "card-title" }, t("budget.usage.agents")),
      p.agents.map((a) => h("section", { key: a.agentId },
        h("h4", { class: "card-title" }, a.agentId),
        h("dl", { class: "facts" }, TotalsRows({ u: a.total })),
        h("ul", { class: "plain-list" }, a.models.map((m) => h("li", { key: m.model }, t("budget.usage.modelLine", { model: m.model, events: formatNumber(m.events), input: formatNumber(m.inputTokens), output: formatNumber(m.outputTokens), cost: money(m.costMicros) }))))))) : null);
}

export function BudgetPage({ sub }: PageProps): View {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [dlg, setDlg] = useState<Dlg>(null);
  const seq = useRef(0);
  const alive = useRef(true);

  /** `silent` keeps the page on screen while the new status loads (after a change). */
  const reload = useRef(async (silent: boolean): Promise<void> => {
    const mine = ++seq.current;
    if (!silent) setLoad({ kind: "loading" });
    try {
      const status = normalizeStatus(await getApi().rpc("budget.status", undefined, { write: false }));
      if (alive.current && mine === seq.current) setLoad({ kind: "ready", status });
    } catch (e) {
      if (alive.current && mine === seq.current && !isAborted(e)) setLoad({ kind: "fail", state: failState(e) });
    }
  }).current;

  useEffect(() => {
    alive.current = true;
    void reload(false);
    return () => { alive.current = false; seq.current++; };
  }, []);

  const title = t("nav.usage");
  if (load.kind === "loading") return h(Page, { title }, h(PageState, { state: "loading" }));
  if (load.kind === "fail") {
    const state = load.state;
    return h(Page, { title }, h(PageState, state === "error" ? { state, onRetry: () => { void reload(false); } } : { state }));
  }

  const { status } = load;
  const groups = groupLimits(status.limits);
  const setButton = (key: string): View => h("button", { key, type: "button", class: "btn btn-primary", onClick: () => setDlg({ kind: "limit" }) }, t("budget.setLimit"));
  const actions = [h("button", { key: "refresh", type: "button", class: "btn", onClick: () => { void reload(true); } }, t("budget.refresh")), setButton("set")];
  const dialog = dlg === null ? null
    : dlg.kind === "remove" ? h(RemoveLimitDialog, { limit: dlg.limit, onClose: () => setDlg(null), onRemoved: () => { setDlg(null); void reload(true); } })
    : h(LimitDialog, { ...(dlg.limit ? { limit: dlg.limit } : {}), limits: status.limits, onClose: () => setDlg(null), onSaved: () => { setDlg(null); void reload(true); } });
  const nothingYet = status.limits.length === 0 && status.periods.every((p) => p.total.events === 0 && p.agents.length === 0);

  if (nothingYet) {
    return h(Page, { title, actions }, h(PageState, { state: "empty", title: t("budget.empty.title"), detail: t("budget.empty.body") }, setButton("set-empty")), dialog);
  }

  const onEdit = (l: Limit): void => setDlg({ kind: "limit", limit: l });
  const onRemove = (l: Limit): void => setDlg({ kind: "remove", limit: l });
  const empty = (k: "emptyGlobal" | "emptyAgents" | "emptyUsage"): View =>
    h(PageState, { state: "empty", title: t(`budget.${k}.title` as Key), detail: t(`budget.${k}.body` as Key) }, k === "emptyUsage" ? null : setButton(`set-${k}`));
  const tabs = [
    { id: "global", label: t("budget.tab.global"), panel: groups.global.length === 0 ? empty("emptyGlobal") : h(LimitList, { limits: groups.global, byAgent: false, onEdit, onRemove }) },
    { id: "agents", label: t("budget.tab.agents"), panel: groups.agents.length === 0 ? empty("emptyAgents") : h(LimitList, { limits: groups.agents, byAgent: true, onEdit, onRemove }) },
    ...(groups.other.length > 0 ? [{ id: "other", label: t("budget.tab.other"), panel: h(LimitList, { limits: groups.other, byAgent: true, onEdit, onRemove }) }] : []),
    { id: "usage", label: t("budget.tab.usage"), panel: status.periods.length === 0 ? empty("emptyUsage") : h("div", {}, status.periods.map((p) => h(PeriodCard, { key: `${p.period}${p.key}`, p }))) },
  ];
  const selected = sub ?? "global";
  return h(Page, { title, lead: t("budget.lead"), actions },
    status.timeZone ? h("p", { class: "reading" }, t("budget.meta", { zone: status.timeZone, version: status.priceVersion || "–", when: when(status.now) })) : null,
    h(Tabs, { label: t("budget.tabs"), tabs, selected, onSelect: (id) => navigate(id === "global" ? "/usage" : `/usage/${id}`) }),
    dialog);
}
