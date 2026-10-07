import { h, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Dialog } from "../../components/dialog.ts";
import { t, type Key } from "../../i18n.ts";
import { buildSetParams, microsToInput, parseAmount, type Limit, type LimitKey } from "./model.ts";
import type { BudgetMetric, BudgetPeriodName } from "./rpc-types.ts";
import { amount, budgetApi, fullTitle, isForbidden, limitKey, limitTitle } from "./shared.ts";

type Bounds = { soft: number | null; hard: number | null };
type Errors = Partial<Record<"agent" | "soft" | "hard" | "none", string>>;

function Field({ id, label, error, children }: { id: string; label: string; error?: string | undefined; children?: ComponentChildren }): View {
  return h("div", { class: "field" }, h("label", { for: id }, label), children, error ? h("p", { class: "form-error", id: `${id}-err` }, error) : null);
}

const bad = (e: string | undefined, id: string): Record<string, unknown> => (e ? { "aria-invalid": true, "aria-describedby": `${id}-err` } : {});

async function save(key: LimitKey, next: Bounds, before: Bounds | null): Promise<void> {
  await budgetApi().rpc("budget.set", buildSetParams(key, next, before));
}

/** Set a new limit or edit one, in two steps: the form, then a review that says what will be sent (a cleared bound is named). Nothing
 *  is sent before "Confirm and save". An existing limit with the same scope, agent, period and metric is changed, not duplicated. */
export function LimitDialog({ limit, limits, onClose, onSaved }: { limit?: Limit; limits: readonly Limit[]; onClose: () => void; onSaved: () => void }): View {
  const edit = limit !== undefined;
  const [scope, setScope] = useState<"global" | "agent">(limit?.scope === "agent" ? "agent" : "global");
  const [agent, setAgent] = useState(limit?.agentId ?? "");
  const [period, setPeriod] = useState<BudgetPeriodName>(limit?.period ?? "day");
  const [metric, setMetric] = useState<BudgetMetric>(limit?.metric ?? "cost");
  const text = (b: number | null): string => (b === null ? "" : metric === "cost" ? microsToInput(b) : String(b));
  const [soft, setSoft] = useState(text(limit?.soft ?? null));
  const [hard, setHard] = useState(text(limit?.hard ?? null));
  const [step, setStep] = useState<"form" | "review">("form");
  const [errors, setErrors] = useState<Errors>({});
  const [parsed, setParsed] = useState<Bounds>({ soft: null, hard: null });
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const first = useRef(true);
  // After the step changes the focused button is gone: put focus on the dialog heading so keyboard and screen-reader users land in the new step.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const heading = document.querySelector<HTMLElement>("dialog[open] .dialog-head h2");
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  }, [step]);

  const key: LimitKey = { scope, ...(scope === "agent" ? { agentId: agent.trim() } : {}), period, metric };
  const existing = edit ? limit : limits.find((l) => limitKey(l) === limitKey(key)) ?? null;
  const before: Bounds | null = existing ? { soft: existing.soft, hard: existing.hard } : null;

  const review = (): void => {
    const errs: Errors = {};
    if (scope === "agent" && agent.trim() === "") errs.agent = t("budget.err.agent");
    else if (agent.trim().length > 128) errs.agent = t("budget.err.agentLength");
    const s = parseAmount(metric, soft), hd = parseAmount(metric, hard);
    const invalid = metric === "cost" ? t("budget.err.cost") : t("budget.err.tokens");
    if (s === "invalid") errs.soft = invalid;
    if (hd === "invalid") errs.hard = invalid;
    if (s !== "invalid" && hd !== "invalid") {
      if (s !== null && hd !== null && s > hd) errs.soft = t("budget.err.order");
      else if (s === null && hd === null && !(before && (before.soft !== null || before.hard !== null))) errs.none = t("budget.err.none");
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0 || s === "invalid" || hd === "invalid") return;
    setParsed({ soft: s, hard: hd });
    setFailure("");
    setStep("review");
  };

  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setFailure("");
    try { await save(key, parsed, before); onSaved(); } catch (e) { setFailure(isForbidden(e) ? t("budget.err.forbidden") : t("budget.err.failed")); setBusy(false); }
  };

  const shown = (b: "soft" | "hard"): string => {
    const v = parsed[b];
    if (v !== null) return amount(metric, v);
    return before?.[b] != null ? t("budget.cleared") : t("budget.field.notSet");
  };

  const scopeText = t(scope === "agent" ? "budget.scope.agent" : "budget.scope.global");
  const title = step === "review" ? t("budget.dlg.reviewTitle") : edit ? t("budget.dlg.editTitle", { title: fullTitle(limit) }) : t("budget.dlg.setTitle");

  if (step === "review") {
    return h(Dialog, {
      title, onClose,
      actions: [
        h("button", { key: "b", type: "button", class: "btn", onClick: () => { setFailure(""); setStep("form"); } }, t("budget.back")),
        h("button", { key: "c", type: "button", class: "btn btn-primary", "aria-disabled": busy, onClick: () => { void confirm(); } }, t("budget.confirm")),
      ],
    },
      h("p", { class: "form-error", role: "alert" }, failure),
      h("dl", { class: "facts" },
        h("div", {}, h("dt", {}, t("budget.field.scope")), h("dd", {}, scopeText)),
        scope === "agent" ? h("div", {}, h("dt", {}, t("budget.field.agent")), h("dd", {}, agent.trim())) : null,
        h("div", {}, h("dt", {}, t("budget.field.period")), h("dd", {}, t(`budget.period.${period}` as Key))),
        h("div", {}, h("dt", {}, t("budget.field.metric")), h("dd", {}, t(`budget.metric.${metric}` as Key))),
        h("div", {}, h("dt", {}, t("budget.field.soft")), h("dd", {}, shown("soft"))),
        h("div", {}, h("dt", {}, t("budget.field.hard")), h("dd", {}, shown("hard")))));
  }

  const input = (id: string, label: string, value: string, set: (v: string) => void, err: string | undefined): View =>
    h(Field, { id, label, error: err }, h("input", { id, type: "text", inputMode: metric === "cost" ? "decimal" : "numeric", value, ...bad(err, id), onInput: (e: Event) => set((e.target as HTMLInputElement).value) }));
  const select = <V extends string>(id: string, label: string, value: V, options: readonly (readonly [V, string])[], set: (v: V) => void): View =>
    h(Field, { id, label }, h("select", { id, value, onChange: (e: Event) => set((e.target as HTMLSelectElement).value as V) }, options.map(([v, text]) => h("option", { key: v, value: v, selected: v === value }, text))));

  return h(Dialog, {
    title, onClose,
    actions: [
      h("button", { key: "x", type: "button", class: "btn", onClick: onClose }, t("budget.cancel")),
      h("button", { key: "r", type: "button", class: "btn btn-primary", onClick: review }, t("budget.review")),
    ],
  },
    h("p", { class: "reading" }, edit ? t("budget.form.editHint") : t("budget.form.newHint"), " ", metric === "cost" ? t("budget.form.costHint") : t("budget.form.tokensHint")),
    errors.none ? h("p", { class: "form-error", role: "alert" }, errors.none) : null,
    edit
      ? h("dl", { class: "facts" },
        h("div", {}, h("dt", {}, t("budget.field.scope")), h("dd", {}, scopeText)),
        scope === "agent" ? h("div", {}, h("dt", {}, t("budget.field.agent")), h("dd", {}, agent)) : null,
        h("div", {}, h("dt", {}, t("budget.field.period")), h("dd", {}, t(`budget.period.${period}` as Key))),
        h("div", {}, h("dt", {}, t("budget.field.metric")), h("dd", {}, t(`budget.metric.${metric}` as Key))))
      : [
        select("lm-scope", t("budget.field.scope"), scope, [["global", t("budget.scope.global")], ["agent", t("budget.scope.agent")]], setScope),
        scope === "agent" ? input("lm-agent", t("budget.form.agent"), agent, setAgent, errors.agent) : null,
        select("lm-period", t("budget.field.period"), period, [["day", t("budget.period.day")], ["month", t("budget.period.month")]], setPeriod),
        select("lm-metric", t("budget.field.metric"), metric, [["cost", t("budget.metric.cost")], ["tokens", t("budget.metric.tokens")]], setMetric),
      ],
    input("lm-soft", t("budget.form.soft"), soft, setSoft, errors.soft),
    input("lm-hard", t("budget.form.hard"), hard, setHard, errors.hard));
}

