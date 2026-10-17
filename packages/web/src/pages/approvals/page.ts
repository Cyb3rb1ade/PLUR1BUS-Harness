// Approvals Page: approval.list, approval.get, approval.decide, approval.cancel, grant.list, grant.revoke.
// Strict D109 layout: Capability, Tool, Targets, Action Hash, Summary, Options before Agent Rationale.
import { h } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card, type BadgeTone } from "../../components/card.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { Tabs } from "../../components/tabs.ts";
import { formatDateTime, t, type Key } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as area from "../../i18n/approvals.ts";
import { FailureState } from "../common/states.ts";
import { loadSecurityLimits } from "../settings/security/limits.ts";
import { currentRole, failureOf, getApi, roleIn, useLoad } from "../common/load.ts";
import { maskSecrets } from "./mask.ts";
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


type DecisionKind = "approved" | "denied" | "cancelled" | "revoked";
const FAILED: Record<"decide" | "cancel" | "revoke", Key> = { decide: "approvals.error.decide", cancel: "approvals.error.cancel", revoke: "approvals.error.revoke" };

/** The sentence for a refused or failed call. Server text never reaches the page: it can carry hosts, paths and stack lines. */
function failureSentence(e: unknown, what: "decide" | "cancel" | "revoke"): { text: string; stale: boolean } {
  const o = (typeof e === "object" && e !== null ? e : {}) as { reason?: unknown; errorCode?: unknown };
  const reason = typeof o.reason === "string" ? o.reason : "";
  if (o.errorCode === "E_NOT_FOUND" || reason === "approval-used" || reason === "approval-expired") return { text: t("approvals.error.stale"), stale: true };
  if (o.errorCode === "E_DENIED" || failureOf(e).kind === "forbidden") return { text: t("approvals.error.forbidden"), stale: false };
  return { text: t(FAILED[what]), stale: false };
}

/** After a list changed under the focus (the clicked card or row is gone): put the focus back inside the panel, on the first card's title when there is one. */
function restoreFocus(box: HTMLElement | null): void {
  if (!box || box.contains(document.activeElement)) return;
  const panel = box.closest<HTMLElement>("[role=tabpanel]");
  if (panel?.contains(document.activeElement) && document.activeElement !== panel) return;
  (box.querySelector<HTMLElement>("article h2") ?? panel)?.focus();
}

/** A text that is shown with credential-looking parts hidden; `hidden` tells the card to say so once. */
function shown(s: string): string { return maskSecrets(s); }

