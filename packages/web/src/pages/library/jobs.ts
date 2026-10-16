import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { t } from "../../i18n.ts";
import { getApi } from "../common/load.ts";
import { classifyFailure, classifyJobCode, eventJobId, isActive, TERMINAL_STATES, parseJob, parseJobList, type MediaFailure, type MediaJob } from "./media-model.ts";
import { FailureNote } from "./failure.ts";
import "../../styles/library-media.css";

const POLL_MS = 4000;
const RECENT = 5;

/** The job bar: running media jobs with progress and cancel, finished ones with a link to the result.
 *  media.job.progress / media.job.finished are only a hint that a job changed; every shown value comes from media.job.get, and
 *  media.job.list reloads the picture on mount and after the event stream reconnects (docs/media.md "MG-3 surfaces"). */
export function JobBar({ watch, onOpenOutput, onFinished }: {
  /** Job ids this page just started: fetched at once, before any event arrives. */
  watch: readonly string[];
  onOpenOutput: (outputId: string) => void;
  /** A job reached a final state: the gallery reloads. */
  onFinished: () => void;
}): View {
  const [jobs, setJobs] = useState<Record<string, MediaJob>>({});
  const [loadFailed, setLoadFailed] = useState<MediaFailure | null>(null);
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});
  const [cancelFailed, setCancelFailed] = useState<MediaFailure | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [reloaded, setReloaded] = useState(false);
  const known = useRef<Record<string, string>>({});
  const alive = useRef(true);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  // `quiet` is the list reload: jobs already finished then are history, not news (the gallery loaded after them).
  const apply = useCallback((incoming: MediaJob[], quiet = false): void => {
    if (!alive.current) return;
    let finished = false;
    for (const job of incoming) {
      const before = known.current[job.id];
      if (!quiet && !isActive(job) && before !== job.state && (before === undefined || TERMINAL_STATES.includes(before) === false)) finished = true;
      known.current[job.id] = job.state;
    }
    setJobs((prev) => {
      const next = { ...prev };
      for (const job of incoming) next[job.id] = job;
      return next;
    });
    if (finished) onFinishedRef.current();
  }, []);

  const loadOne = useCallback(async (id: string): Promise<void> => {
    try {
      const job = parseJob(await getApi().rpc("media.job.get", { id }, { write: false }));
      if (job) apply([job]);
    } catch { /* a job that cannot be read stays as it was; the list reload and the poll try again */ }
  }, [apply]);

  const loadAll = useCallback(async (signal?: AbortSignal, quiet = false): Promise<void> => {
    try {
      const list = parseJobList(await getApi().rpc("media.job.list", {}, { write: false, ...(signal ? { signal } : {}) }));
      if (alive.current && !signal?.aborted) { setLoadFailed(null); apply(list, quiet); }
    } catch (e) {
      if (alive.current && !signal?.aborted && (e as { kind?: string }).kind !== "aborted") setLoadFailed(classifyFailure(e));
    }
  }, [apply]);

  useEffect(() => {
    alive.current = true;
    const ctl = new AbortController();
    void loadAll(ctl.signal, true);
    let opened = false;
    const handle = getApi().events({
      onEvent: (ev) => {
        if (!ev.event.startsWith("media.job.")) return;
        const id = eventJobId(ev.data);
        if (id) void loadOne(id);
      },
    });
    const stop = handle.status.subscribe((s) => {
      if (s !== "open") return;
      if (opened) { void loadAll(); setReloaded(true); }
      opened = true;
    });
    return () => { alive.current = false; ctl.abort(); stop(); handle.close(); };
  }, []);

  useEffect(() => { for (const id of watch) void loadOne(id); }, [watch.join(",")]);

  const active = Object.values(jobs).filter(isActive);
  useEffect(() => {
    if (active.length === 0) return;
    const timer = setInterval(() => { for (const j of active) void loadOne(j.id); }, POLL_MS);
    return () => { clearInterval(timer); };
  }, [active.map((j) => j.id).join(",")]);

  const recent = Object.values(jobs).filter((j) => !isActive(j) && !dismissed[j.id]).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT);
  const shown = [...active.sort((a, b) => b.createdAt - a.createdAt), ...recent];

  const cancel = async (id: string): Promise<void> => {
    setCancelling((c) => ({ ...c, [id]: true }));
    setCancelFailed(null);
    try {
      await getApi().rpc("media.job.cancel", { id }, { write: true });
    } catch (e) {
      setCancelFailed(classifyFailure(e));
    }
    await loadOne(id);
    if (alive.current) setCancelling((c) => ({ ...c, [id]: false }));
  };

  return h("section", { class: "libmedia-jobs", "aria-labelledby": "libmedia-jobs-title" },
    h("h2", { id: "libmedia-jobs-title", class: "libmedia-h" }, t("libmedia.jobs.title")),
    h("p", { class: "libmedia-live", role: "status" }, active.length > 0 ? t("libmedia.jobs.live", { n: active.length }) : t("libmedia.jobs.empty")),
    reloaded ? h("p", { class: "field-hint" }, t("libmedia.jobs.reloaded")) : null,
    loadFailed ? h(FailureNote, { failure: loadFailed }) : null,
    cancelFailed ? h(FailureNote, { failure: cancelFailed }) : null,
    shown.length === 0 ? null : h("ul", { class: "libmedia-job-list" }, shown.map((job) => h(JobRow, {
      key: job.id, job, cancelling: cancelling[job.id] === true,
      onCancel: () => { void cancel(job.id); },
      onOpen: () => { onOpenOutput(job.outputId); },
      onDismiss: () => { setDismissed((d) => ({ ...d, [job.id]: true })); },
    }))));
}

