import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card } from "../../components/card.ts";
import { PageLoading } from "../../components/page-state.ts";
import { currentRole, getApi, roleIn, useLoad } from "../common/load.ts";
import { t, type Key } from "../../i18n.ts";
type Check = { id: string; status: "ok" | "warn" | "fail" | "skipped"; summary: string; repair?: { label: string } };
type Report = { generatedAt: string; groups: { id: string; title: string; checks: Check[] }[] };
export function DoctorReportCard(): View {
  const { state, reload } = useLoad(async signal => await getApi().rpc("doctor.report", {}, { write: false, signal }) as Report, []);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = async (): Promise<void> => {
    setBusy(true); setFailed(false);
    try { await getApi().rpc("doctor.report", { refresh: true }); reload(); } catch { setFailed(true); } finally { setBusy(false); }
  };
  let body: View;
  if (state.status === "loading") body = h(PageLoading, { label: t("state.loading") });
  else if (state.status === "fail") body = h("p", { role: "status" }, t("doctor.report.unavailable"));
  else body = h("div", {}, state.data.groups.map(group => h("section", { key: group.id, "aria-label": group.id === "provisioning" ? t("doctor.prov.title") : group.title },
    h("ul", { class: "plain-list" }, group.checks.map(check => h("li", { key: check.id },
      h(Badge, { tone: check.status === "ok" ? "ok" : check.status === "fail" ? "err" : check.status === "warn" ? "warn" : "neutral" }, t(`doctor.report.status.${check.status}` as Key)),
      ` ${check.id}: ${check.summary}`, check.repair ? h("p", {}, check.repair.label) : null))))));
  return h(Card, { title: t("doctor.report.title") }, body,
    roleIn(currentRole(), ["owner", "admin", "operator"]) ? h("button", { type: "button", class: "btn", disabled: busy, onClick: () => { void refresh(); } }, t("doctor.report.refresh")) : null,
    failed ? h("p", { role: "alert" }, t("doctor.report.refreshFailed")) : null);
}
