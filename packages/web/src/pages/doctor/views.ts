// Presentational pieces of the Doctor page. No data fetching here; everything comes in as props.
import { h, type ComponentChildren } from "preact";
import type { View } from "../../view.ts";
import { Badge, Card, type BadgeTone } from "../../components/card.ts";
import { PageState } from "../../components/page-state.ts";
import { formatDateTime, lang, t, type Key } from "../../i18n.ts";
import { icon, type IconName } from "../../icons.ts";
import { compact } from "../../layout.ts";
import type { Part, Snapshot } from "./data.ts";
import { formatUptime, type Agent, type CoreStatus, type Health, type ModelState } from "./model.ts";

const MAX_DETAIL = 300;

/** The note shown in a card whose data is not there; one text per reason. */
export function PartNote({ kind }: { kind: Exclude<Part<unknown>["kind"], "ok"> }): View {
  const [name, text]: [IconName, Key] = kind === "forbidden" ? ["lock", "doctor.part.forbidden"] : kind === "error" ? ["alert", "doctor.part.error"] : ["unavailable", "doctor.part.unavailable"];
  return h("p", { class: "state-body", "data-part": kind }, icon(name, 16), " ", t(text));
}

// ---- banner ---------------------------------------------------------------------------------------------------------
function degradedCause(core: Part<CoreStatus>, health: Health): string[] {
  if (core.kind === "ok") {
    const d = core.value.engine.degraded;
    if (d) {
      const lines = [t("doctor.banner.degraded.cause", { reason: d.reason, capability: d.capability })];
      if (d.detail) lines.push(t("doctor.banner.degraded.detail", { detail: d.detail.length > MAX_DETAIL ? `${d.detail.slice(0, MAX_DETAIL)}…` : d.detail }));
      return lines;
    }
    if (!core.value.engine.ready) return [t("doctor.banner.degraded.notReady")];
  }
  if (health.core.engineReady === false) return [t("doctor.banner.degraded.notReady")];
  return [t("doctor.banner.degraded.noDetails")];
}

function Notice({ kind, tone, name, title, badge, lines }: { kind: string; tone: BadgeTone; name: IconName; title: string; badge: string; lines: string[] }): View {
  // role=status (polite): a state that is worth knowing but needs no interruption. Icon, heading and text carry the meaning, colour only adds to it.
  return h("div", { class: "card", role: "status", "data-banner": kind },
    h("div", { class: "card-head" }, h("h2", { class: "card-title" }, icon(name, 20), " ", title), h(Badge, { tone }, badge)),
    lines.map((l) => h("p", { key: l }, l)));
}

/** The one banner on top of the page: ok, degraded (with cause), down (alert) or unknown (no health route). */
export function Banner({ snap }: { snap: Snapshot }): View | null {
  const hp = snap.health;
  if (hp.kind === "forbidden") return null;
  if (hp.kind === "down" || (hp.kind === "ok" && hp.value.status === "down")) {
    return h("div", { "data-banner": "down" }, h(PageState, { state: "error", title: t("doctor.banner.down.title"), detail: t("doctor.banner.down.body") }));
  }
  if (hp.kind !== "ok") return h(Notice, { kind: "unknown", tone: "neutral", name: "unavailable", title: t("doctor.banner.unknown.title"), badge: t("doctor.badge.unknown"), lines: [t("doctor.banner.unknown.body")] });
  if (hp.value.status === "degraded") {
    return h(Notice, { kind: "degraded", tone: "warn", name: "alert", title: t("doctor.banner.degraded.title"), badge: t("doctor.badge.degraded"), lines: [...degradedCause(snap.core, hp.value), t("doctor.banner.degraded.body")] });
  }
  return h(Notice, { kind: "ok", tone: "ok", name: "doctor", title: t("doctor.banner.ok.title"), badge: t("doctor.badge.ok"), lines: [t("doctor.banner.ok.body")] });
}

// ---- key/value cards ------------------------------------------------------------------------------------------------
function Facts({ rows }: { rows: [string, ComponentChildren][] }): View {
  return h("dl", { class: "facts" }, rows.map(([k, v]) => h("div", { key: k }, h("dt", null, k), h("dd", null, v))));
}
const yesNo = (b: boolean): string => t(b ? "doctor.yes" : "doctor.no");

/** `down`: the core is not reachable, so only what the API itself knows (its version) is shown. */
export function HealthCard({ health, down = false }: { health: Health; down?: boolean }): View {
  const loc = lang.value;
  const c = health.core;
  const none = t("doctor.none");
  if (down) return h(Card, { title: t("doctor.health.title") }, h(Facts, { rows: [[t("doctor.health.api"), health.apiVersion]] }));
  return h(Card, { title: t("doctor.health.title") },
    h(Facts, { rows: [
      [t("doctor.health.api"), health.apiVersion],
      [t("doctor.health.rpc"), c.rpc ?? none],
      [t("doctor.health.contract"), c.contract ?? none],
      [t("doctor.health.uptime"), c.uptimeMs === undefined ? none : formatUptime(c.uptimeMs, loc)],
      [t("doctor.health.engine"), c.engineReady === undefined ? none : yesNo(c.engineReady)],
    ] }));
}

