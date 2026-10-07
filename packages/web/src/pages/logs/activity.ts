// Activity tab of /logs (F42, F43): a condensed, human-readable feed built from `logs.query` (audit and diagnostic streams),
// grouped by day, with the `audit.verify` status on top. Roles: `logs.query` and `audit.read` are Owner and Admin only
// (docs/rbac.md), so every other role gets the forbidden state without a call. Entry mapping lives in activity/model.ts.
import { h } from "preact";
import type { View } from "../../view.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { Badge } from "../../components/card.ts";
import { formatDateTime, t, type Key } from "../../i18n.ts";
import { icon, type IconName } from "../../icons.ts";
import { currentRole, roleIn } from "../common/load.ts";
import { FailureState, Notice } from "../common/states.ts";
import { useFeed, useVerify } from "./activity/data.ts";
import { groupEntries, logLink, sentenceKey, type ActivityEntry, type ActivityKind, type ActivityOutcome } from "./activity/model.ts";
import { VerifyCard } from "./activity/verify-card.ts";

const ICON: Record<ActivityKind, IconName> = { agentRun: "agents", dreams: "memories", modelScan: "models", backup: "library", login: "lock", logout: "lock", breakGlass: "alert" };
const TONE: Record<ActivityOutcome, "ok" | "err" | "warn" | "neutral"> = { completed: "ok", failed: "err", skipped: "warn", none: "neutral" };

/** The entry as a sentence in the current language. A parameter the record lacks reads "unknown". */
export function sentence(e: ActivityEntry): string {
  const p = (v: string): string => (v === "" ? t("activity.unknown") : v);
  return t(sentenceKey(e) as Key, { agent: p(e.params.agent), job: p(e.params.job), profile: p(e.params.profile), target: p(e.params.target) });
}

function Entry({ e }: { e: ActivityEntry }): View {
  const text = sentence(e);
  return h("li", { class: "activity-entry", "data-kind": e.kind, "data-outcome": e.outcome },
    h("span", { class: "activity-icon" }, icon(ICON[e.kind], 18)),
    h("div", { class: "activity-body" },
      h("p", { class: "activity-text" }, text, e.outcome !== "none" ? [" ", h(Badge, { key: "o", tone: TONE[e.outcome] }, t(`activity.outcome.${e.outcome}` as Key))] : null),
      h("p", { class: "activity-meta" }, e.actor === "" ? t("activity.bySystem") : t("activity.by", { actor: e.actor }), " · ", h("time", { dateTime: new Date(e.at).toISOString() }, formatDateTime(new Date(e.at))))),
    h("a", { class: "btn btn-quiet activity-open", href: logLink(e), "aria-label": t("activity.openFor", { what: text }) }, t("activity.open")));
}

/** No props: the clock is `Date.now` (tests fix it with the browser's clock). */
export function ActivityFeed(): View {
  const now = (): number => Date.now();
  const allowed = roleIn(currentRole(), ["owner", "admin"]);
  const feed = useFeed(allowed);
  const verify = useVerify(allowed, now);
  if (!allowed) return h(PageState, { state: "forbidden" });

  const s = feed.state;
  let body: View;
  if (s.status === "loading") body = h(PageLoading, { label: t("state.loading") });
  else if (s.status === "fail") body = h(FailureState, { failure: s.failure, unavailable: t("activity.unavailable.title"), onRetry: feed.reload });
  else if (s.entries.length === 0 && s.failed.length === 0 && s.cursors.audit === null && s.cursors.diagnostic === null) body = h(PageState, { state: "empty", title: t("activity.empty.title"), detail: t("activity.empty.detail") });
  else {
    const groups = groupEntries(s.entries, now());
    const more = s.cursors.audit !== null || s.cursors.diagnostic !== null;
    body = h("div", { class: "activity-feed" },
      s.failed.map((f) => h(Notice, { key: f, tone: "warn" }, t("activity.partial", { source: t(`activity.source.${f}` as Key) }))),
      groups.length === 0 ? h(PageState, { state: "empty", title: t("activity.empty.title"), detail: t("activity.empty.detail") }) : null,
      groups.map((g) => h("section", { key: g.id, class: "activity-group", "aria-labelledby": `activity-g-${g.id}` },
        h("h3", { id: `activity-g-${g.id}`, class: "activity-heading" }, t(`activity.group.${g.id}` as Key)),
        h("ul", { class: "plain-list activity-list" }, g.entries.map((e) => h(Entry, { key: e.id, e }))))),
      s.moreFailed ? h(Notice, { tone: "warn" }, t("activity.moreFailed")) : null,
      more ? h("div", { class: "activity-more" }, h("button", { type: "button", class: "btn", disabled: s.busy, "aria-disabled": s.busy, onClick: feed.more }, s.busy ? t("activity.moreBusy") : t("activity.more"))) : null);
  }

  return h("div", { class: "activity" },
    h(VerifyCard, { state: verify.state, onVerify: verify.run }),
    h("section", { "aria-labelledby": "activity-feed-title" },
      h("h2", { id: "activity-feed-title", class: "activity-title" }, t("activity.feed.title")),
      h("p", { class: "lead" }, t("activity.feed.lead")),
      body));
}
