import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Card } from "../../components/card.ts";
import { Dialog } from "../../components/dialog.ts";
import { Field } from "../common/field.ts";
import { getApi, useLoad } from "../common/load.ts";
import { FailureState } from "../common/states.ts";
import { PageLoading } from "../../components/page-state.ts";
import { formatDateTime, t } from "../../i18n.ts";
import { sessionState } from "../../session.ts";
import { nextAfter, parseCron, isValidTimezone } from "../../../../core/src/dreams/cron.ts";
import type { UserJob, UserJobRun, JobsCreateParams, JobsCreateResult, JobsUpdateParams, JobsUpdateResult, JobsDeleteParams, JobsDeleteResult } from "../../../../rpc-schema/generated/types.ts";
declare module "../../api/index.ts" {
    interface RpcMethods {
        "jobs.create": {
            params: JobsCreateParams;
            result: JobsCreateResult;
        };
        "jobs.update": {
            params: JobsUpdateParams;
            result: JobsUpdateResult;
        };
        "jobs.delete": {
            params: JobsDeleteParams;
            result: JobsDeleteResult;
        };
    }
}
export function nextThree(cron: string, timezone: string, from = Date.now()): number[] {
    if (!isValidTimezone(timezone))
        return [];
    try {
        const parsed = parseCron(cron);
        const runs: number[] = [];
        let at = from;
        for (let i = 0; i < 3; i++) {
            const next = nextAfter(parsed, timezone, at);
            if (next === null)
                break;
            runs.push(next);
            at = next;
        }
        return runs;
    }
    catch {
        return [];
    }
}
function JobEditor({ job, targets, onClose, onSaved }: {
    job: UserJob | null;
    targets: string[];
    onClose: () => void;
    onSaved: () => void;
}): View {
    const [name, setName] = useState(job?.name ?? "");
    const [agent, setAgent] = useState(job?.agentId ?? targets[0] ?? "");
    const [prompt, setPrompt] = useState(job?.prompt ?? "");
    const [cron, setCron] = useState(job?.schedule.cron ?? "0 9 * * *");
    const [timezone, setTimezone] = useState(job?.schedule.timezone ?? "Europe/Berlin");
    const [enabled, setEnabled] = useState(job?.enabled ?? true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const locked = useRef(false);
    const preview = nextThree(cron, timezone);
    const valid = !!name.trim() && !!prompt.trim() && prompt.length <= 4000 && targets.includes(agent) && preview.length === 3;
    const me = sessionState.value.status === "authenticated" ? sessionState.value.user.id : undefined;
    const submit = async (e: Event) => { e.preventDefault(); if (!valid || locked.current)
        return; locked.current = true; setBusy(true); setError(""); try {
        const input = { name, agentId: agent, prompt, schedule: { cron, timezone }, enabled };
        if (job)
            await getApi().rpc("jobs.update", { id: job.id, ...input });
        else
            await getApi().rpc("jobs.create", input);
        onSaved();
        onClose();
    }
    catch {
        setError(t("recurring.user.failed"));
        locked.current = false;
        setBusy(false);
    } };
    return h(Dialog, { title: t(job ? "recurring.user.edit" : "recurring.user.create"), onClose, actions: h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")), h("button", { type: "submit", form: "user-job-form", class: "btn btn-primary", disabled: busy || !valid }, t("recurring.user.save"))) }, h("form", { id: "user-job-form", onSubmit: (e: Event) => { void submit(e); } }, job && job.runAs !== me ? h("p", { class: "field-hint", role: "note" }, t("recurring.user.identityChange")) : null, h(Field, { id: "job-name", label: t("recurring.user.name") }, h("input", { id: "job-name", value: name, maxLength: 128, required: true, onInput: (e: Event) => setName((e.target as HTMLInputElement).value) })), h(Field, { id: "job-agent", label: t("recurring.user.agent") }, h("select", { id: "job-agent", value: agent, onChange: (e: Event) => setAgent((e.target as HTMLSelectElement).value) }, targets.map(id => h("option", { key: id, value: id }, id)))), h(Field, { id: "job-prompt", label: t("recurring.user.prompt") }, h("textarea", { id: "job-prompt", value: prompt, rows: 4, maxLength: 4000, required: true, onInput: (e: Event) => setPrompt((e.target as HTMLTextAreaElement).value) })), h(Field, { id: "job-cron", label: t("recurring.user.cron") }, h("input", { id: "job-cron", value: cron, required: true, onInput: (e: Event) => setCron((e.target as HTMLInputElement).value) })), h(Field, { id: "job-timezone", label: t("recurring.user.timezone") }, h("input", { id: "job-timezone", value: timezone, required: true, onInput: (e: Event) => setTimezone((e.target as HTMLInputElement).value) })), h("div", { class: "field" }, h("input", { id: "job-enabled", type: "checkbox", checked: enabled, onChange: (e: Event) => setEnabled((e.target as HTMLInputElement).checked) }), h("label", { for: "job-enabled" }, t("recurring.user.enabled"))), h("p", { class: "field-hint" }, t("recurring.user.preview")), preview.length === 3 ? h("ol", {}, preview.map(at => h("li", { key: at }, new Date(at).toLocaleString(undefined, { timeZone: timezone }), " · ", timezone))) : h("p", { class: "form-error", role: "alert" }, t("recurring.user.invalidSchedule")), error ? h("p", { class: "form-error", role: "alert" }, error) : null));
}
function JobHistory({ job, onClose }: {
    job: UserJob;
    onClose: () => void;
}): View {
    const { state, reload } = useLoad(async (signal) => { const out = await getApi().rpc("jobs.history", { kind: "user", job: job.id, limit: 50 }, { write: false, signal }); return out.runs.filter(r => "kind" in r && r.kind === "user") as UserJobRun[]; }, [job.id]);
    return h(Dialog, { title: t("recurring.user.history"), onClose }, state.status === "loading" ? h(PageLoading, { label: t("state.loading") }) : state.status === "fail" ? h(FailureState, { failure: state.failure, onRetry: reload }) : h("ul", { class: "plain-list" }, state.data.map(run => h("li", { key: run.runId }, formatDateTime(new Date(run.startedAt)), " · ", run.runAsDisplayName, " · ", run.outcome))));
}
export function UserJobsPanel({ jobs, targets, reload }: {
    jobs: UserJob[];
    targets: string[];
    reload: () => void;
}): View {
    const [editing, setEditing] = useState<UserJob | null | undefined>(undefined);
    const [deleting, setDeleting] = useState<UserJob | null>(null);
    const [history, setHistory] = useState<UserJob | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const inFlight = useRef(false);
    const remove = async () => { if (!deleting || inFlight.current)
        return; inFlight.current = true; setBusy(true); try {
        await getApi().rpc("jobs.delete", { id: deleting.id, confirm: true });
        setDeleting(null);
        reload();
    }
    catch {
        setError(t("recurring.user.failed"));
    }
    finally {
        inFlight.current = false;
        setBusy(false);
    } };
    return h(Card, { title: t("recurring.user.title"), level: 2 }, targets.length ? h("button", { type: "button", class: "btn", onClick: () => setEditing(null) }, t("recurring.user.create")) : null, jobs.length ? h("ul", { class: "plain-list" }, jobs.map(job => h("li", { key: job.id }, h("strong", {}, job.name), " · ", job.agentId, " · ", job.schedule.cron, " · ", job.schedule.timezone, " · ", job.runAs, h("button", { type: "button", class: "btn btn-quiet", onClick: () => setHistory(job) }, t("recurring.user.history")), targets.includes(job.agentId) ? [h("button", { type: "button", class: "btn btn-quiet", onClick: () => setEditing(job) }, t("recurring.user.edit")), h("button", { type: "button", class: "btn btn-quiet", onClick: () => { setError(""); setDeleting(job); } }, t("recurring.user.delete"))] : null))) : h("p", {}, t("recurring.user.empty")), editing !== undefined ? h(JobEditor, { job: editing, targets, onClose: () => setEditing(undefined), onSaved: reload }) : null, history ? h(JobHistory, { job: history, onClose: () => setHistory(null) }) : null, deleting ? h(Dialog, { title: t("recurring.user.delete"), onClose: () => setDeleting(null), actions: h("button", { type: "button", class: "btn btn-primary", disabled: busy, onClick: () => { void remove(); } }, t("recurring.user.delete")) }, h("p", {}, t("recurring.user.deleteConfirm", { name: deleting.name })), error ? h("p", { class: "form-error", role: "alert" }, error) : null) : null);
}
