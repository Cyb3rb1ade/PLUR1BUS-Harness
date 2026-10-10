// Approvals Page: approval.list, approval.get, approval.decide, approval.cancel, grant.list, grant.revoke.
// Strict D109 layout: Capability, Tool, Targets, Action Hash, Summary, Options before Agent Rationale.
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card, type BadgeTone } from "../../components/card.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { Tabs } from "../../components/tabs.ts";
import { t, type Key } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as area from "../../i18n/approvals.ts";
import { FailureState } from "../common/states.ts";
import { currentRole, getApi, roleIn, useLoad } from "../common/load.ts";
import type { PageProps } from "../registry.ts";
import { attestationText } from "../../attestation-text.ts";
import type {
  ApprovalRecord,
  GrantRecord,
  ApprovalRisk,
  GrantScopeName,
} from "../common/surfaces-rpc.ts";

import "../../styles/approvals.css";

registerArea("approvals", area);

function riskTone(risk?: ApprovalRisk): BadgeTone {
  switch (risk) {
    case "low":
      return "ok";
    case "medium":
      return "warn";
    case "high":
    case "critical":
      return "err";
    default:
      return "neutral";
  }
}

function ApprovalCard({
  approval,
  canDecide,
  onDecided,
}: {
  approval: ApprovalRecord;
  canDecide: boolean;
  onDecided: () => void;
}): View {
  const options = approval.grantOptions ?? [{ scope: "once", requiredSurface: 1 }];
  const [selectedScope, setSelectedScope] = useState<GrantScopeName>(options[0]?.scope ?? "once");
  const [delegable, setDelegable] = useState(approval.delegable ?? false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [attestNeeded, setAttestNeeded] = useState(false);

  const decide = async (decision: "approve" | "deny", withAttest = false): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await getApi().rpc("approval.decide", {
        id: approval.id,
        decision,
        scope: selectedScope,
        delegable,
        ...(withAttest ? { attest: true } : {}),
      });
      setAttestNeeded(false);
      onDecided();
    } catch (e) {
      const errObj = (typeof e === "object" && e !== null ? e : {}) as {
        error?: string | null;
        reason?: string;
        errorCode?: string;
        detail?: string;
        message?: string;
      };
      const att = attestationText({
        error: errObj.error ?? errObj.errorCode ?? null,
        reason: errObj.reason,
        detail: errObj.detail,
      });
      if (errObj.reason === "attestation-required") {
        setAttestNeeded(true);
        setNotice(att || "OS confirmation required.");
      } else if (att) {
        setNotice(att);
      } else {
        setNotice(errObj.message || t("approvals.attest.failed"));
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await getApi().rpc("approval.cancel", { id: approval.id });
      onDecided();
    } catch (e) {
      const errObj = (typeof e === "object" && e !== null ? e : {}) as { message?: string };
      setNotice(errObj.message || "Could not cancel approval.");
    } finally {
      setBusy(false);
    }
  };

  return h(
    "article",
    { class: "approval-card-d109", "aria-labelledby": `approval-title-${approval.id}` },
    h(
      "div",
      { class: "approval-card-head" },
      h(
        "div",
        null,
        h("h2", { id: `approval-title-${approval.id}`, class: "approval-card-title" }, `${approval.subject.id}: ${approval.capability}`),
        h(
          "div",
          { class: "chip-row" },
          h(Badge, { tone: riskTone(approval.risk) }, `${t("approvals.card.risk")}: ${approval.risk ?? "unknown"}`),
          h(
            Badge,
            { tone: approval.reversible ? "ok" : "warn" },
            `${t("approvals.card.reversible")}: ${approval.reversible ? t("approvals.card.yes") : t("approvals.card.no")}`,
          ),
          approval.requiredSurface !== undefined
            ? h(Badge, { tone: "neutral" }, `T${approval.requiredSurface}`)
            : null,
        ),
      ),
      h("span", { class: "approval-hash" }, `Hash: ${approval.actionHash.slice(0, 16)}…`),
    ),
    h(
      "div",
      { class: "approval-card-grid" },
      h(
        "div",
        null,
        h("span", { class: "approval-field-label" }, t("approvals.card.capability")),
        h("span", null, approval.capability),
      ),
      approval.tool
        ? h(
            "div",
            null,
            h("span", { class: "approval-field-label" }, t("approvals.card.tool")),
            h("span", null, approval.tool),
          )
        : null,
      h(
        "div",
        null,
        h("span", { class: "approval-field-label" }, t("approvals.card.actionHash")),
        h("span", { class: "approval-hash" }, approval.actionHash),
      ),
    ),
    // D109 Ordering requirement: Targets and Summary MUST be displayed BEFORE Agent Reason
    approval.targets && approval.targets.length > 0
      ? h(
          "div",
          null,
          h("span", { class: "approval-field-label" }, t("approvals.card.targets")),
          h(
            "ul",
            { class: "plain-list approval-targets" },
            approval.targets.map((tgt) => h("li", { key: tgt }, tgt)),
          ),
        )
      : null,
    approval.summary
      ? h(
          "div",
          null,
          h("span", { class: "approval-field-label" }, t("approvals.card.summary")),
          h("pre", { class: "approval-summary" }, approval.summary),
        )
      : null,
    // Agent Rationale (unverified) placed LAST among content
    approval.agentReason
      ? h(
          "div",
          { class: "approval-reason-unverified" },
          h("span", { class: "approval-field-label" }, t("approvals.card.agentReason")),
          h("p", null, approval.agentReason),
        )
      : null,
    // Grant Options and Actions
    canDecide && approval.status === "pending"
      ? h(
          "div",
          { class: "approval-decision-bar" },
          h(
            "div",
            { class: "chip-row" },
            h("label", { for: `scope-select-${approval.id}`, class: "approval-field-label" }, t("approvals.card.options")),
            h(
              "select",
              {
                id: `scope-select-${approval.id}`,
                class: "approval-scope-select",
                value: selectedScope,
                onChange: (e: Event) => setSelectedScope((e.target as HTMLSelectElement).value as GrantScopeName),
              },
              options.map((opt) =>
                h(
                  "option",
                  { key: opt.scope, value: opt.scope },
                  t(
                    opt.scope === "once"
                      ? "approvals.scope.once"
                      : opt.scope === "task"
                      ? "approvals.scope.task"
                      : opt.scope === "session"
                      ? "approvals.scope.session"
                      : "approvals.scope.always",
                  ),
                ),
              ),
            ),
            h(
              "label",
              { class: "checkbox-label" },
              h("input", {
                type: "checkbox",
                checked: delegable,
                onChange: (e: Event) => setDelegable((e.target as HTMLInputElement).checked),
              }),
              " ",
              t("approvals.card.delegable"),
            ),
          ),
          notice
            ? h("div", { class: "form-notice", role: "status", "aria-live": "polite" }, notice)
            : null,
          h(
            "div",
            { class: "approval-actions" },
            attestNeeded
              ? h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn-primary",
                    disabled: busy,
                    onClick: () => { void decide("approve", true); },
                  },
                  t("approvals.action.approve"),
                )
              : h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn-primary",
                    disabled: busy,
                    onClick: () => { void decide("approve", false); },
                  },
                  t("approvals.action.approve"),
                ),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-err",
                disabled: busy,
                onClick: () => { void decide("deny", false); },
              },
              t("approvals.action.deny"),
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-quiet",
                disabled: busy,
                onClick: () => { void cancel(); },
              },
              t("approvals.action.cancel"),
            ),
          ),
        )
      : null,
  );
}

