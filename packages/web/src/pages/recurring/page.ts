// Recurring Tasks Page: jobs.list, jobs.history, jobs.run with confirmation dialog.
// Notes gap in docs/web-ui.md: creating/editing jobs is not supported by backend schema.
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { Dialog } from "../../components/dialog.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { Tabs } from "../../components/tabs.ts";
import { formatDateTime, t } from "../../i18n.ts";
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
import { outcomeLabel, outcomeTone } from "./outcome.ts";
import type { UserJob } from "../../../../rpc-schema/generated/types.ts";

registerArea("recurring", area);

type JobEntry = JobsListResult["jobs"][number];

/** Who may start a job by hand (docs/rbac.md, `jobs.run`): Owner, Admin and Operator. Reading the list and the history is open. */
const HISTORY_LIMIT = 50;
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
  // An agent job runs on an agent that exists: the ids come from agent.list, the person picks when there are several.
  const needsAgent = job.kind === "agent";
  const [agents, setAgents] = useState<string[] | null>(needsAgent ? null : []);
  const [agentId, setAgentId] = useState("");
  // A confirm that arrives while the agents are still loading waits for them instead of being dropped.
  const loading = useRef<Promise<string[]> | null>(null);
  useEffect(() => {
    if (!needsAgent) return;
    const ctl = new AbortController();
    const done = listAgents(ctl.signal).then(
      (ids) => {
        if (!ctl.signal.aborted) {
          setAgents(ids);
          setAgentId(ids[0] ?? "");
          if (ids.length === 0) setErr(t("recurring.run.noAgent"));
        }
        return ids;
      },
      (e: unknown) => {
        if (!ctl.signal.aborted && (e as { kind?: string }).kind !== "aborted") { setAgents([]); setErr(t("recurring.run.agentsFailed")); }
        return [] as string[];
      },
    );
    loading.current = done;
    return () => { ctl.abort(); };
  }, [needsAgent]);
  const ready = agents !== null && (!needsAgent || agentId !== "");

  const run = async (): Promise<void> => {
    if (inFlight.current) return;
    if (!ready && agents !== null) return; // the agents are known and there is none to run on: the dialog says so
    inFlight.current = true;
    setBusy(true);
    setErr("");
    try {
      let target = agentId;
      if (needsAgent && agents === null) {
        target = (await loading.current)?.[0] ?? "";
        if (target === "") { setBusy(false); return; }
      }
      await getApi().rpc("jobs.run", {
        job: job.name,
        ...(needsAgent ? { agentId: target } : {}),
      });
      setBusy(false);
      onDone();
      onClose();
    } catch (e) {
      setBusy(false);
      void e; // server text never reaches the dialog
      setErr(t("recurring.error.run"));
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
            "aria-disabled": String(busy || (agents !== null && !ready)),
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
      agents !== null && agents.length > 1
        ? h("div", { class: "field" },
            h("label", { for: "recurring-run-agent" }, t("recurring.run.agent")),
            h("select", { id: "recurring-run-agent", value: agentId, onChange: (e: Event) => { setAgentId((e.target as HTMLSelectElement).value); } },
              agents.map((id) => h("option", { key: id, value: id }, id))))
        : null,
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
                  j.nextRunAt ? formatDateTime(new Date(j.nextRunAt)) : "—",
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

/** The ids of the agents that exist (agent.list). */
async function listAgents(signal: AbortSignal): Promise<string[]> {
  const out = (await getApi().rpc("agent.list", {}, { write: false, signal })) as { agents?: { agentId: string }[] };
  return (out.agents ?? []).map((a) => a.agentId);
}

/** The newest `limit` runs of the system jobs and of every agent's jobs. jobs.history without agentId answers the system jobs
 *  only (rpc.schema.json), so the agents come from agent.list and are asked one by one. */
async function loadHistory(signal: AbortSignal): Promise<{ runs: (JobRun | SystemJobRun)[] }> {
  const api = getApi();
  const system = api.rpc("jobs.history", { limit: HISTORY_LIMIT }, { write: false, signal }) as Promise<{ runs?: (JobRun | SystemJobRun)[] }>;
  const listed = listAgents(signal);
  const [sys, agentIds] = await Promise.all([system, listed]);
  const perAgent = await Promise.all(agentIds.map((id) =>
    api.rpc("jobs.history", { agentId: id, limit: HISTORY_LIMIT }, { write: false, signal }) as Promise<{ runs?: (JobRun | SystemJobRun)[] }>));
  const all = [sys, ...perAgent].flatMap((r) => r.runs ?? []);
  all.sort((a, b) => b.finishedAt - a.finishedAt);
  return { runs: all.slice(0, HISTORY_LIMIT) };
}

function HistoryTab(): View {
  const { state, reload } = useLoad(loadHistory, []);

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
        { key: `${"agentId" in r ? r.agentId : ""}:${r.runId}`, class: "recurring-history-item" },
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
          h("span", { class: "field-hint" }, formatDateTime(new Date(r.finishedAt))),
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
