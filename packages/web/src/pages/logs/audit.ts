// Owner/Admin audit section: cached writer health and an explicit, read-only chain verification. Recovery stays in the CLI.
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card } from "../../components/card.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { formatDateTime, formatNumber, t } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as area from "../../i18n/audit.ts";
import { currentRole, failureOf, getApi, useLoad, type Failure } from "../common/load.ts";
import { FailureState } from "../common/states.ts";
import { parseHealth, parseVerification, type Finding, type Health, type Note, type Verification } from "./audit/model.ts";
import "../../styles/audit.css";

registerArea("audit", area);
const when = (at: number | null): string => at === null ? t("audit.unknown") : formatDateTime(new Date(at));
const number = (value: number | null): string => value === null ? t("audit.unknown") : formatNumber(value);
const note = (value: Note | null): string => value === null ? t("audit.unknown") : t("audit.note", { time: when(value.at), user: value.actor?.user ?? t("audit.unknown"), host: value.actor?.host ?? t("audit.unknown") });
const finding = (f: Finding): string => t("audit.finding", { code: f.code, file: f.file, line: number(f.line), seq: number(f.seq) });
type Check = { status: "idle" } | { status: "busy" } | { status: "fail"; failure: Failure } | { status: "done"; result: Verification; at: number };