function GrantsList(): View {
  const { state, reload } = useLoad(
    (signal) => getApi().rpc("grant.list", {}, { write: false, signal }) as Promise<{ grants?: GrantRecord[] } | GrantRecord[]>,
    []
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail")
    return h(FailureState, { failure: state.failure, onRetry: reload });

  const raw = state.data;
  const grants: GrantRecord[] = Array.isArray(raw) ? raw : (raw as { grants?: GrantRecord[] }).grants ?? [];

  const revoke = async (id: string): Promise<void> => {
    setBusy(true);
    setNotice("");
    try {
      await getApi().rpc("grant.revoke", { id });
      reload();
    } catch (e) {
      const errObj = (typeof e === "object" && e !== null ? e : {}) as { message?: string };
      setNotice(errObj.message || "Revoke failed.");
    } finally {
      setBusy(false);
    }
  };

  if (grants.length === 0) {
    return h(PageState, { state: "empty", title: t("approvals.empty.grants") });
  }

  return h(
    "div",
    null,
    notice ? h("p", { class: "form-notice", role: "status", "aria-live": "polite" }, notice) : null,
    h(
      "table",
      { class: "grants-table" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", null, t("approvals.grant.id")),
          h("th", null, t("approvals.grant.agent")),
          h("th", null, t("approvals.grant.capability")),
          h("th", null, t("approvals.grant.scope")),
          h("th", null, t("approvals.grant.state")),
          h("th", null, t("approvals.grant.expires")),
          h("th", null, t("recurring.col.action")),
        ),
      ),
      h(
        "tbody",
        null,
        grants.map((g) =>
          h(
            "tr",
            { key: g.id },
            h("td", null, h("code", null, g.id.slice(0, 12))),
            h("td", null, g.agent),
            h("td", null, g.capability),
            h("td", null, g.scope),
            h(
              "td",
              null,
              h(
                Badge,
                { tone: g.state === "active" ? "ok" : g.state === "suspended" ? "warn" : "neutral" },
                g.state,
              ),
            ),
            h("td", null, g.expiresAt ?? "—"),
            h(
              "td",
              null,
              g.state === "active"
                ? h(
                    "button",
                    {
                      type: "button",
                      class: "btn btn-quiet",
                      disabled: busy,
                      onClick: () => { void revoke(g.id); },
                    },
                    t("approvals.action.revoke"),
                  )
                : null,
            ),
          ),
        ),
      ),
    ),
  );
}

