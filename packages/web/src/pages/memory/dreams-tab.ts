// The "Dreams" tab (`#/memories/dreams[/<runId>]`): whether dreaming ever ran, per agent and phase (dreams.status), the schedule
// (dreams.schedule.get), the run ledger with each run's log (dreams.log), and, when the role allows, Run now / Enable / Disable.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { ListDetail } from "../../components/list-detail.ts";
import { PageState } from "../../components/page-state.ts";
import { formatNumber, t } from "../../i18n.ts";
import { navigate } from "../../router.ts";
import { Facts, FailureState, OutcomeBadge, Panel, duration, time } from "./common.ts";
import { allowed, currentRole, getApi, refused, useLoad } from "./data.ts";
import { phaseLabel, RunDialog, ToggleDialog, type DialogResult, type DreamsDialog } from "./dreams-actions.ts";
import type { DreamAgentStatus, DreamPhase, DreamPhaseStatus, DreamRun, DreamSchedule } from "./rpc-types.ts";

const PHASES: readonly DreamPhase[] = ["light", "rem", "deep"];

function Never(): View { return h(Badge, { tone: "warn" }, t("memory.dreams.never")); }

function Hint({ id, text }: { id: string; text: string }): View { return h("p", { id, class: "m-muted" }, text); }

type PhaseProps = {
  agentId: string; phase: DreamPhaseStatus; schedule: DreamSchedule | undefined;
  onAction: (d: DreamsDialog) => void;
};

function PhaseCard({ agentId, phase, schedule, onAction }: PhaseProps): View {
  void refused.value; // subscribe: a server refusal re-renders the buttons
  const s = schedule ?? phase;
  const run = phase.lastRun;
  const canRun = allowed("dreams.run");
  const canToggle = allowed("dreams.schedule");
  const id = `${agentId}-${phase.phase}`;
  const serverRefusedRun = refused.value.has("dreams.run");
  const serverRefusedSchedule = refused.value.has("dreams.schedule");
  return h(Panel, {
    title: phaseLabel(phase.phase), level: 3,
    aside: h("span", { class: "m-row" },
      s.enabled ? h(Badge, { tone: "ok" }, t("memory.dreams.enabled")) : h(Badge, {}, t("memory.dreams.disabled")),
      phase.running ? h(Badge, { tone: "info" }, t("memory.dreams.running")) : null,
      phase.breaker.state === "open" ? h(Badge, { tone: "err" }, t("memory.dreams.breakerOpen")) : null),
  },
  h("div", { class: "m-stack" },
    h(Facts, { rows: [
      [t("memory.dreams.schedule"), `${s.cron} (${s.timezone})`],
      [t("memory.dreams.next"), s.enabled ? time(s.nextRunAt) : t("memory.dreams.nextDisabled")],
      [t("memory.dreams.last"), run === null
        ? h(Never, {})
        : h("span", { class: "m-row" }, h(OutcomeBadge, { outcome: run.outcome }), h("span", {}, time(run.startedAt)), h("span", { class: "m-muted" }, t(`memory.trigger.${run.trigger}`)))],
      run !== null && run.reason ? [t("memory.dreams.reason"), run.reason] : [t("memory.dreams.reason"), undefined],
      run !== null && run.error ? [t("memory.dreams.error"), run.error.message] : [t("memory.dreams.error"), undefined],
      [t("memory.dreams.importance"), t("memory.dreams.importanceValue", { acc: formatNumber(phase.importance.accumulated), threshold: formatNumber(phase.importance.threshold), captures: phase.importance.capturesSinceRun })],
      [t("memory.dreams.breaker"), phase.breaker.state === "open"
        ? t("memory.dreams.breakerOpenText", { until: time(phase.breaker.until), reason: phase.breaker.reason ?? t("memory.none") })
        : t("memory.dreams.breakerClosedText", { used: phase.breaker.sessionsUsed, limit: phase.breaker.limit })],
    ] }),
    h("div", { class: "m-row" },
      run === null ? null : h("a", { class: "btn btn-quiet", href: `#/memories/dreams/${encodeURIComponent(run.runId)}` }, t("memory.dreams.lastDetails")),
      h("button", {
        type: "button", class: "btn", "aria-disabled": String(!canRun), ...(canRun ? {} : { "aria-describedby": `${id}-run-hint` }),
        onClick: () => { if (canRun) onAction({ kind: "run", agentId, phase: phase.phase }); },
      }, t("memory.dreams.runNow")),
      h("button", {
        type: "button", class: "btn", "aria-disabled": String(!canToggle), ...(canToggle ? {} : { "aria-describedby": `${id}-sched-hint` }),
        onClick: () => { if (canToggle) onAction({ kind: "toggle", agentId, phase: phase.phase, enable: !s.enabled }); },
      }, s.enabled ? t("memory.dreams.disable") : t("memory.dreams.enable"))),
    canRun ? null : h(Hint, { id: `${id}-run-hint`, text: serverRefusedRun ? t("memory.denied.run") : t("memory.dreams.noRun", { role: currentRole() ?? "" }) }),
    canToggle ? null : h(Hint, { id: `${id}-sched-hint`, text: serverRefusedSchedule ? t("memory.denied.schedule") : t("memory.dreams.noSchedule", { role: currentRole() ?? "" }) })));
}

