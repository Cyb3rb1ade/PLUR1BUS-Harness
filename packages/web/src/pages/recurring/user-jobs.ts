// Personal recurring tasks (jobs.create / jobs.update / jobs.delete / jobs.history for kind "user"): the list, the editor with its
// schedule preview, the history and the confirmed delete. The server decides rights; the page only offers what manageableAgents allows.
import { h } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card } from "../../components/card.ts";
import { Dialog } from "../../components/dialog.ts";
import { Field, bad } from "../common/field.ts";
import { getApi, useLoad } from "../common/load.ts";
import { FailureState } from "../common/states.ts";
import { PageLoading } from "../../components/page-state.ts";
import { formatDateTime, lang, t, type Key } from "../../i18n.ts";
import { sessionState } from "../../session.ts";
import { outcomeLabel } from "./outcome.ts";
import { checkSchedule, dstNote, formatDay, formatRun, nextThree } from "./schedule.ts";
import type { UserJob, UserJobRun, JobsCreateParams, JobsCreateResult, JobsUpdateParams, JobsUpdateResult, JobsDeleteParams, JobsDeleteResult } from "../../../../rpc-schema/generated/types.ts";

declare module "../../api/index.ts" {
  interface RpcMethods {
    "jobs.create": { params: JobsCreateParams; result: JobsCreateResult };
    "jobs.update": { params: JobsUpdateParams; result: JobsUpdateResult };
    "jobs.delete": { params: JobsDeleteParams; result: JobsDeleteResult };
  }
}

export { nextThree };

const SCHEDULE_ERROR: Record<"length" | "cron" | "timezone" | "never", Key> = {
  length: "recurring.user.scheduleTooLong",
  cron: "recurring.user.invalidCron",
  timezone: "recurring.user.invalidTimezone",
  never: "recurring.user.neverFires",
};

const PAUSED_REASON = {
  skipped_owner_inactive: "recurring.user.pausedOwnerInactive",
  skipped_no_rights: "recurring.user.pausedNoRights",
  skipped_agent_missing: "recurring.user.pausedAgentMissing",
} as const satisfies Record<NonNullable<UserJob["disabledReason"]>, Key>;

/** The browser's own zone for a new task (the zone the person lives in), else Europe/Berlin like the server's examples. */
function defaultZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (z && checkSchedule("0 9 * * *", z).ok) return z;
  } catch { /* fall through */ }
  return "Europe/Berlin";
}