export function AuditSection(): View {
  const role = currentRole();
  // Like Break-glass, unknown roles and agent principals fail closed before mounting any RPC hook.
  if (role !== "owner" && role !== "admin") return h(PageState, { state: "forbidden" });
  return h(AuditContent, {});
}
function AuditContent(): View {
  const { state, reload } = useLoad(async (signal) => parseHealth(await getApi().rpc("core.status", undefined, { write: false, signal })), []);
  const [check, setCheck] = useState<Check>({ status: "idle" });
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => { inFlight.current?.abort(); }, []);
  const verify = async (): Promise<void> => {
    if (inFlight.current) return;
    const ctl = new AbortController();
    inFlight.current = ctl; setCheck({ status: "busy" });
    try {
      const result = parseVerification(await getApi().rpc("audit.verify", {}, { write: false, signal: ctl.signal }));
      if (!ctl.signal.aborted) { setCheck({ status: "done", result, at: Date.now() }); reload(); }
    } catch (e) {
      if (!ctl.signal.aborted) setCheck({ status: "fail", failure: failureOf(e) });
    } finally { if (inFlight.current === ctl) inFlight.current = null; }
  };
  return h("section", { class: "audit", "aria-labelledby": "audit-title" },
    h("h2", { id: "audit-title" }, t("audit.title")),
    h(Card, { title: t("audit.health"), level: 3, aside: h("button", { type: "button", class: "btn", onClick: reload }, t("audit.refresh")) },
      h("p", { class: "field-hint" }, t("audit.healthScope")),
      state.status === "loading" ? h(PageLoading, { label: t("state.loading") }) : state.status === "fail" ? h(FailureState, { failure: state.failure, onRetry: reload })
        : state.data === null ? h(PageState, { state: "unavailable" }) : h(HealthView, { health: state.data })),
    h(Card, { title: t("audit.verifyTitle"), level: 3 },
      h("div", { class: "audit-verification", "aria-busy": check.status === "busy" },
        h("p", { class: "field-hint" }, t("audit.verifyScope")),
        check.status === "fail" ? h(FailureState, { failure: check.failure })
          : check.status === "done" ? h(VerificationView, { result: check.result, at: check.at })
            : h("p", { role: "status" }, t(check.status === "busy" ? "audit.checking" : "audit.unchecked")),
        h("button", { class: "btn", type: "button", disabled: check.status === "busy", onClick: () => { void verify(); } }, t("audit.verifyButton")))),
    h(Card, { title: t("audit.localRepair"), level: 3 },
      h("p", {}, t("audit.localHelp")), h("pre", { class: "audit-command" }, h("code", {}, t("audit.localCommand"))), h("p", { class: "field-hint" }, t("audit.localEffect"))));
}
function HealthView({ health: a }: { health: Health }): View {
  return h("div", {},
    h("p", { role: "status" }, h(Badge, { tone: a.state === "ok" ? "ok" : "err" }, t(a.state === "ok" ? "audit.accepting" : "audit.refusing"))),
    h("dl", { class: "audit-facts" },
      h("div", {}, h("dt", {}, t("audit.observed")), h("dd", {}, when(a.observedAt))),
      h("div", {}, h("dt", {}, t("audit.verifiedAt")), h("dd", {}, a.lastVerifiedAt === null ? t("audit.neverVerified") : when(a.lastVerifiedAt))),
      h("div", {}, h("dt", {}, t("audit.lastSeq")), h("dd", {}, number(a.lastSeq))),
      a.reason === null ? null : h("div", {}, h("dt", {}, t("audit.reason")), h("dd", {}, h("code", {}, a.reason))),
      h("div", {}, h("dt", {}, t("audit.anchorAdvanced")), h("dd", {}, note(a.lastAnchorAdvanced))),
      h("div", {}, h("dt", {}, t("audit.reanchored")), h("dd", {}, note(a.lastReanchor)))),
    h("h4", {}, t("audit.pending")),
    h("p", {}, t("audit.pendingCount", { count: formatNumber(a.pendingLines), dropped: formatNumber(a.pendingDropped) })),
    h("p", { class: "field-hint" }, t("audit.pendingScope")),
    a.pending.length === 0 ? h("p", {}, t("audit.noPending"))
      : h("ul", { class: "plain-list audit-pending" }, a.pending.map((p, i) => h("li", { key: i },
        h("strong", {}, p.action), h("span", {}, note(p)), p.reason === null ? null : h("code", {}, p.reason)))));
}
function VerificationView({ result: r, at }: { result: Verification; at: number }): View {
  const findings = r.findings.slice(0, 20);
  return h("div", {},
    h("p", { role: "status" }, h(Badge, { tone: r.ok ? "ok" : "err" }, t(r.ok ? "audit.currentOk" : "audit.currentBad"))),
    h("p", {}, t("audit.result", { records: formatNumber(r.records), files: formatNumber(r.files), seq: formatNumber(r.lastSeq) })),
    h("p", {}, t("audit.anchor", { status: r.anchor.status, seq: number(r.anchor.seq) })),
    h("p", { class: "field-hint" }, t("audit.checkedAt", { time: when(at) })),
    findings.length ? h("ul", { class: "plain-list audit-findings" }, findings.map((f, i) => h("li", { key: i }, h("code", {}, finding(f))))) : null,
    r.findingsTotal > findings.length ? h("p", {}, t("audit.moreFindings", { count: formatNumber(r.findingsTotal - findings.length) })) : null,
    h("h4", {}, t("audit.eras")),
    r.reanchors === null || r.previousChains === null ? h("p", {}, t("audit.noEraMetadata")) : null,
    r.reanchors?.length === 0 && r.previousChains?.length === 0 ? h("p", {}, t("audit.noEras")) : null,
    h("ul", { class: "plain-list audit-eras" },
      r.reanchors?.map((b, i) => h("li", { key: `boundary-${i}` },
        h("strong", {}, t("audit.boundary", { seq: formatNumber(b.seq) })),
        h("span", {}, t("audit.boundaryFile", { file: b.file, line: formatNumber(b.line), time: when(b.at) })), b.suffix === null ? null : h("code", {}, b.suffix))),
      r.previousChains?.map((e) => h("li", { key: e.suffix },
        h("code", {}, e.suffix), h(Badge, { tone: e.intact ? "ok" : "warn" }, t(e.intact ? "audit.eraIntact" : "audit.eraBroken")),
        h("strong", {}, t("audit.validThrough", { seq: formatNumber(e.lastSeq) })),
        h("span", {}, t("audit.result", { records: formatNumber(e.records), files: formatNumber(e.files), seq: formatNumber(e.lastSeq) })),
        h("span", {}, t("audit.anchor", { status: e.anchor.status, seq: number(e.anchor.seq) })),
        e.firstBreak === null ? null : h("code", {}, finding(e.firstBreak)),
        e.announced ? null : h("p", { class: "field-hint" }, t("audit.unannounced"))))));
}
