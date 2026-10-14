// Recurring Tasks Page: jobs.list, jobs.history, jobs.run with confirmation dialog.
// Notes gap in docs/web-ui.md: creating/editing jobs is not supported by backend schema.
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card, type BadgeTone } from "../../components/card.ts";
import { Dialog } from "../../components/dialog.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { Tabs } from "../../components/tabs.ts";
import { t, type Key } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as area from "../../i18n/recurring.ts";
import { FailureState } from "../common/states.ts";
import { currentRole, getApi, roleIn, useLoad } from "../common/load.ts";
import type { PageProps } from "../registry.ts";
import type {
  JobsListResult,
  JobRun,
  SystemJobRun,
} from "../common/surfaces-rpc.ts";

import "../../styles/recurring.css";
import { UserJobsPanel } from "./user-jobs.ts";
import type { UserJob } from "../../../../rpc-schema/generated/types.ts";

registerArea("recurring", area);

type JobEntry = JobsListResult["jobs"][number];

function outcomeTone(outcome: string): BadgeTone {
  switch (outcome) {
    case "completed":
      return "ok";
    case "skipped":
      return "neutral";
    case "incomplete":
    case "failed":
    case "abandoned":
      return "err";
    default:
      return "neutral";
  }
}

const OUTCOME_LABEL = {
  completed: "recurring.status.completed",
  skipped: "recurring.status.skipped",
  incomplete: "recurring.status.incomplete",
  failed: "recurring.status.failed",
  abandoned: "recurring.status.abandoned",
} as const satisfies Record<string, Key>;

/** The outcome in the UI language; an outcome this UI does not know (the schema keeps runs open) is shown as the server sent it. */
function outcomeLabel(outcome: string): string {
  // An own-property check: `in` would also match inherited names such as "toString" and hand a function to t().
  return Object.prototype.hasOwnProperty.call(OUTCOME_LABEL, outcome) ? t(OUTCOME_LABEL[outcome as keyof typeof OUTCOME_LABEL]) : outcome;
}

/** Who may start a job by hand (docs/rbac.md, `jobs.run`): Owner, Admin and Operator. Reading the list and the history is open. */
const RUN_ROLES = ["owner", "admin", "operator"] as const;

function RunConfirmDialog({
  job,
  onClose,
  onDone,
}: {
  job: JobEntry;
  onClose: () => void;
  onDone: () => void;
}): View {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // `busy` only reaches the button after the next render, so a second click in the same task would still see false.
  const inFlight = useRef(false);

  const run = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErr("");
    try {
      await getApi().rpc("jobs.run", {
        job: job.name,
        ...(job.kind === "agent" ? { agentId: "default" } : {}),
      });
      setBusy(false);
      onDone();
      onClose();
    } catch (e) {
      setBusy(false);
      const o = (typeof e === "object" && e !== null ? e : {}) as { message?: string };
      setErr(o.message || "Failed to trigger job run.");
    } finally {
      inFlight.current = false;
    }
  };

  return h(
    Dialog,
    {
      title: t("recurring.action.run"),
      onClose,
      actions: h(
        "div",
        { class: "dialog-actions" },
        h("button", { type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-primary",
            // aria-disabled, not disabled: a disabled button gives up focus, which would drop out of the modal dialog.
            "aria-disabled": String(busy),
            onClick: () => { void run(); },
          },
          t("recurring.action.run"),
        ),
      ),
    },
    h(
      "div",
      { class: "dialog-content" },
      h("p", { class: "reading" }, t("recurring.action.confirmRun", { name: job.name })),
      err ? h("p", { class: "form-error", role: "alert" }, err) : null,
    ),
  );
}