function JobEditor({ job, targets, onClose, onSaved }: { job: UserJob | null; targets: string[]; onClose: () => void; onSaved: () => void }): View {
  const [name, setName] = useState(job?.name ?? "");
  const [agent, setAgent] = useState(job?.agentId ?? targets[0] ?? "");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [cron, setCron] = useState(job?.schedule.cron ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(job?.schedule.timezone ?? defaultZone());
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const check = useMemo(() => checkSchedule(cron, timezone), [cron, timezone]);
  const preview = useMemo(() => (check.ok ? nextThree(check.cron, check.timezone) : []), [check]);
  const dst = useMemo(() => (check.ok ? dstNote(check.cron, check.timezone) : null), [check]);
  const valid = !!name.trim() && !!prompt.trim() && prompt.length <= 4000 && targets.includes(agent) && check.ok;
  const me = sessionState.value.status === "authenticated" ? sessionState.value.user.id : undefined;
  const scheduleError = check.ok ? undefined : t(SCHEDULE_ERROR[check.reason]);
  const cronError = !check.ok && (check.reason === "cron" || check.reason === "never" || (check.reason === "length" && cron.trim().length > 128)) ? scheduleError : undefined;
  const zoneError = !check.ok && !cronError ? scheduleError : undefined;

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (!valid || locked.current || !check.ok) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const input = { name: name.trim(), agentId: agent, prompt, schedule: { cron: check.cron, timezone: check.timezone }, enabled };
      if (job) await getApi().rpc("jobs.update", { id: job.id, ...input });
      else await getApi().rpc("jobs.create", input);
      onSaved();
      onClose();
    } catch {
      setError(t("recurring.user.failed"));
      locked.current = false;
      setBusy(false);
    }
  };

  return h(Dialog, {
    title: t(job ? "recurring.user.edit" : "recurring.user.create"),
    onClose,
    actions: h("div", { class: "dialog-actions" },
      h("button", { type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
      // aria-disabled while saving: a disabled button gives up the focus, which would drop out of the modal dialog.
      h("button", { type: "submit", form: "user-job-form", class: "btn btn-primary", disabled: !valid, "aria-disabled": String(busy) }, t("recurring.user.save"))),
  },
  h("form", { id: "user-job-form", onSubmit: (e: Event) => { void submit(e); } },
    // Editing another person's task makes the editor its runAs (docs/recurring.md); say so, and say who it ran as.
    job && job.runAs !== me
      ? h("div", { class: "form-notice", role: "note" },
          h("p", null, t("recurring.user.identityChange")),
          h("p", null, t("recurring.user.identityWas", { name: job.runAs })))
      : null,
    h(Field, { id: "job-name", label: t("recurring.user.name") }, h("input", { id: "job-name", value: name, maxLength: 128, required: true, onInput: (e: Event) => setName((e.target as HTMLInputElement).value) })),
    h(Field, { id: "job-agent", label: t("recurring.user.agent") }, h("select", { id: "job-agent", value: agent, onChange: (e: Event) => setAgent((e.target as HTMLSelectElement).value) }, targets.map((id) => h("option", { key: id, value: id }, id)))),
    h(Field, { id: "job-prompt", label: t("recurring.user.prompt") }, h("textarea", { id: "job-prompt", value: prompt, rows: 4, maxLength: 4000, required: true, onInput: (e: Event) => setPrompt((e.target as HTMLTextAreaElement).value) })),
    h(Field, { id: "job-cron", label: t("recurring.user.cron"), error: cronError }, h("input", { id: "job-cron", value: cron, required: true, ...bad(cronError, "job-cron"), onInput: (e: Event) => setCron((e.target as HTMLInputElement).value) })),
    h(Field, { id: "job-timezone", label: t("recurring.user.timezone"), error: zoneError }, h("input", { id: "job-timezone", value: timezone, required: true, ...bad(zoneError, "job-timezone"), onInput: (e: Event) => setTimezone((e.target as HTMLInputElement).value) })),
    h("div", { class: "field" }, h("input", { id: "job-enabled", type: "checkbox", checked: enabled, onChange: (e: Event) => setEnabled((e.target as HTMLInputElement).checked) }), h("label", { for: "job-enabled" }, t("recurring.user.enabled"))),
    h("p", { class: "field-hint" }, t("recurring.user.preview")),
    preview.length === 3
      ? h("ol", null, preview.map((at) => h("li", { key: at }, formatRun(at, timezone, lang.value))))
      : h("p", { class: "form-error", role: "alert" }, t("recurring.user.invalidSchedule")),
    dst ? h("p", { class: "form-notice", role: "note", "data-dst-note": dst.kind }, t(dst.kind === "skipped" ? "recurring.user.dstSkipped" : "recurring.user.dstRepeated", { date: formatDay(dst.at, timezone, lang.value) })) : null,
    error ? h("p", { class: "form-error", role: "alert" }, error) : null));
}

function JobHistory({ job, onClose }: { job: UserJob; onClose: () => void }): View {
  const { state, reload } = useLoad(async (signal) => {
    const out = await getApi().rpc("jobs.history", { kind: "user", job: job.id, limit: 50 }, { write: false, signal });
    return out.runs.filter((r) => "kind" in r && r.kind === "user") as UserJobRun[];
  }, [job.id]);
  return h(Dialog, { title: t("recurring.user.history"), onClose },
    state.status === "loading" ? h(PageLoading, { label: t("state.loading") })
      : state.status === "fail" ? h(FailureState, { failure: state.failure, onRetry: reload })
      : state.data.length === 0 ? h("p", null, t("recurring.user.noRuns"))
      : h("ul", { class: "plain-list" }, state.data.map((run) => h("li", { key: run.runId }, formatDateTime(new Date(run.startedAt)), " · ", run.runAsDisplayName, " · ", outcomeLabel(run.outcome)))));
}

export function UserJobsPanel({ jobs, targets, reload }: { jobs: UserJob[]; targets: string[]; reload: () => void }): View {
  const [editing, setEditing] = useState<UserJob | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<UserJob | null>(null);
  const [history, setHistory] = useState<UserJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  const remove = async (): Promise<void> => {
    if (!deleting || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await getApi().rpc("jobs.delete", { id: deleting.id, confirm: true });
      setDeleting(null);
      reload();
    } catch {
      setError(t("recurring.user.failed"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return h(Card, { title: t("recurring.user.title"), level: 2 },
    targets.length ? h("button", { type: "button", class: "btn", onClick: () => setEditing(null) }, t("recurring.user.create")) : null,
    jobs.length
      ? h("ul", { class: "plain-list" }, jobs.map((job) => {
          const nameId = `user-job-${job.id}`;
          const paused = !job.enabled || job.disabledReason !== undefined;
          return h("li", { key: job.id },
            h("strong", { id: nameId }, job.name), " · ", job.agentId, " · ", job.schedule.cron, " · ", job.schedule.timezone, " · ", job.runAs,
            paused ? [" ", h(Badge, { key: "paused", tone: "warn" }, t("recurring.user.paused")), job.disabledReason ? h("span", { key: "why", class: "field-hint" }, ` ${t(PAUSED_REASON[job.disabledReason])}`) : null]
              : job.nextRunAt !== null ? h("span", { class: "field-hint" }, ` · ${t("recurring.user.next", { when: formatDateTime(new Date(job.nextRunAt)) })}`) : null,
            // The buttons share their names across rows; the task's name is their description.
            h("button", { type: "button", class: "btn btn-quiet", "aria-describedby": nameId, onClick: () => setHistory(job) }, t("recurring.user.history")),
            targets.includes(job.agentId)
              ? [
                  h("button", { key: "edit", type: "button", class: "btn btn-quiet", "aria-describedby": nameId, onClick: () => setEditing(job) }, t("recurring.user.edit")),
                  h("button", { key: "delete", type: "button", class: "btn btn-quiet", "aria-describedby": nameId, onClick: () => { setError(""); setDeleting(job); } }, t("recurring.user.delete")),
                ]
              : null);
        }))
      : h("p", null, t("recurring.user.empty")),
    editing !== undefined ? h(JobEditor, { job: editing, targets, onClose: () => setEditing(undefined), onSaved: reload }) : null,
    history ? h(JobHistory, { job: history, onClose: () => setHistory(null) }) : null,
    deleting
      ? h(Dialog, {
          title: t("recurring.user.delete"),
          onClose: () => setDeleting(null),
          actions: h("div", { class: "dialog-actions" },
            h("button", { type: "button", class: "btn btn-quiet", onClick: () => setDeleting(null) }, t("shared.confirm.cancel")),
            // aria-disabled, not disabled: the focus stays in the modal dialog while the request is out.
            h("button", { type: "button", class: "btn btn-primary", "aria-disabled": String(busy), onClick: () => { void remove(); } }, t("recurring.user.delete"))),
        },
        h("p", null, t("recurring.user.deleteConfirm", { name: deleting.name })),
        error ? h("p", { class: "form-error", role: "alert" }, error) : null)
      : null);
}