const PROCESS_KEYS: Record<string, Key> = {
  starting: "doctor.process.starting", ready: "doctor.process.ready", degraded: "doctor.process.degraded", orphaned: "doctor.process.orphaned",
  stopping: "doctor.process.stopping", stopped: "doctor.process.stopped", crashed: "doctor.process.crashed",
};
const MODEL_KEYS: Record<ModelState["state"], Key> = { loading: "doctor.model.loading", ready: "doctor.model.ready", failed: "doctor.model.failed", disabled: "doctor.model.disabled" };
const modelText = (m: ModelState): string => (m.warming ? t("doctor.core.warming", { state: t(MODEL_KEYS[m.state]) }) : t(MODEL_KEYS[m.state]));

/** Core details from the assumed `core.status` RPC. Pid, instance id and error texts are left out on purpose. */
export function CoreCard({ core }: { core: Part<CoreStatus> }): View {
  if (core.kind !== "ok") return h(Card, { title: t("doctor.core.title") }, h(PartNote, { kind: core.kind }));
  const { process, engine } = core.value;
  const key = PROCESS_KEYS[process.state];
  const rows: [string, ComponentChildren][] = [[t("doctor.core.process"), key ? t(key) : t("doctor.process.other", { state: process.state })]];
  if (engine.models) rows.push([t("doctor.core.embedder"), modelText(engine.models.embedder)], [t("doctor.core.reranker"), modelText(engine.models.reranker)]);
  if (engine.storeSchema) {
    const s = engine.storeSchema;
    rows.push([t("doctor.core.store"), s.current === null ? t("doctor.core.storeNone", { expected: s.expected }) : t("doctor.core.storeValue", { current: s.current, expected: s.expected })]);
  }
  if (engine.sharedMemory) rows.push([t("doctor.core.shared"), engine.sharedMemory.supported ? t("doctor.core.sharedOn", { mode: engine.sharedMemory.mode }) : t("doctor.core.sharedOff")]);
  return h(Card, { title: t("doctor.core.title") }, h(Facts, { rows }));
}

// ---- tables (lists when compact) ------------------------------------------------------------------------------------
export type Col<R> = { head: string; cell: (r: R) => ComponentChildren };

/** A real table at normal and wide widths; in compact one list item per row with the column heads as labels, so the page never scrolls sideways. */
export function DataTable<R>({ label, cols, rows, rowKey }: { label: string; cols: Col<R>[]; rows: R[]; rowKey: (r: R) => string }): View {
  if (compact.value) {
    return h("ul", { class: "plain-list", "aria-label": label },
      rows.map((r) => h("li", { key: rowKey(r), class: "card" },
        h("dl", { class: "facts" }, cols.map((c) => h("div", { key: c.head }, h("dt", null, c.head), h("dd", null, c.cell(r))))))));
  }
  return h("table", { class: "data-table", "aria-label": label },
    h("thead", null, h("tr", null, cols.map((c) => h("th", { key: c.head, scope: "col" }, c.head)))),
    h("tbody", null, rows.map((r) => h("tr", { key: rowKey(r) }, cols.map((c) => h("td", { key: c.head }, c.cell(r)))))));
}

export function AgentsCard({ agents }: { agents: Part<Agent[]> }): View {
  const title = t("doctor.agents.title");
  if (agents.kind !== "ok") return h(Card, { title }, h(PartNote, { kind: agents.kind }));
  if (agents.value.length === 0) return h(Card, { title }, h("p", null, t("doctor.agents.empty")));
  const cols: Col<Agent>[] = [
    { head: t("doctor.agents.col.agent"), cell: (a) => a.agentId },
    { head: t("doctor.agents.col.open"), cell: (a) => yesNo(a.open) },
    { head: t("doctor.agents.col.activity"), cell: (a) => t(`doctor.activity.${a.activity.state}`) },
    { head: t("doctor.agents.col.since"), cell: (a) => formatDateTime(new Date(a.activity.since)) },
    { head: t("doctor.agents.col.phase"), cell: (a) => (a.activity.phase ? t(`doctor.phase.${a.activity.phase}`) : t("doctor.none")) },
  ];
  return h(Card, { title }, h(DataTable<Agent>, { label: t("doctor.agents.table"), cols, rows: agents.value, rowKey: (a) => a.agentId }));
}
