// Break-Glass Page: breakglass.request, breakglass.list, breakglass.revoke, breakglass.notices, breakglass.notice
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { Tabs } from "../../components/tabs.ts";
import { formatDateTime, t } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as area from "../../i18n/breakglass.ts";
import { FailureState } from "../common/states.ts";
import { currentRole, getApi, useLoad } from "../common/load.ts";
import type { PageProps } from "../registry.ts";
import "./rpc-types.ts";
import type {
  BreakglassGrant,
} from "./banner.ts";
import {
  BreakglassWarningBanner,
  formatRemaining,
} from "./banner.ts";
import {
  RequestBreakglassDialog,
  RevokeConfirmDialog,
} from "./dialog.ts";
import type {
  BreakglassListResult,
  BreakglassNoticesResult,
  BreakglassRequestResult,
} from "./rpc-types.ts";

import "./breakglass.css";

registerArea("breakglass", area);

type PastGrant = BreakglassGrant & { status: "expired" | "revoked" };
type BreakglassNotice = BreakglassNoticesResult["notices"][number];

type LoadedData = {
  grants: BreakglassGrant[];
  notices: BreakglassNotice[];
};

export function BreakglassPage(_props?: PageProps): View {
  const role = currentRole();
  // Fail closed (docs/rbac.md: Owner and Admin only, people only): a role this UI does not know, an agent included, gets no trigger,
  // unlike roleIn(), which lets an unknown role try and the server decide.
  const isAllowed = role === "owner" || role === "admin";

  if (!isAllowed) {
    return h(Page, { title: t("breakglass.title") }, h(PageState, { state: "forbidden" }));
  }

  return h(BreakglassContent, {});
}