function ApprovalCard({
  approval,
  canDecide,
  onDecided, onStale, maxGrantDays,
}: {
  approval: ApprovalRecord;
  canDecide: boolean;
  maxGrantDays?: number;
  onDecided: (kind: DecisionKind) => void;
  onStale: () => void;
}): View {
  const confirmation = approval.osConfirmation;
  const masked = [approval.summary, approval.agentReason, ...(approval.targets ?? [])].some((x) => x !== undefined && maskSecrets(x) !== x);
  const options = approval.grantOptions ?? [{ scope: "once", requiredSurface: 1 }];
  const [selectedScope, setSelectedScope] = useState<GrantScopeName>(options[0]?.scope ?? "once");
  const [delegable, setDelegable] = useState(approval.delegable ?? false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [attestNeeded, setAttestNeeded] = useState(false);
  // `busy` only reaches the buttons after the next render, so a second click in the same task would still see false. The lock
  // also stays shut after a decision went through, until the reloaded list hands this card a new record (or removes it).
  const lock = useRef(false);
  useEffect(() => { lock.current = false; setBusy(false); }, [approval]);

  const act = async (what: "decide" | "cancel", call: () => Promise<DecisionKind>, onError?: (e: unknown) => boolean): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const kind = await call();
      setAttestNeeded(false);
      onDecided(kind);
    } catch (e) {
      lock.current = false;
      setBusy(false);
      if (onError?.(e)) return;
      const f = failureSentence(e, what);
      setNotice(f.text);
      if (f.stale) onStale();
    }
  };

  const decide = (decision: "approve" | "deny", withAttest = false): Promise<void> =>
    act(
      "decide",
      async () => {
        // Scope and delegation belong to an approval; a denial carries neither.
        await getApi().rpc("approval.decide", {
          id: approval.id,
          decision,
          ...(decision === "approve" ? { scope: selectedScope, delegable } : {}),
          ...(withAttest ? { attest: true } : {}),
        });
        return decision === "approve" ? "approved" : "denied";
      },
      (e) => {
        const o = (typeof e === "object" && e !== null ? e : {}) as { error?: string | null; reason?: string; errorCode?: string; detail?: string };
        const att = attestationText({ error: o.error ?? o.errorCode ?? null, reason: o.reason, detail: o.detail });
        if (!att) return false;
        if (o.reason === "attestation-required") setAttestNeeded(true);
        setNotice(att);
        return true;
      },
    );

  const cancel = (): Promise<void> =>
    act("cancel", async () => {
      await getApi().rpc("approval.cancel", { id: approval.id });
      return "cancelled";
    });

  return h(
    "article",
    { class: "approval-card-d109", "aria-labelledby": `approval-title-${approval.id}` },
    confirmation ? h("p", { class: "field-hint", role: "status" },
      t(`approvals.os.${confirmation.status === "not_required" ? "notRequired" : confirmation.status}` as Key), confirmation.platform ? ` · ${confirmation.platform}` : "",
      confirmation.status === "pending" ? ` ${t("approvals.os.deviceHint")}` : "") : null,
    h(
      "div",
      { class: "approval-card-head" },
      h(
        "div",
        null,
        h("h2", { id: `approval-title-${approval.id}`, class: "approval-card-title", tabIndex: -1 }, `${approval.subject.id}: ${approval.capability}`),
        h(
          "div",
          { class: "chip-row" },
          h(Badge, { tone: riskTone(approval.risk) }, `${t("approvals.card.risk")}: ${t(`approvals.risk.${approval.risk ?? "unknown"}` as Key)}`),
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
            approval.targets.map((tgt, i) => h("li", { key: `${i}:${tgt}` }, shown(tgt))),
          ),
        )
      : null,
    approval.summary
      ? h(
          "div",
          null,
          h("span", { class: "approval-field-label" }, t("approvals.card.summary")),
          h("pre", { class: "approval-summary" }, shown(approval.summary)),
        )
      : null,
    // Agent Rationale (unverified) placed LAST among content
    approval.agentReason
      ? h(
          "div",
          { class: "approval-reason-unverified" },
          h("span", { class: "approval-field-label" }, t("approvals.card.agentReason")),
          h("p", null, shown(approval.agentReason)),
        )
      : null,
    masked
      ? h("p", { class: "field-hint" }, t("approvals.card.masked"))
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
                  opt.scope === "always" ? (maxGrantDays !== undefined ? t("approvals.scope.alwaysConfigured", {days:maxGrantDays}) : t("approvals.scope.alwaysUnknown")) : t(
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
          // One live region that is always there: a region inserted together with its text is not reliably announced.
          h("div", { class: notice ? "form-notice" : "sr-only", role: "alert" }, notice ?? ""),
          h(
            "div",
            { class: "approval-actions" },
            // aria-disabled, not disabled: a disabled button gives up the focus, and a keyboard user would land on <body>.
            h(
              "button",
              {
                type: "button",
                class: "btn btn-primary",
                "aria-disabled": String(busy),
                onClick: () => { void decide("approve", attestNeeded); },
              },
              t("approvals.action.approve"),
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-err",
                "aria-disabled": String(busy),
                onClick: () => { void decide("deny", false); },
              },
              t("approvals.action.deny"),
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-quiet",
                "aria-disabled": String(busy),
                onClick: () => { void cancel(); },
              },
              t("approvals.action.cancel"),
            ),
          ),
        )
      : null,
  );
}