function AgentSection({ agent, tick, onAction }: { agent: DreamAgentStatus; tick: number; onAction: (d: DreamsDialog) => void }): View {
  const sched = useLoad((signal) => getApi().rpc("dreams.schedule.get", { agentId: agent.agentId }, { write: false, signal }), [agent.agentId], tick);
  const schedules = sched.state.status === "ok" ? sched.state.data.schedules : [];
  return h(Panel, {
    title: agent.agentId,
    aside: agent.diary === null ? h(Badge, {}, t("memory.dreams.noDiary")) : agent.diary.exists ? h(Badge, { tone: "ok" }, t("memory.dreams.diaryExists")) : h(Badge, { tone: "warn" }, t("memory.dreams.diaryMissing")),
  },
  h("div", { class: "m-stack" },
    agent.diary === null ? null : h(Facts, { rows: [[t("memory.dreams.diary"), `${agent.diary.path} (${t("memory.dreams.bytes", { n: formatNumber(agent.diary.bytes) })})`]] }),
    sched.state.status === "fail" ? h("p", { class: "m-muted" }, sched.state.failure.kind === "forbidden" ? t("memory.dreams.scheduleForbidden") : t("memory.dreams.scheduleUnavailable")) : null,
    PHASES.map((p) => {
      const ph = agent.phases.find((x) => x.phase === p);
      return ph ? h(PhaseCard, { key: p, agentId: agent.agentId, phase: ph, schedule: schedules.find((x) => x.phase === p), onAction }) : null;
    })));
}

function Summary({ agents }: { agents: DreamAgentStatus[] }): View {
  const runs = agents.flatMap((a) => a.phases.flatMap((p) => (p.lastRun ? [p.lastRun] : [])));
  const total = agents.reduce((n, a) => n + a.phases.length, 0);
  const latest = runs.reduce<DreamRun | null>((m, r) => (m === null || r.startedAt > m.startedAt ? r : m), null);
  const failed = runs.filter((r) => r.outcome === "failed").length;
  return h(Panel, { title: t("memory.dreams.summary"), aside: latest === null ? h(Never, {}) : h(OutcomeBadge, { outcome: latest.outcome }) },
    h("div", { class: "m-stack" },
      latest === null
        ? h("p", { role: "status" }, t("memory.dreams.neverDetail", { n: total }))
        : h(Facts, { rows: [
          [t("memory.dreams.latest"), `${phaseLabel(latest.phase)} / ${latest.agentId}, ${time(latest.startedAt)}`],
          [t("memory.dreams.phasesRan"), t("memory.dreams.phasesRanValue", { ran: runs.length, total })],
          failed > 0 ? [t("memory.dreams.failedPhases"), String(failed)] : [t("memory.dreams.failedPhases"), undefined],
        ] }),
      h("p", { class: "m-muted" }, t("memory.dreams.sources"))));
}