function JobsListTab(): View {
  const { state, reload } = useLoad(
    (signal) => getApi().rpc("jobs.list", { kind: "all" }, { write: false, signal }) as Promise<JobsListResult>,
    []
  );
  const [runTarget, setRunTarget] = useState<JobEntry | null>(null);
  const canRun = roleIn(currentRole(), RUN_ROLES);

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail")
    return h(FailureState, { failure: state.failure, onRetry: reload });

  const allJobs = state.data.jobs ?? [];
  const jobs = allJobs.filter(j => j.kind !== "user");

  return h(
    "div",
    null,
    h(UserJobsPanel, { jobs: allJobs.filter(j => j.kind === "user") as UserJob[], targets: state.data.manageableAgents ?? [], reload }),
    jobs.length === 0
      ? h(PageState, { state: "empty", title: t("recurring.empty.jobs") })
      : h(
          "table",
          { class: "recurring-table" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", null, t("recurring.col.name")),
              h("th", null, t("recurring.col.kind")),
              h("th", null, t("recurring.col.schedule")),
              h("th", null, t("recurring.col.nextRun")),
              canRun ? h("th", null, t("recurring.col.action")) : null,
            ),
          ),
          h(
            "tbody",
            null,
            jobs.map((j) =>
              h(
                "tr",
                { key: j.name },
                h("td", null, h("strong", null, j.name)),
                h("td", null, h(Badge, { tone: "neutral" }, j.kind ?? "system")),
                h(
                  "td",
                  null,
                  j.schedule ? `${Math.round(j.schedule.every / 1000)}s` : "—",
                ),
                h(
                  "td",
                  null,
                  j.nextRunAt ? new Date(j.nextRunAt).toLocaleTimeString() : "—",
                ),
                canRun
                  ? h(
                      "td",
                      null,
                      h(
                        "button",
                        {
                          type: "button",
                          class: "btn btn-quiet",
                          onClick: () => setRunTarget(j),
                        },
                        t("recurring.action.run"),
                      ),
                    )
                  : null,
              ),
            ),
          ),
        ),
    runTarget
      ? h(RunConfirmDialog, {
          job: runTarget,
          onClose: () => setRunTarget(null),
          onDone: () => reload(),
        })
      : null,
  );
}

function HistoryTab(): View {
  const { state, reload } = useLoad(
    (signal) => getApi().rpc("jobs.history", { limit: 50 }, { write: false, signal }) as Promise<{ runs?: (JobRun | SystemJobRun)[] }>,
    []
  );

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail")
    return h(FailureState, { failure: state.failure, onRetry: reload });

  const runs = state.data.runs ?? [];

  if (runs.length === 0) {
    return h(PageState, { state: "empty", title: t("recurring.empty.history") });
  }

  return h(
    "div",
    { class: "recurring-history-list" },
    runs.map((r) =>
      h(
        "div",
        { key: r.runId, class: "recurring-history-item" },
        h(
          "div",
          null,
          h("strong", null, r.job),
          h(
            "div",
            { class: "chip-row" },
            h(Badge, { tone: outcomeTone(r.outcome) }, outcomeLabel(r.outcome)),
            h("span", null, `${t("recurring.detail.trigger")}: ${r.trigger}`),
            h("span", null, `${t("recurring.detail.duration")}: ${r.durationMs}ms`),
          ),
        ),
        h(
          "div",
          null,
          h("span", { class: "field-hint" }, new Date(r.finishedAt).toLocaleTimeString()),
        ),
      ),
    ),
  );
}

function RecurringContent(): View {
  const [tab, setTab] = useState<string>("jobs");

  return h(
    "div",
    { class: "recurring-page" },
    h(Tabs, {
      label: t("recurring.title"),
      selected: tab,
      onSelect: (k: string) => setTab(k),
      tabs: [
        { id: "jobs", label: t("recurring.tab.jobs"), panel: h(JobsListTab, null) },
        { id: "history", label: t("recurring.tab.history"), panel: h(HistoryTab, null) },
      ],
    }),
  );
}

export function RecurringPage(): View {
  const allowed = roleIn(currentRole(), ["owner", "admin", "operator", "member", "viewer"]);
  return h(
    Page,
    { title: t("recurring.title"), lead: t("recurring.intro"), width: "full" },
    allowed ? h(RecurringContent, null) : h(PageState, { state: "forbidden" }),
  );
}
