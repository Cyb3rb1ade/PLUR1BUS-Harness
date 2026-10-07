// Models page (`/models`, M3 E8): the model catalog of docs/rpc.md (models.list/scan/setOverride/removeManual/acknowledge,
// notification models.changed) as list + detail. None of it is served by origin/main yet; a 404 shows the "unavailable" state.
import { getApi } from "../../api/shared.ts";
import { h, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import type { SseEvent } from "../../api/index.ts";
import { Badge, Card } from "../../components/card.ts";
import { ListDetail } from "../../components/list-detail.ts";
import { Page } from "../../components/page.ts";
import { PageState } from "../../components/page-state.ts";
import { formatNumber, t, type Key } from "../../i18n.ts";
import { navigate } from "../../router.ts";
import type { PageProps } from "../registry.ts";
import { OverrideDialog, RemoveDialog } from "./dialogs.ts";
import {
  filterModels, groupByProvider, modelKey, normalizeList, newKeys, parseModelRoute, routeFor, scanTotals,
  type Filters, type ListData, type ModelEntry, type ScanTotals,
} from "./model.ts";
import { capText, failState, isAborted, isForbidden, kindText, outcomeText, warnText, when, type FailState } from "./shared.ts";
import type { ModelsScanResult } from "./rpc-types.ts";

type Load = { kind: "loading" } | { kind: "ready"; data: ListData; isNew: ReadonlySet<string> } | { kind: "fail"; state: FailState };
type Scan = { kind: "idle" } | { kind: "running" } | { kind: "done"; totals: ScanTotals } | { kind: "error"; forbidden: boolean };
type Dlg = null | { kind: "edit"; model: ModelEntry } | { kind: "add" } | { kind: "remove"; model: ModelEntry };
type Live = "on" | "connecting" | "off";

/** The notification arrives as an SSE event named models.changed, or as a JSON-RPC notification object in the data. */
function isModelsChanged(e: SseEvent): boolean {
  if (e.event === "models.changed") return true;
  try { return (JSON.parse(e.data) as { method?: unknown }).method === "models.changed"; } catch { return false; }
}

const unknownText = (): string => t("models.unknown");

function Row({ label, children }: { label: string; children?: ComponentChildren }): View {
  return h("div", {}, h("dt", {}, label), h("dd", {}, children));
}

function ModelDetail({ model, isNew, onEdit, onRemove }: { model: ModelEntry; isNew: boolean; onEdit: () => void; onRemove: () => void }): View {
  const ov = model.overrides;
  const overrides: string[] = [];
  if (ov.displayName !== undefined) overrides.push(`${t("models.form.displayName")}: ${ov.displayName}`);
  if (ov.kind !== undefined) overrides.push(`${t("models.field.kind")}: ${kindText(ov.kind)}`);
  if (ov.contextWindow !== undefined) overrides.push(`${t("models.field.context")}: ${formatNumber(ov.contextWindow)}`);
  if (ov.capabilities !== undefined) overrides.push(`${t("models.field.capabilities")}: ${ov.capabilities.map((c) => capText(c)).join(", ") || t("models.none")}`);
  if (ov.aliases !== undefined) overrides.push(`${t("models.field.aliases")}: ${ov.aliases.join(", ") || t("models.none")}`);
  const extra = Object.entries(model.extra);
  const source = model.source === "unknown" ? unknownText() : t(`models.source.${model.source}` as Key);
  const canRemove = model.source === "manual" || model.status === "manual";
  return h(Card, {
    title: model.displayName,
    aside: h("span", {}, h(Badge, { tone: model.status === "available" ? "ok" : model.status === "unavailable" ? "warn" : "neutral" }, t(`models.status.${model.status}` as Key)),
      isNew ? [" ", h(Badge, { key: "n", tone: "info" }, t("models.new"))] : null),
  },
    h("dl", { class: "facts" },
      h(Row, { label: t("models.field.provider") }, model.provider),
      h(Row, { label: t("models.field.id") }, h("code", {}, model.id)),
      h(Row, { label: t("models.field.kind") }, model.kind === "unknown" ? unknownText() : kindText(model.kind)),
      h(Row, { label: t("models.field.context") }, model.contextWindow === undefined ? unknownText() : formatNumber(model.contextWindow)),
      h(Row, { label: t("models.field.capabilities") }, model.capabilities.length === 0 ? t("models.none") : model.capabilities.map((c) => capText(c)).join(", ")),
      h(Row, { label: t("models.field.aliases") }, model.aliases.length === 0 ? t("models.none") : model.aliases.join(", ")),
      h(Row, { label: t("models.field.status") }, t(`models.status.${model.status}` as Key)),
      h(Row, { label: t("models.field.source") }, source),
      h(Row, { label: t("models.field.firstSeen") }, when(model.firstSeen)),
      h(Row, { label: t("models.field.lastSeen") }, when(model.lastSeen)),
      h(Row, { label: t("models.field.overrides") }, overrides.length === 0 ? t("models.none") : h("ul", { class: "plain-list" }, overrides.map((o) => h("li", { key: o }, o)))),
      extra.length > 0 ? h(Row, { label: t("models.field.extra") }, h("ul", { class: "plain-list" }, extra.map(([k, v]) => h("li", { key: k }, `${k}: ${String(v)}`)))) : null),
    h("div", { class: "state-actions" },
      h("button", { type: "button", class: "btn", onClick: onEdit }, t("models.edit")),
      canRemove ? h("button", { type: "button", class: "btn btn-quiet", onClick: onRemove }, t("models.removeManual")) : null));
}

function ModelList({ data, isNew, filters, setFilters, selected }: { data: ListData; isNew: ReadonlySet<string>; filters: Filters; setFilters: (f: Filters) => void; selected: { provider: string; id: string } | null }): View {
  const providers = [...new Set([...data.providers.map((p) => p.provider), ...data.models.map((m) => m.provider)])];
  const shown = filterModels(data.models, filters, isNew);
  const groups = groupByProvider(shown);
  const select = (id: string, label: string, value: string, options: readonly (readonly [string, string])[], on: (v: string) => void): View =>
    h("div", { class: "field" }, h("label", { for: id }, label),
      h("select", { id, value, onChange: (e: Event) => on((e.target as HTMLSelectElement).value) }, options.map(([v, text]) => h("option", { key: v, value: v, selected: v === value }, text))));
  return h("div", { class: "model-list" },
    select("mf-provider", t("models.filter.provider"), filters.provider, [["", t("models.filter.all")], ...providers.map((p) => [p, p] as const)], (provider) => setFilters({ ...filters, provider })),
    select("mf-status", t("models.filter.status"), filters.status, [["", t("models.filter.all")], ["available", t("models.status.available")], ["unavailable", t("models.status.unavailable")], ["manual", t("models.status.manual")]], (status) => setFilters({ ...filters, status })),
    h("p", {}, h("button", { type: "button", class: "btn btn-quiet", "aria-pressed": filters.newOnly, onClick: () => setFilters({ ...filters, newOnly: !filters.newOnly }) }, t("models.filter.newOnly"))),
    groups.length === 0 ? h("p", { class: "ld-empty" }, t("models.noMatch")) : groups.map((g) => h("section", { key: g.provider },
      h("h2", { class: "group-label" }, g.provider),
      h("ul", { class: "plain-list" }, g.models.map((m) => {
        const isSel = selected !== null && selected.provider === m.provider && selected.id === m.id;
        return h("li", { key: modelKey(m) },
          h("a", { class: "nav-link", href: `#/models/${routeFor(m.provider, m.id)}`, ...(isSel ? { "aria-current": "true" } : {}) },
            h("span", {}, m.displayName),
            m.status !== "available" ? h(Badge, { tone: m.status === "unavailable" ? "warn" : "neutral" }, t(`models.status.${m.status}` as Key)) : null,
            isNew.has(modelKey(m)) ? h(Badge, { tone: "info" }, t("models.new")) : null));
      })))));
}

function ProvidersCard({ data }: { data: ListData }): View | null {
  if (data.providers.length === 0 && data.warnings.length === 0) return null;
  return h(Card, { title: t("models.providers") },
    h("ul", { class: "plain-list" }, data.providers.map((p) => h("li", { key: p.provider },
      h("strong", {}, p.provider), " ",
      p.lastResult !== undefined && p.lastResult !== "ok" ? h(Badge, { tone: "err" }, outcomeText(p.lastResult)) : null,
      " ", p.lastScanAt ? t("models.lastScan", { when: when(p.lastScanAt) }) : t("models.neverScanned"),
      p.consecutiveFailures ? ` · ${t("models.failures", { count: p.consecutiveFailures })}` : ""))),
    data.warnings.length > 0 ? h("div", {},
      h("h3", { class: "card-title" }, t("models.warnings")),
      h("ul", { class: "plain-list" }, data.warnings.map((w, i) => h("li", { key: i },
        warnText(w.code, { role: w.role ?? "?", provider: w.provider ?? "?", id: w.id ?? "?" }))))) : null);
}

function ScanResult({ totals }: { totals: ScanTotals }): View {
  return h("div", { class: "card", role: "status", "data-scan-result": "" },
    h("p", {}, h("strong", {}, t("models.scanResult", { added: totals.added, gone: totals.gone }))),
    totals.reappeared > 0 ? h("p", {}, t("models.scanReappeared", { count: totals.reappeared })) : null,
    totals.failed.length + totals.running.length + totals.skipped.length > 0 ? h("ul", { class: "plain-list" },
      totals.failed.map((f) => h("li", { key: `f${f.provider}` }, h("strong", {}, f.provider), " ", outcomeText(f.result))),
      totals.skipped.map((f) => h("li", { key: `s${f.provider}` }, h("strong", {}, f.provider), " ", outcomeText(f.result))),
      totals.running.map((p) => h("li", { key: `r${p}` }, h("strong", {}, p), " ", outcomeText("already_running")))) : null,
    h("p", { class: "reading" }, t("models.scanNote")));
}

export function ModelsPage({ sub }: PageProps): View {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [scan, setScan] = useState<Scan>({ kind: "idle" });
  const [live, setLive] = useState<Live>("connecting");
  const [filters, setFilters] = useState<Filters>({ provider: "", status: "", newOnly: false });
  const [dlg, setDlg] = useState<Dlg>(null);
  const seq = useRef(0);
  const alive = useRef(true);

  /** `silent` keeps the current list on screen while the new one loads (after a write, a scan or a live event). */
  const reload = useRef(async (silent: boolean): Promise<void> => {
    const mine = ++seq.current;
    if (!silent) setLoad({ kind: "loading" });
    try {
      const api = getApi();
      const data = normalizeList(await api.rpc("models.list", undefined, { write: false }));
      let isNew: ReadonlySet<string> = new Set();
      if (data.newCount > 0) {
        // The entries carry no "new" flag (docs/rpc.md ModelEntry); models.list { newOnly: true } names exactly the new ones.
        try { isNew = newKeys(await api.rpc("models.list", { newOnly: true }, { write: false })); } catch { /* the list still shows; only the badges are missing */ }
      }
      if (alive.current && mine === seq.current) setLoad({ kind: "ready", data, isNew });
    } catch (e) {
      if (alive.current && mine === seq.current && !isAborted(e)) setLoad({ kind: "fail", state: failState(e) });
    }
  }).current;

  useEffect(() => {
    alive.current = true;
    void reload(false);
    const stream = getApi().events({ onEvent: (e) => { if (isModelsChanged(e)) void reload(true); } });
    const stop = stream.status.subscribe((s) => { setLive(s === "open" ? "on" : s === "unavailable" || s === "closed" ? "off" : "connecting"); });
    return () => { alive.current = false; seq.current++; stop(); stream.close(); };
  }, []);

  const runScan = async (): Promise<void> => {
    if (scan.kind === "running") return;
    setScan({ kind: "running" });
    try {
      const result: ModelsScanResult = await getApi().rpc("models.scan", undefined);
      if (!alive.current) return;
      setScan({ kind: "done", totals: scanTotals(result) });
      await reload(true);
    } catch (e) {
      if (alive.current && !isAborted(e)) setScan({ kind: "error", forbidden: isForbidden(e) });
    }
  };

  const acknowledge = async (): Promise<void> => {
    try { await getApi().rpc("models.acknowledge", undefined); } catch { /* the list below says what is still new */ }
    await reload(true);
  };

  const title = t("nav.models");
  if (load.kind === "loading") return h(Page, { title }, h(PageState, { state: "loading" }));
  if (load.kind === "fail") {
    const state = load.state;
    return h(Page, { title }, h(PageState, state === "error" ? { state, onRetry: () => { void reload(false); } } : { state }));
  }

  const { data, isNew } = load;
  const running = scan.kind === "running";
  const scanButton = h("button", { key: "scan", type: "button", class: "btn btn-primary", "aria-disabled": running, onClick: () => { void runScan(); } }, running ? t("models.scanning") : t("models.scan"));
  const actions = [
    h("button", { key: "refresh", type: "button", class: "btn", onClick: () => { void reload(true); } }, t("models.refresh")),
    h("button", { key: "add", type: "button", class: "btn", onClick: () => setDlg({ kind: "add" }) }, t("models.addManual")),
    scanButton,
  ];
  const dialog = dlg === null ? null
    : dlg.kind === "remove" ? h(RemoveDialog, { model: dlg.model, onClose: () => setDlg(null), onRemoved: () => { setDlg(null); navigate("/models"); void reload(true); } })
    : h(OverrideDialog, { ...(dlg.kind === "edit" ? { model: dlg.model } : {}), onClose: () => setDlg(null), onSaved: () => { setDlg(null); void reload(true); } });
  const liveText = h("p", { class: "lead" }, live === "on" ? t("models.live.on") : live === "connecting" ? t("models.live.connecting") : t("models.live.off"));

  const scanArea = scan.kind === "running" ? h("p", { role: "status", class: "lead" }, t("models.scanProgress"))
    : scan.kind === "done" ? h(ScanResult, { totals: scan.totals })
    : scan.kind === "error" ? h("p", { role: "alert", class: "form-error" }, scan.forbidden ? t("models.scanForbidden") : t("models.scanFailed"))
    : null;

  if (data.models.length === 0) {
    return h(Page, { title, actions },
      scanArea,
      h(PageState, { state: "empty", title: t("models.emptyTitle"), detail: t("models.emptyBody") }, scanButton),
      dialog);
  }

  const route = parseModelRoute(sub);
  const selected = route === null ? null : data.models.find((m) => m.provider === route.provider && m.id === route.id) ?? null;
  const newCount = isNew.size > 0 ? isNew.size : data.newCount;
  return h(Page, { title, lead: t("models.lead"), actions, width: "full" },
    scanArea,
    newCount > 0 ? h("p", {}, h("button", { type: "button", class: "btn", onClick: () => { void acknowledge(); } }, t("models.ack", { count: newCount }))) : null,
    h(ProvidersCard, { data }),
    liveText,
    h(ListDetail, {
      selected: route !== null, listLabel: t("models.listLabel"), detailLabel: t("models.detailLabel"), onBack: () => navigate("/models"),
      list: h(ModelList, { data, isNew, filters, setFilters, selected: route }),
      detail: selected ? h(ModelDetail, { model: selected, isNew: isNew.has(modelKey(selected)), onEdit: () => setDlg({ kind: "edit", model: selected }), onRemove: () => setDlg({ kind: "remove", model: selected }) })
        : h("p", { class: "ld-empty" }, t("models.notFound")),
    }),
    dialog);
}