function Counters({ c }: { c: { runs: Record<string, number>; skips: Record<string, number>; triggers: Record<string, number>; breakerTrips: number; reconciled: number } }): View {
  const line = (o: Record<string, number>): string => Object.entries(o).map(([k, v]) => `${k} ${formatNumber(v)}`).join(", ") || t("memory.none");
  return h(Panel, { title: t("memory.dreams.counters") },
    h(Facts, { rows: [
      [t("memory.dreams.countersRuns"), line(c.runs)], [t("memory.dreams.countersSkips"), line(c.skips)], [t("memory.dreams.countersTriggers"), line(c.triggers)],
      [t("memory.dreams.countersTrips"), formatNumber(c.breakerTrips)], [t("memory.dreams.countersReconciled"), formatNumber(c.reconciled)],
    ] }));
}

function RunItem({ r, selected }: { r: DreamRun; selected: boolean }): View {
  return h("li", {},
    h("a", { class: "nav-link", href: `#/memories/dreams/${encodeURIComponent(r.runId)}`, ...(selected ? { "aria-current": "true" } : {}) },
      h("span", { class: "m-item" },
        h("span", { class: "m-row" }, h("strong", { class: "m-strong" }, `${phaseLabel(r.phase)} / ${r.agentId}`), h(OutcomeBadge, { outcome: r.outcome })),
        h("span", { class: "m-muted" }, `${time(r.startedAt)}, ${t(`memory.trigger.${r.trigger}`)}`),
        r.error ? h("span", { class: "m-wrap" }, r.error.message) : r.reason ? h("span", { class: "m-wrap" }, r.reason) : null)));
}

function RunDetail({ runId }: { runId: string }): View {
  const { state, reload } = useLoad((signal) => getApi().rpc("dreams.log", { runId }, { write: false, signal }), [runId]);
  if (state.status === "loading") return h(PageState, { state: "loading" });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("memory.dreams.logUnavailable"), notFound: t("memory.dreams.runNotFound"), onRetry: reload });
  const r = state.data.runs[0];
  if (!r) return h(PageState, { state: "empty", title: t("memory.dreams.runNotFound"), detail: t("memory.notFound.detail") });
  const counts = Object.entries(r.counts).map(([k, v]) => `${k}: ${formatNumber(v)}`).join(", ");
  const log = state.data.log;
  return h(Panel, { title: `${phaseLabel(r.phase)} / ${r.agentId}` },
    h("div", { class: "m-stack" },
      h("p", {}, h(OutcomeBadge, { outcome: r.outcome })),
      r.error ? h("p", { class: "form-error m-wrap", role: "alert" }, r.error.message) : null,
      h(Facts, { rows: [
        [t("memory.dreams.runId"), r.runId], [t("memory.dreams.job"), r.jobId], [t("memory.dreams.trigger"), t(`memory.trigger.${r.trigger}`)],
        [t("memory.dreams.reason"), r.reason ?? t("memory.none")],
        [t("memory.dreams.started"), time(r.startedAt)], [t("memory.dreams.finished"), r.finishedAt == null ? t("memory.dreams.notFinished") : time(r.finishedAt)],
        [t("memory.dreams.duration"), duration(r.durationMs)],
        [t("memory.dreams.counts"), counts === "" ? t("memory.none") : counts],
        [t("memory.dreams.tokens"), r.tokensIn == null && r.tokensOut == null ? t("memory.none") : t("memory.dreams.tokensValue", { in: formatNumber(r.tokensIn ?? 0), out: formatNumber(r.tokensOut ?? 0) })],
        [t("memory.dreams.logFile"), r.logPath ?? t("memory.none")],
      ] }),
      h("div", {}, h("h3", { class: "m-sub" }, t("memory.dreams.log")),
        log === undefined || log.trim() === ""
          ? h("p", { class: "m-muted" }, t("memory.dreams.noLog"))
          : h("pre", { class: "m-pre", tabIndex: 0, "aria-label": t("memory.dreams.log") }, log))));
}

