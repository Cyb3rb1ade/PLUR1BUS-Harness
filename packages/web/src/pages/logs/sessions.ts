// Sessions tab of /logs (F42): overview of sessions with owner, agent, model and usage columns.
// Operators see all sessions (allOwners: true). Transcripts of other users require an active break-glass window.
import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { BreakGlassDialog } from "../../components/break-glass.ts";
import { Badge } from "../../components/card.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { formatDateTime, formatNumber, t, type Key } from "../../i18n.ts";
import { Field } from "../common/field.ts";
import { currentRole, roleIn } from "../common/load.ts";
import { FailureState, Notice } from "../common/states.ts";
import { sessionState } from "../../session.ts";
import { useSessions } from "./sessions/data.ts";
import {
  applyFilters, filtersActive, NO_FILTERS, paginate, sortSessions,
  type Filters, type SessionMeta, type SortDir, type SortKey, type StatusFilter,
} from "./sessions/model.ts";
import { listGrants } from "../settings/users/model.ts";
import { registerArea } from "../../i18n/index.ts";
import * as sessionsArea from "../../i18n/sessions.ts";
import "../../styles/sessions.css";

registerArea("sessions", sessionsArea);

const SORT_KEYS: readonly SortKey[] = ["activity", "created", "title", "turns"];
const STATUSES: readonly StatusFilter[] = ["active", "archived", "all"];

function Row({ s, onTranscript }: { s: SessionMeta; onTranscript: (s: SessionMeta) => void }): View {
  const title = s.title.trim() === "" ? t("sessions.untitled") : s.title;
  const totalTokens = s.usage ? s.usage.inputTokens + s.usage.outputTokens : null;
  const usageText = totalTokens !== null ? t("sessions.tokens", { n: formatNumber(totalTokens) }) : "-";

  return h("li", { class: "session-row", "data-session": s.id },
    h("div", { class: "session-head" },
      h("p", { class: "session-title" }, title),
      s.pinned ? h(Badge, { tone: "info" }, t("sessions.pinned")) : null,
      s.archivedAt !== null ? h(Badge, {}, t("sessions.archived")) : null),
    h("dl", { class: "facts facts-cols session-facts" },
      h("div", {}, h("dt", {}, t("sessions.f.id")), h("dd", {}, h("code", {}, s.id))),
      h("div", {}, h("dt", {}, t("sessions.f.agent")), h("dd", {}, s.agentId)),
      h("div", {}, h("dt", {}, t("sessions.f.owner")), h("dd", {}, s.owner ? h("code", {}, s.owner) : "-")),
      h("div", {}, h("dt", {}, t("sessions.f.model")), h("dd", {}, s.model ?? "-")),
      h("div", {}, h("dt", {}, t("sessions.f.usage")), h("dd", {}, usageText)),
      h("div", {}, h("dt", {}, t("sessions.f.created")), h("dd", {}, formatDateTime(new Date(s.createdAt)))),
      h("div", {}, h("dt", {}, t("sessions.f.activity")), h("dd", {}, s.lastTurnAt === null ? t("sessions.noActivity") : formatDateTime(new Date(s.lastTurnAt)))),
      h("div", {}, h("dt", {}, t("sessions.f.turns")), h("dd", {}, formatNumber(s.turnCount)))),
    h("button", {
      type: "button",
      class: "btn btn-quiet session-transcript",
      "aria-label": t("sessions.transcriptFor", { title }),
      onClick: () => { onTranscript(s); },
    }, t("sessions.transcript")));
}

