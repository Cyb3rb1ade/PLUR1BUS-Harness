// Small shared pieces of the Memories & Dreams page: failure states, time formatting, badges for outcomes.
import { h, type ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, type BadgeTone } from "../../components/card.ts";
import { PageState } from "../../components/page-state.ts";
import { formatDateTime, formatNumber, t, type Key } from "../../i18n.ts";
import type { Failure } from "./data.ts";
import type { DreamOutcome, MemoryScope } from "./rpc-types.ts";

export type FailureStateProps = {
  failure: Failure;
  /** Title of the "this part is not served" state, e.g. t("memory.list.unavailable"). */
  unavailable: string;
  /** Title of the not-found state (only used when the failure is a not-found). */
  notFound?: string;
  onRetry?: () => void;
};

/** One mapping of a failed area onto the shared page states: unavailable (with the area's own words), forbidden, error (retry). */
export function FailureState({ failure, unavailable, notFound, onRetry }: FailureStateProps): View {
  const retry = onRetry ? { onRetry } : {};
  switch (failure.kind) {
    case "unavailable": return h(PageState, { state: "unavailable", title: unavailable, detail: t("memory.unavailable.detail"), ...retry });
    case "forbidden": return h(PageState, { state: "forbidden" });
    case "not-found": return h(PageState, { state: "empty", title: notFound ?? t("state.empty.title"), detail: t("memory.notFound.detail") });
    default: return h(PageState, { state: "error", ...retry });
  }
}

/** One line for a failed dangerous action; `what` picks the wording of a refusal. */
export function failureText(f: Failure, what: "run" | "schedule"): string {
  switch (f.kind) {
    case "forbidden": return t(what === "run" ? "memory.denied.run" : "memory.denied.schedule");
    case "unavailable": return t("memory.action.unavailable");
    default: return f.message === "" ? t("memory.action.failed") : t("memory.action.failedWith", { message: f.message });
  }
}

export function scopeLabel(s: MemoryScope): string {
  return t(s === "agent-private" ? "memory.scope.agentPrivate" : s === "workspace" ? "memory.scope.workspace" : "memory.scope.user");
}

export function time(ms: number | null | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? formatDateTime(new Date(ms)) : t("memory.none");
}

export function duration(ms: number | null | undefined): string {
  if (typeof ms !== "number") return t("memory.none");
  if (ms < 1000) return `${formatNumber(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${formatNumber(s)} s`;
  if (s < 3600) return `${formatNumber(Math.floor(s / 60))} min ${formatNumber(s % 60)} s`;
  return `${formatNumber(Math.floor(s / 3600))} h ${formatNumber(Math.floor((s % 3600) / 60))} min`;
}

const OUTCOME: Record<DreamOutcome, { tone: BadgeTone; label: Key }> = {
  completed: { tone: "ok", label: "memory.outcome.completed" },
  skipped: { tone: "info", label: "memory.outcome.skipped" },
  failed: { tone: "err", label: "memory.outcome.failed" },
  aborted: { tone: "warn", label: "memory.outcome.aborted" },
};

/** Outcome of a run as a badge; `null` is an open run (still running or never closed). */
export function OutcomeBadge({ outcome }: { outcome: DreamOutcome | null }): View {
  if (outcome === null) return h(Badge, { tone: "warn" }, t("memory.outcome.open"));
  const o = OUTCOME[outcome];
  return h(Badge, { tone: o.tone }, t(o.label));
}

/** The shared Card, with a heading that wraps: the shared Card title does not break an unbroken string (an agent id, a card
 *  summary), which would push the page into horizontal scrolling. Same markup and classes, so it looks like every Card. */
export function Panel({ title, level = 2, aside, children }: { title: string; level?: 2 | 3; aside?: ComponentChildren; children?: ComponentChildren }): View {
  const id = useId();
  return h("div", { class: "card", role: "group", "aria-labelledby": id },
    h("div", { class: "card-head" }, h(`h${level}`, { id, class: "card-title" }, title), aside ?? null),
    children);
}

/** A `<dl>` of label/value rows; values may be views. Rows with `undefined` are skipped. */
export function Facts({ rows }: { rows: readonly (readonly [string, string | View | null | undefined])[] }): View {
  return h("dl", { class: "facts" }, rows.filter((r) => r[1] !== undefined).map(([k, v]) => [
    h("dt", { key: `${k}-t` }, k),
    h("dd", { key: `${k}-d` }, v ?? t("memory.none")),
  ]));
}