function RunLog({ runId, tick }: { runId: string | null; tick: number }): View {
  const [phase, setPhase] = useState<DreamPhase | "">("");
  const { state, reload } = useLoad((signal) => getApi().rpc("dreams.log", { limit: 50, ...(phase === "" ? {} : { phase }) }, { write: false, signal }), [phase], tick);
  let list: View;
  if (state.status === "loading") list = h(PageState, { state: "loading" });
  else if (state.status === "fail") list = h(FailureState, { failure: state.failure, unavailable: t("memory.dreams.logUnavailable"), onRetry: reload });
  else if (state.data.runs.length === 0) list = h(PageState, { state: "empty", title: t("memory.dreams.noRuns"), detail: t("memory.dreams.noRunsDetail") });
  else list = h("ul", { class: "plain-list" }, state.data.runs.map((r) => h(RunItem, { key: r.runId, r, selected: r.runId === runId })));
  return h(ListDetail, {
    selected: runId !== null, listLabel: t("memory.dreams.runList"), detailLabel: t("memory.dreams.runDetail"), onBack: () => { navigate("/memories/dreams"); },
    list: h("div", { class: "m-stack" },
      h("div", { class: "inline-field" },
        h("label", { for: "dreams-phase" }, t("memory.dreams.filterPhase")),
        h("select", { id: "dreams-phase", value: phase, onChange: (e: Event) => setPhase((e.target as HTMLSelectElement).value as DreamPhase | "") },
          h("option", { value: "", selected: phase === "" }, t("memory.dreams.allPhases")),
          PHASES.map((p) => h("option", { key: p, value: p, selected: p === phase }, phaseLabel(p))))),
      list),
    detail: runId === null ? null : h(RunDetail, { key: runId, runId }),
  });
}

export type DreamsTabProps = { runId: string | null; tick: number };

export function DreamsTab({ runId, tick }: DreamsTabProps): View {
  const [bump, setBump] = useState(0);
  const [dialog, setDialog] = useState<DreamsDialog | null>(null);
  const [notice, setNotice] = useState<DialogResult | null>(null);
  const all = tick + bump;
  const { state, reload } = useLoad((signal) => getApi().rpc("dreams.status", undefined, { write: false, signal }), [], all);

  const done = (r: DialogResult): void => { setDialog(null); setNotice(r); setBump((n) => n + 1); };
  const body: View = state.status === "loading" ? h(PageState, { state: "loading" })
    : state.status === "fail" ? h(FailureState, { failure: state.failure, unavailable: t("memory.dreams.unavailable"), onRetry: reload })
    : state.data.agents.length === 0 ? h(PageState, { state: "empty", title: t("memory.dreams.noAgents"), detail: t("memory.dreams.noAgentsDetail") })
    : h("div", { class: "m-stack" },
      h(Summary, { agents: state.data.agents }),
      state.data.agents.map((a) => h(AgentSection, { key: a.agentId, agent: a, tick: all, onAction: setDialog })),
      h(Counters, { c: state.data.counters }));

  return h("div", { class: "m-stack" },
    notice ? h("p", { class: "form-notice", role: "status" }, notice.text, " ", notice.runId ? h("a", { href: `#/memories/dreams/${encodeURIComponent(notice.runId)}` }, t("memory.dreams.openRun")) : null) : null,
    body,
    h("h2", { class: "m-section" }, t("memory.dreams.runs")),
    state.status === "fail" && state.failure.kind === "unavailable" ? null : h(RunLog, { runId, tick: all }),
    dialog?.kind === "run" ? h(RunDialog, { agentId: dialog.agentId, phase: dialog.phase, onClose: () => setDialog(null), onDone: done }) : null,
    dialog?.kind === "toggle" ? h(ToggleDialog, { agentId: dialog.agentId, phase: dialog.phase, enable: dialog.enable, onClose: () => setDialog(null), onDone: done }) : null);
}
