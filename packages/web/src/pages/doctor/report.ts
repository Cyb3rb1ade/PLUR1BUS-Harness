import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card } from "../../components/card.ts";
import { PageLoading } from "../../components/page-state.ts";
import { currentRole, getApi, roleIn, useLoad } from "../common/load.ts";
import { t, type Key } from "../../i18n.ts";
type Check = { id: string; status: "ok" | "warn" | "fail" | "skipped"; summary: string; repair?: { label: string } };
export type Report = { groups: { id: string; title: string; checks: Check[] }[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STATUS = ["ok", "warn", "fail", "skipped"] as const;

/** Reads the doctor.report answer defensively: a shape that is not the documented one is `null` (the card then says the report is
 *  unavailable instead of failing to draw), a check without an id or summary is dropped, and a status this page has no text for
 *  (an "info" a newer core might send) is shown as skipped. */
export function parseReport(v: unknown): Report | null {
  if (!isObj(v) || !Array.isArray(v.groups)) return null;
  const groups: Report["groups"] = [];
  for (const g of v.groups) {
    if (!isObj(g) || typeof g.id !== "string" || !Array.isArray(g.checks)) continue;
    const checks: Check[] = [];
    for (const c of g.checks) {
      if (!isObj(c) || typeof c.id !== "string" || typeof c.summary !== "string") continue;
      const status = (STATUS as readonly unknown[]).includes(c.status) ? (c.status as Check["status"]) : "skipped";
      const label = isObj(c.repair) && typeof c.repair.label === "string" ? c.repair.label : null;
      checks.push({ id: c.id, status, summary: c.summary, ...(label === null ? {} : { repair: { label } }) });
    }
    groups.push({ id: g.id, title: typeof g.title === "string" ? g.title : g.id, checks });
  }
  return { groups };
}
export function DoctorReportCard(): View {
  const { state, reload } = useLoad(async signal => parseReport(await getApi().rpc("doctor.report", {}, { write: false, signal })), []);
  const inflight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = async (): Promise<void> => {
    // `busy` is state and only disables the button after the next draw; a second click in the same tick would send a second
    // refresh, which the server refuses (30 s limit) and the card would then report as a failure of the first.
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true); setFailed(false);
    try { await getApi().rpc("doctor.report", { refresh: true }); reload(); } catch { setFailed(true); } finally { inflight.current = false; setBusy(false); }
  };
  let body: View;
  if (state.status === "loading") body = h(PageLoading, { label: t("state.loading") });
  else if (state.status === "fail" || state.data === null) body = h("p", { role: "status" }, t("doctor.report.unavailable"));
  else body = h("div", {}, state.data.groups.map(group => h("section", { key: group.id, "aria-label": group.id === "provisioning" ? t("doctor.prov.title") : group.title },
    h("ul", { class: "plain-list" }, group.checks.map(check => h("li", { key: check.id },
      h(Badge, { tone: check.status === "ok" ? "ok" : check.status === "fail" ? "err" : check.status === "warn" ? "warn" : "neutral" }, t(`doctor.report.status.${check.status}` as Key)),
      ` ${check.id}: ${check.summary}`, check.repair ? h("p", {}, check.repair.label) : null))))));
  return h(Card, { title: t("doctor.report.title") }, body,
    roleIn(currentRole(), ["owner", "admin", "operator"]) ? h("button", { type: "button", class: "btn", disabled: busy, onClick: () => { void refresh(); } }, t("doctor.report.refresh")) : null,
    failed ? h("p", { role: "alert" }, t("doctor.report.refreshFailed")) : null);
}
