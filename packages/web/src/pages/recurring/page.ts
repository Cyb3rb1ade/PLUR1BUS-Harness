// Recurring Tasks Page: jobs.list, jobs.history, jobs.run with confirmation dialog.
// Notes gap in docs/web-ui.md: creating/editing jobs is not supported by backend schema.
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
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

  const run = async (): Promise<void> => {
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
            disabled: busy,
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

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail")
    return h(FailureState, { failure: state.failure, onRetry: reload });

  const jobs = state.data.jobs ?? [];

  return h(
    "div",
    null,
    h("div", { class: "recurring-gap-notice", role: "note" }, t("recurring.gap.notice")),
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
              h("th", null, t("recurring.col.action")),
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
                h(
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
                ),
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
            h(Badge, { tone: outcomeTone(r.outcome) }, r.outcome),
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