function BreakglassContent(_props?: unknown): View {
  const [selectedTab, setSelectedTab] = useState("active");
  const [showRequestDialog, setShowRequestDialog] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<BreakglassGrant | null>(null);
  const [revokedIds, setRevokedIds] = useState<Set<string>>(() => new Set());
  const [locallyAddedGrants, setLocallyAddedGrants] = useState<BreakglassGrant[]>([]);
  const [now, setNow] = useState<number>(Date.now());
  const alive = useRef(true);

  // Periodic clock update for countdown and expiry checks
  useEffect(() => {
    alive.current = true;
    const interval = setInterval(() => {
      if (alive.current) setNow(Date.now());
    }, 1000);
    return () => {
      alive.current = false;
      clearInterval(interval);
    };
  }, []);

  const loadData = async (signal: AbortSignal): Promise<LoadedData> => {
    const api = getApi();
    const [listRes, noticesRes] = await Promise.all([
      api.rpc("breakglass.list", {}, { signal, write: false }),
      api.rpc("breakglass.notices", {}, { signal, write: false }).catch(() => ({ notices: [] })),
    ]);
    return {
      grants: listRes.grants ?? [],
      notices: noticesRes.notices ?? [],
    };
  };

  const { state, reload } = useLoad(loadData, []);

  // Subscribe to live SSE events for breakglass.notice
  useEffect(() => {
    const stream = getApi().events({
      onEvent: (e) => {
        const isNoticeEvent = e.event === "breakglass.notice" ||
          (typeof e.data === "object" && e.data !== null && (e.data as { method?: string }).method === "breakglass.notice");
        if (isNoticeEvent) {
          reload();
        }
      },
    });
    return () => {
      stream.close();
    };
  }, [reload]);

  if (state.status === "loading") {
    return h(Page, { title: t("breakglass.title"), lead: t("breakglass.intro") }, h(PageLoading, null));
  }

  if (state.status === "fail") {
    return h(Page, { title: t("breakglass.title"), lead: t("breakglass.intro") }, h(FailureState, { failure: state.failure, onRetry: reload }));
  }

  // Combine fetched grants with any locally added ones
  const allGrantsMap = new Map<string, BreakglassGrant>();
  for (const g of state.data.grants) allGrantsMap.set(g.id, g);
  for (const g of locallyAddedGrants) allGrantsMap.set(g.id, g);
  const allGrants = Array.from(allGrantsMap.values());

  const activeGrants = allGrants.filter((g) => g.expiresAt > now && !revokedIds.has(g.id));
  const pastGrants: PastGrant[] = allGrants
    .filter((g) => g.expiresAt <= now || revokedIds.has(g.id))
    .map((g) => ({
      ...g,
      status: revokedIds.has(g.id) ? "revoked" : "expired",
    }));

  const notices = state.data.notices;

  const handleRequestSuccess = (res: BreakglassRequestResult): void => {
    const newGrant: BreakglassGrant = {
      id: res.id,
      holderUserId: res.holderUserId,
      targetUserId: res.targetUserId,
      reason: res.reason,
      issuedAt: res.issuedAt,
      expiresAt: res.expiresAt,
    };
    setLocallyAddedGrants((prev) => [newGrant, ...prev]);
    reload();
  };

  const handleRevokeSuccess = (grantId: string): void => {
    setRevokedIds((prev) => new Set([...prev, grantId]));
    reload();
  };

  // Tab Panels
  const activePanel: View = h(
    "div",
    { class: "bg-panel" },
    activeGrants.length === 0
      ? h("p", { class: "bg-empty", role: "status" }, t("breakglass.empty.active"))
      : h(
        "div",
        { class: "bg-table-container" },
        h(
          "table",
          { class: "bg-table", "aria-label": t("breakglass.tab.active") },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", { scope: "col" }, t("breakglass.table.holder")),
              h("th", { scope: "col" }, t("breakglass.table.target")),
              h("th", { scope: "col" }, t("breakglass.table.issued")),
              h("th", { scope: "col" }, t("breakglass.table.remaining")),
              h("th", { scope: "col" }, t("breakglass.table.reason")),
              h("th", { scope: "col" }, t("breakglass.table.actions")),
            ),
          ),
          h(
            "tbody",
            null,
            activeGrants.map((g) =>
              h(
                "tr",
                { key: g.id },
                h("td", { class: "bg-mono" }, g.holderUserId),
                h("td", { class: "bg-mono" }, g.targetUserId),
                h("td", null, formatDateTime(new Date(g.issuedAt))),
                h("td", { class: "bg-banner-timer" }, formatRemaining(g.expiresAt, now)),
                h("td", { class: "bg-reason-cell" }, g.reason || "—"),
                h(
                  "td",
                  null,
                  h(
                    "button",
                    {
                      type: "button",
                      class: "btn btn-quiet",
                      onClick: () => { setRevokeTarget(g); },
                    },
                    t("breakglass.table.actions") ? t("breakglass.banner.revoke") : "Revoke",
                  ),
                ),
              )
            ),
          ),
        ),
      ),
  );

  const pastPanel: View = h(
    "div",
    { class: "bg-panel" },
    pastGrants.length === 0
      ? h("p", { class: "bg-empty", role: "status" }, t("breakglass.empty.past"))
      : h(
        "div",
        // The past table has no button inside; a narrow window scrolls it, so the container itself must be reachable by keyboard.
        { class: "bg-table-container", role: "region", tabIndex: 0, "aria-label": t("breakglass.tab.past") },
        h(
          "table",
          { class: "bg-table", "aria-label": t("breakglass.tab.past") },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", { scope: "col" }, t("breakglass.table.holder")),
              h("th", { scope: "col" }, t("breakglass.table.target")),
              h("th", { scope: "col" }, t("breakglass.table.issued")),
              h("th", { scope: "col" }, t("breakglass.table.expires")),
              h("th", { scope: "col" }, t("breakglass.table.status")),
              h("th", { scope: "col" }, t("breakglass.table.reason")),
            ),
          ),
          h(
            "tbody",
            null,
            pastGrants.map((g) =>
              h(
                "tr",
                { key: g.id },
                h("td", { class: "bg-mono" }, g.holderUserId),
                h("td", { class: "bg-mono" }, g.targetUserId),
                h("td", null, formatDateTime(new Date(g.issuedAt))),
                h("td", null, formatDateTime(new Date(g.expiresAt))),
                h(
                  "td",
                  null,
                  h(
                    Badge,
                    { tone: g.status === "revoked" ? "warn" : "neutral" },
                    g.status === "revoked" ? t("breakglass.status.revoked") : t("breakglass.status.expired"),
                  ),
                ),
                h("td", { class: "bg-reason-cell" }, g.reason || "—"),
              )
            ),
          ),
        ),
      ),
  );

  const noticesPanel: View = h(
    "div",
    { class: "bg-panel" },
    h("p", { class: "lead" }, t("breakglass.notices.lead")),
    notices.length === 0
      ? h("p", { class: "bg-empty", role: "status" }, t("breakglass.empty.notices"))
      : h(
        "div",
        { class: "bg-notices-list" },
        notices.map((n) =>
          h(
            "div",
            { key: n.grantId, class: "bg-notice-card" },
            h(
              "div",
              { class: "bg-notice-head" },
              h("strong", null, `${t("breakglass.table.holder")}: ${n.holderUserId}`),
              h(Badge, { tone: "warn" }, t("breakglass.status.granted")),
            ),
            h("div", { class: "bg-mono" }, t("breakglass.notices.grantId", { id: n.grantId })),
            h("div", null, `${t("breakglass.table.expires")}: ${formatDateTime(new Date(n.expiresAt))}`),
            n.reason ? h("p", { class: "bg-notice-reason" }, `${t("breakglass.table.reason")}: ${n.reason}`) : null,
          )
        ),
      ),
  );

  const tabs = [
    { id: "active", label: `${t("breakglass.tab.active")} (${activeGrants.length})`, panel: activePanel },
    { id: "past", label: `${t("breakglass.tab.past")} (${pastGrants.length})`, panel: pastPanel },
    { id: "notices", label: `${t("breakglass.tab.notices")} (${notices.length})`, panel: noticesPanel },
  ];

  return h(
    Page,
    {
      title: t("breakglass.title"),
      lead: t("breakglass.intro"),
      actions: h(
        "button",
        {
          type: "button",
          class: "btn btn-primary",
          onClick: () => { setShowRequestDialog(true); },
        },
        t("breakglass.action.request"),
      ),
    },
    h(BreakglassWarningBanner, {
      grants: activeGrants,
      now,
      onRevoke: (g) => { setRevokeTarget(g); },
    }),
    h("div", { class: "bg-content-tabs" }, h(Tabs, { label: t("breakglass.title"), tabs, selected: selectedTab, onSelect: setSelectedTab })),
    showRequestDialog
      ? h(RequestBreakglassDialog, {
        onClose: () => { setShowRequestDialog(false); },
        onSuccess: handleRequestSuccess,
      })
      : null,
    revokeTarget
      ? h(RevokeConfirmDialog, {
        grantId: revokeTarget.id,
        targetUserId: revokeTarget.targetUserId,
        onClose: () => { setRevokeTarget(null); },
        onSuccess: handleRevokeSuccess,
      })
      : null,
  );
}
