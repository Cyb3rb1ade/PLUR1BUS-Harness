// The audit-trail status card at the top of the Activity tab: verified, failed, unavailable (and the not-allowed / not-checked
// variants), when it was last checked and a button to check again. The status is announced politely when it changes.
import { h } from "preact";
import type { View } from "../../../view.ts";
import { Badge, Card, type BadgeTone } from "../../../components/card.ts";
import { formatDateTime, formatNumber, t, type Key } from "../../../i18n.ts";
import type { VerifyState } from "./data.ts";

const SHOWN_FINDINGS = 5;

function variant(s: VerifyState): { tone: BadgeTone; label: Key; detail: string; id: string } {
  if (s.status === "checking") return { tone: "neutral", label: "activity.verify.checking", detail: "", id: "checking" };
  if (s.status === "fail") {
    if (s.kind === "forbidden") return { tone: "neutral", label: "activity.verify.forbidden", detail: t("activity.verify.forbiddenDetail"), id: "forbidden" };
    if (s.kind === "unavailable") return { tone: "neutral", label: "activity.verify.unavailable", detail: t("activity.verify.unavailableDetail"), id: "unavailable" };
    return { tone: "warn", label: "activity.verify.error", detail: t("activity.verify.errorDetail"), id: "error" };
  }
  const r = s.result;
  return r.ok
    ? { tone: "ok", label: "activity.verify.ok", detail: t("activity.verify.okDetail", { records: formatNumber(r.records), files: formatNumber(r.files), seq: formatNumber(r.lastSeq) }), id: "verified" }
    : { tone: "err", label: "activity.verify.failed", detail: t("activity.verify.failedDetail", { n: formatNumber(r.findingsTotal) }), id: "failed" };
}

export function VerifyCard({ state, onVerify }: { state: VerifyState; onVerify: () => void }): View {
  const v = variant(state);
  const busy = state.status === "checking";
  const findings = state.status === "done" && !state.result.ok ? state.result.findings : [];
  const hidden = state.status === "done" ? Math.max(0, state.result.findingsTotal - Math.min(findings.length, SHOWN_FINDINGS)) : 0;
  return h(Card, { title: t("activity.verify.title") },
    h("div", { class: "verify", "data-verify": v.id },
      h("p", { class: "verify-status", role: "status" }, h(Badge, { tone: v.tone }, t(v.label)), v.detail ? h("span", {}, " ", v.detail) : null),
      findings.length > 0 ? h("ul", { class: "plain-list verify-findings" }, findings.slice(0, SHOWN_FINDINGS).map((f, i) =>
        h("li", { key: i }, h("code", {}, f.line === null ? t("activity.verify.finding", { code: f.code, file: f.file }) : t("activity.verify.findingLine", { code: f.code, file: f.file, line: f.line }))))) : null,
      hidden > 0 ? h("p", { class: "field-hint" }, t("activity.verify.moreFindings", { n: formatNumber(hidden) })) : null,
      h("div", { class: "verify-foot" },
        state.status !== "checking" ? h("span", { class: "field-hint" }, t("activity.verify.last", { time: formatDateTime(new Date(state.at)) })) : null,
        state.status === "fail" && state.kind === "forbidden" ? null
          : h("button", { type: "button", class: "btn", disabled: busy, "aria-disabled": busy, "aria-label": t("activity.verify.againFor"), onClick: () => { if (!busy) onVerify(); } }, t("activity.verify.again")))));
}
