// Dangerous Dreams actions behind a confirmation dialog: "Run now" (with the dry-run plan first) and enable / disable of a phase.
// A refusal by the server (E_DENIED) disables the action from then on and says why; it is never hidden.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { Dialog } from "../../components/dialog.ts";
import { PageState } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { Facts, failureText } from "./common.ts";
import { failureOf, getApi, markRefused, useLoad, type Failure } from "./data.ts";
import type { DreamPhase, DreamPlan, DreamRun } from "./rpc-types.ts";

export const phaseLabel = (p: DreamPhase): string => t(`memory.phase.${p}`);

export type DreamsDialog =
  | { kind: "run"; agentId: string; phase: DreamPhase }
  | { kind: "toggle"; agentId: string; phase: DreamPhase; enable: boolean };

export type DialogResult = { text: string; runId?: string };

const cancel = (onClose: () => void): View => h("button", { key: "cancel", type: "button", class: "btn", onClick: onClose }, t("memory.dialog.cancel"));

function ErrorLine({ failure, what }: { failure: Failure; what: "run" | "schedule" }): View {
  return h("p", { role: "alert", class: "form-error m-wrap" }, failureText(failure, what));
}

export function RunDialog({ agentId, phase, onClose, onDone }: { agentId: string; phase: DreamPhase; onClose: () => void; onDone: (r: DialogResult) => void }): View {
  const plan = useLoad(async (signal) => {
    try { return (await getApi().rpc("dreams.run", { agentId, phase, dryRun: true }, { signal })) as DreamPlan; } catch (e) {
      if (failureOf(e).kind === "forbidden") markRefused("dreams.run");
      throw e;
    }
  }, [agentId, phase]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const ready = plan.state.status === "ok" && plan.state.data.wouldRun && !busy;
  const confirm = (): void => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    getApi().rpc("dreams.run", { agentId, phase }).then(
      (r) => { const run = r as DreamRun; onDone({ text: t("memory.dialog.runDone", { phase: phaseLabel(phase), agent: agentId, run: run.runId, outcome: run.outcome ?? t("memory.outcome.open") }), runId: run.runId }); },
      (e: unknown) => { const f = failureOf(e); if (f.kind === "forbidden") markRefused("dreams.run"); setFailure(f); setBusy(false); },
    );
  };

  let body: View;
  const st = plan.state;
  if (st.status === "loading") body = h(PageState, { state: "loading", title: t("memory.dialog.planning") });
  else if (st.status === "fail") body = h(ErrorLine, { failure: st.failure, what: "run" });
  else {
    const p = st.data;
    body = h("div", { class: "m-stack" },
      h("p", {}, p.wouldRun ? h(Badge, { tone: "ok" }, t("memory.dialog.wouldRun")) : h(Badge, { tone: "warn" }, t("memory.dialog.wouldNotRun"))),
      p.wouldRun ? null : h("p", {}, t("memory.dialog.skipReason", { reason: p.reason ?? t("memory.none") })),
      h(Facts, { rows: [
        [t("memory.dialog.jobs"), p.jobs.length === 0 ? t("memory.none") : p.jobs.join(", ")],
        [t("memory.dialog.counts"), Object.entries(p.counts).map(([k, v]) => `${k}: ${v}`).join(", ") || t("memory.none")],
        [t("memory.dialog.key"), p.idempotencyKey],
      ] }));
  }

  return h(Dialog, {
    title: t("memory.dialog.runTitle", { phase: phaseLabel(phase), agent: agentId }), onClose,
    actions: [
      cancel(onClose),
      h("button", { key: "go", type: "button", class: "btn btn-primary", "aria-disabled": String(!ready), onClick: confirm }, busy ? t("memory.dialog.running") : t("memory.dialog.runNow")),
    ],
  },
  h("div", { class: "m-stack" }, h("p", {}, t("memory.dialog.runBody")), body, failure ? h(ErrorLine, { failure, what: "run" }) : null));
}

export function ToggleDialog({ agentId, phase, enable, onClose, onDone }: { agentId: string; phase: DreamPhase; enable: boolean; onClose: () => void; onDone: (r: DialogResult) => void }): View {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    getApi().rpc(enable ? "dreams.enable" : "dreams.disable", { agentId, phase }).then(
      () => { onDone({ text: t(enable ? "memory.dialog.enabled" : "memory.dialog.disabled", { phase: phaseLabel(phase), agent: agentId }) }); },
      (e: unknown) => { const f = failureOf(e); if (f.kind === "forbidden") markRefused("dreams.schedule"); setFailure(f); setBusy(false); },
    );
  };
  return h(Dialog, {
    title: t(enable ? "memory.dialog.enableTitle" : "memory.dialog.disableTitle", { phase: phaseLabel(phase), agent: agentId }), onClose,
    actions: [
      cancel(onClose),
      h("button", { key: "go", type: "button", class: "btn btn-primary", "aria-disabled": String(busy), onClick: confirm }, enable ? t("memory.dialog.enable") : t("memory.dialog.disable")),
    ],
  },
  h("div", { class: "m-stack" }, h("p", {}, t(enable ? "memory.dialog.enableBody" : "memory.dialog.disableBody")), failure ? h(ErrorLine, { failure, what: "schedule" }) : null));
}