function PendingApprovalsList(): View {
  const role = currentRole();
  const canDecide = roleIn(role, ["owner", "admin"]);
  const { state, reload } = useLoad(
    (signal) =>
      getApi().rpc("approval.list", { status: "pending" }, { write: false, signal }) as Promise<{ approvals?: ApprovalRecord[] } | ApprovalRecord[]>,
    []
  );

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail")
    return h(FailureState, { failure: state.failure, onRetry: reload });

  const raw = state.data;
  const approvals: ApprovalRecord[] = Array.isArray(raw) ? raw : (raw as { approvals?: ApprovalRecord[] }).approvals ?? [];

  if (approvals.length === 0) {
    return h(PageState, { state: "empty", title: t("approvals.empty.pending") });
  }

  return h(
    "div",
    null,
    approvals.map((apr) =>
      h(ApprovalCard, {
        key: apr.id,
        approval: apr,
        canDecide,
        onDecided: reload,
      })
    ),
  );
}

function ApprovalsContent(): View {
  const [tab, setTab] = useState<string>("pending");

  return h(
    "div",
    { class: "approvals-page" },
    h(Tabs, {
      label: t("approvals.title"),
      selected: tab,
      onSelect: (k: string) => setTab(k),
      tabs: [
        { id: "pending", label: t("approvals.tab.pending"), panel: h(PendingApprovalsList, null) },
        { id: "grants", label: t("approvals.tab.grants"), panel: h(GrantsList, null) },
      ],
    }),
  );
}

export function ApprovalsPage(): View {
  const role = currentRole();
  // Role gate: Refused for agent principals; Human Owner/Admin/Operator can view; Operator cannot decide.
  const allowed = roleIn(role, ["owner", "admin", "operator"]);
  return h(
    Page,
    { title: t("approvals.title"), lead: t("approvals.intro"), width: "full" },
    allowed ? h(ApprovalsContent, null) : h(PageState, { state: "forbidden" }),
  );
}