/** Confirm removing a limit: it clears both bounds, and a limit with no bound left is removed by the server. */
export function RemoveLimitDialog({ limit, onClose, onRemoved }: { limit: Limit; onClose: () => void; onRemoved: () => void }): View {
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const remove = async (): Promise<void> => {
    if (busy || (limit.scope !== "global" && limit.scope !== "agent")) return;
    setBusy(true); setFailure("");
    try { await save({ scope: limit.scope, ...(limit.agentId ? { agentId: limit.agentId } : {}), period: limit.period, metric: limit.metric }, { soft: null, hard: null }, { soft: limit.soft, hard: limit.hard }); onRemoved(); }
    catch (e) { setFailure(isForbidden(e) ? t("budget.err.forbidden") : t("budget.err.failed")); setBusy(false); }
  };
  return h(Dialog, {
    title: t("budget.dlg.removeTitle"), onClose,
    actions: [
      h("button", { key: "c", type: "button", class: "btn", onClick: onClose }, t("budget.cancel")),
      h("button", { key: "r", type: "button", class: "btn btn-primary", "aria-disabled": busy, onClick: () => { void remove(); } }, t("budget.remove")),
    ],
  },
    h("p", { class: "form-error", role: "alert" }, failure),
    h("p", {}, t("budget.removeConfirm", { title: fullTitle(limit) })),
    h("p", { class: "reading" }, t("budget.removeBody")),
    h("p", { class: "reading" }, `${limitTitle(limit)}: ${limit.soft === null ? "–" : amount(limit.metric, limit.soft)} / ${limit.hard === null ? "–" : amount(limit.metric, limit.hard)}`));
}