export function SessionsOverview(): View {
  const role = currentRole();
  const allowed = roleIn(role, ["owner", "admin", "operator", "viewer"]);
  const isOperator = roleIn(role, ["owner", "admin", "operator"]);
  const sState = sessionState.value;
  const selfUserId = sState.status === "authenticated" ? sState.user.id : "";

  const { state, reload } = useSessions(allowed, isOperator);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<SortKey>("activity");
  const [dir, setDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [bgTarget, setBgTarget] = useState<SessionMeta | null>(null);

  const all = state.status === "ok" ? state.data.sessions : [];
  const agents = useMemo(() => [...new Set(all.map((s) => s.agentId))].sort(), [all]);
  const owners = useMemo(() => [...new Set(all.map((s) => s.owner).filter((o): o is string => !!o))].sort(), [all]);
  const view = useMemo(() => paginate(sortSessions(applyFilters(all, filters), sort, dir), page), [all, filters, sort, dir, page]);
  useEffect(() => { if (view.page !== page) setPage(view.page); }, [view.page, page]);

  if (!allowed) return h(PageState, { state: "forbidden" });
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("sessions.unavailable.title"), onRetry: reload });
  if (all.length === 0) return h(PageState, { state: "empty", title: t("sessions.empty.title"), detail: t("sessions.empty.detail") });

  const set = (patch: Partial<Filters>): void => { setFilters({ ...filters, ...patch }); setPage(1); };
  const on = (fn: (v: string) => void) => (e: Event): void => { fn((e.target as HTMLInputElement | HTMLSelectElement).value); };

  const handleTranscript = async (s: SessionMeta): Promise<void> => {
    if (s.owner && s.owner !== selfUserId) {
      try {
        const res = await listGrants();
        const now = Date.now();
        const hasGrant = (res.grants ?? []).some((g) => g.targetUserId === s.owner && g.expiresAt > now);
        if (hasGrant) {
          window.location.hash = `#/chat/${s.id}`;
          return;
        }
      } catch {
        // Ignore
      }
    }
    setBgTarget(s);
  };

  return h("div", { class: "sessions" },
    h("h2", { class: "sessions-title" }, t("sessions.title")),
    h("p", { class: "lead" }, t("sessions.lead")),
    h("p", { class: "field-hint sessions-hint" }, t("sessions.transcriptHint")),
    state.data.truncated ? h(Notice, {}, t("sessions.truncated", { n: formatNumber(all.length) })) : null,
    h("div", { class: "session-filters", role: "group", "aria-label": t("sessions.filters") },
      h(Field, { id: "ses-q", label: t("sessions.search") }, h("input", { id: "ses-q", type: "search", autoComplete: "off", value: filters.text, onInput: on((v) => { set({ text: v }); }) })),
      h(Field, { id: "ses-agent", label: t("sessions.agent") },
        h("select", { id: "ses-agent", value: filters.agent, onChange: on((v) => { set({ agent: v }); }) },
          h("option", { value: "", selected: filters.agent === "" }, t("sessions.agent.all")),
          agents.map((a) => h("option", { key: a, value: a, selected: a === filters.agent }, a)))),
      owners.length > 0 ? h(Field, { id: "ses-owner", label: t("sessions.f.owner") },
        h("select", { id: "ses-owner", value: filters.owner, onChange: on((v) => { set({ owner: v }); }) },
          h("option", { value: "", selected: filters.owner === "" }, t("sessions.owner.all")),
          owners.map((o) => h("option", { key: o, value: o, selected: o === filters.owner }, o)))) : null,
      h(Field, { id: "ses-status", label: t("sessions.status") },
        h("select", { id: "ses-status", value: filters.status, onChange: on((v) => { set({ status: v as StatusFilter }); }) },
          STATUSES.map((v) => h("option", { key: v, value: v, selected: v === filters.status }, t(`sessions.status.${v}` as Key))))),
      h(Field, { id: "ses-from", label: t("sessions.from") }, h("input", { id: "ses-from", type: "date", value: filters.from, max: filters.to || undefined, onInput: on((v) => { set({ from: v }); }) })),
      h(Field, { id: "ses-to", label: t("sessions.to") }, h("input", { id: "ses-to", type: "date", value: filters.to, min: filters.from || undefined, onInput: on((v) => { set({ to: v }); }) })),
      h(Field, { id: "ses-sort", label: t("sessions.sort") },
        h("select", { id: "ses-sort", value: sort, onChange: on((v) => { setSort(v as SortKey); setPage(1); }) },
          SORT_KEYS.map((k) => h("option", { key: k, value: k, selected: k === sort }, t(`sessions.sort.${k}` as Key))))),
      h(Field, { id: "ses-dir", label: t("sessions.order") },
        h("select", { id: "ses-dir", value: dir, onChange: on((v) => { setDir(v as SortDir); setPage(1); }) },
          (["desc", "asc"] as const).map((d) => h("option", { key: d, value: d, selected: d === dir }, t(`sessions.order.${d}` as Key))))),
      filtersActive(filters) ? h("div", { class: "session-clear" }, h("button", { type: "button", class: "btn btn-quiet", onClick: () => { setFilters(NO_FILTERS); setPage(1); } }, t("sessions.clear"))) : null),
    h("p", { class: "session-count", role: "status" }, view.total === 0 ? "" : t("sessions.count", { from: formatNumber(view.from), to: formatNumber(view.to), total: formatNumber(view.total) })),
    view.total === 0
      ? h(PageState, { state: "empty", title: t("sessions.noMatch.title"), detail: t("sessions.noMatch.detail") })
      : h("ul", { class: "plain-list session-list", "aria-label": t("sessions.list") }, view.items.map((s) => h(Row, { key: s.id, s, onTranscript: handleTranscript }))),
    view.pages > 1 ? h("nav", { class: "session-pager", "aria-label": t("sessions.pager") },
      h("button", { type: "button", class: "btn", disabled: view.page <= 1, onClick: () => { setPage(view.page - 1); } }, t("sessions.prev")),
      h("span", { class: "field-hint" }, t("sessions.page", { page: view.page, pages: view.pages })),
      h("button", { type: "button", class: "btn", disabled: view.page >= view.pages, onClick: () => { setPage(view.page + 1); } }, t("sessions.next"))) : null,
    bgTarget ? h(BreakGlassDialog, {
      targetLabel: bgTarget.owner ? `${bgTarget.owner} (${bgTarget.id})` : (bgTarget.title.trim() === "" ? bgTarget.id : `${bgTarget.title} (${bgTarget.id})`),
      ...(bgTarget.owner !== undefined ? { targetUserId: bgTarget.owner } : {}),
      onClose: () => { setBgTarget(null); },
    }) : null);
}