function JobRow({ job, cancelling, onCancel, onOpen, onDismiss }: { job: MediaJob; cancelling: boolean; onCancel: () => void; onOpen: () => void; onDismiss: () => void }): View {
  const percent = Math.round(job.fraction * 100);
  const label = t("libmedia.jobs.item", { kind: job.kind === "video" ? t("libmedia.kind.video") : t("libmedia.kind.image"), adapter: job.adapter });
  const stateKey = (["queued", "running", "succeeded", "failed", "cancelled"] as const).find((s) => s === job.state);
  const failure = job.state === "failed" && job.error ? classifyJobCode(job.error) : null;
  return h("li", { class: "libmedia-job", "data-state": job.state, "data-job": job.id },
    h("div", { class: "libmedia-job-head" },
      h("span", { class: "libmedia-job-name" }, label),
      h("span", { class: "libmedia-job-state" }, stateKey ? t(`libmedia.jobs.state.${stateKey}`) : job.state,
        job.stage === "downloading" ? ` · ${t("libmedia.jobs.stage.downloading")}` : "")),
    isActive(job)
      ? h("div", { class: "libmedia-job-progress" },
          h("progress", { max: 100, value: percent, "aria-label": `${label}: ${t("libmedia.jobs.progress", { percent })}` }),
          h("span", { class: "libmedia-job-percent", "aria-hidden": "true" }, t("libmedia.jobs.progress", { percent })))
      : null,
    failure ? h(FailureNote, { failure }) : null,
    h("div", { class: "libmedia-job-actions" },
      isActive(job)
        ? h("button", { type: "button", class: "btn btn-quiet", disabled: cancelling, onClick: onCancel }, cancelling ? t("libmedia.jobs.cancelling") : t("libmedia.jobs.cancel"))
        : null,
      job.state === "succeeded" && job.outputId
        ? h("button", { type: "button", class: "btn", onClick: onOpen }, t("libmedia.jobs.open"))
        : null,
      !isActive(job) ? h("button", { type: "button", class: "btn btn-quiet", onClick: onDismiss }, t("libmedia.jobs.dismiss")) : null));
}