function expiry(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDateTime(d);
}

function GrantsList(): View {
  const { state, reload } = useLoad(
    (signal) => getApi().rpc("grant.list", {}, { write: false, signal }) as Promise<{ grants?: GrantRecord[] } | GrantRecord[]>,
    []
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [said, setSaid] = useState("");
  const lock = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  // The reloaded list releases the lock a successful revoke keeps shut (the old row is still on screen until then), and a row
  // that is gone took the focus with it.
  useLayoutEffect(() => {
    if (state.status !== "ok") return;
    lock.current = false;
    setBusyId(null);
    if (refocus.current) { refocus.current = false; restoreFocus(box.current); }
  }, [state]);

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail")
    return h(FailureState, { failure: state.failure, onRetry: reload });

  const raw = state.data;
  const grants: GrantRecord[] = Array.isArray(raw) ? raw : (raw as { grants?: GrantRecord[] }).grants ?? [];

  const revoke = async (id: string): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setBusyId(id);
    setNotice("");
    setSaid("");
    try {
      await getApi().rpc("grant.revoke", { id });
      setSaid(t("approvals.done.revoked"));
      refocus.current = true;
      reload();
    } catch (e) {
      const f = failureSentence(e, "revoke");
      setNotice(f.text);
      lock.current = false;
      setBusyId(null);
      if (f.stale) reload();
    }
  };

  const regions = [
    h("div", { key: "alert", class: notice ? "form-notice" : "sr-only", role: "alert" }, notice),
    h("p", { key: "status", class: "sr-only", role: "status" }, said),
  ];

  if (grants.length === 0) {
    return h("div", { ref: box }, regions, h(PageState, { state: "empty", title: t("approvals.empty.grants") }));
  }

  return h(
    "div",
    { ref: box },
    regions,
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
          h("th", null, t("approvals.col.action")),
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
            h("td", null, expiry(g.expiresAt)),
            h(
              "td",
              null,
              g.state === "active"
                ? h(
                    "button",
                    {
                      type: "button",
                      class: "btn btn-quiet",
                      "aria-disabled": String(busyId !== null),
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
  const limits = useLoad(loadSecurityLimits, []);
  const role = currentRole();
  const canDecide = roleIn(role, ["owner", "admin"]);
  const { state, reload } = useLoad(
    (signal) =>
      getApi().rpc("approval.list", { status: "pending" }, { write: false, signal }) as Promise<{ approvals?: ApprovalRecord[] } | ApprovalRecord[]>,
    []
  );
  const [said, setSaid] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  // The decided card is gone after the reload and took the focus with it.
  useLayoutEffect(() => { if (refocus.current && state.status === "ok") { refocus.current = false; restoreFocus(box.current); } }, [state]);

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail")
    return h(FailureState, { failure: state.failure, onRetry: reload });

  const raw = state.data;
  const approvals: ApprovalRecord[] = Array.isArray(raw) ? raw : (raw as { approvals?: ApprovalRecord[] }).approvals ?? [];
  // The outcome is announced in a region that is always there; the card that was acted on disappears with the reload.
  const status = h("p", { key: "status", class: "sr-only", role: "status" }, said);

  if (approvals.length === 0) {
    return h("div", { ref: box }, status, h(PageState, { state: "empty", title: t("approvals.empty.pending") }));
  }

  return h(
    "div",
    { ref: box },
    status,
    approvals.map((apr) =>
      h(ApprovalCard, {
        key: apr.id,
        approval: apr,
        canDecide,
        ...(limits.state.status === "ok" ? {maxGrantDays:limits.state.data.maxGrantDays} : {}),
        onDecided: (kind: DecisionKind) => { setSaid(t(`approvals.done.${kind}` as Key)); refocus.current = true; reload(); },
        onStale: () => { reload(); },
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
