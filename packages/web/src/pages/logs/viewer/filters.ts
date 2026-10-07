// The filter form of the log viewer. Edits stay in a draft until "Apply filters" (or Enter) so a half-typed text does not fire a
// query; a draft that cannot be sent (trace id plus text, inverted range) shows its error and sends nothing.
import { h } from "preact";
import type { View } from "../../../view.ts";
import { t, type Key } from "../../../i18n.ts";
import { bad, Field } from "../../common/field.ts";
import { LEVELS, type BuildError, type Filters, type Order, type Range, type Stream } from "./model.ts";

export type FilterBarProps = { draft: Filters; error: BuildError | null; onChange: (patch: Partial<Filters>) => void; onApply: () => void; onClear: () => void };
const RANGES: Range[] = ["any", "15m", "1h", "24h", "custom"];

export function FilterBar({ draft, error, onChange, onApply, onClear }: FilterBarProps): View {
  const audit = draft.stream === "audit";
  const on = <K extends keyof Filters>(key: K) => (e: Event): void => { onChange({ [key]: (e.target as HTMLInputElement | HTMLSelectElement).value } as Pick<Filters, K>); };
  const err = (...which: BuildError[]): string | undefined => (error && which.includes(error) ? t(`logs.err.${error}`) : undefined);
  const sel = (id: string, label: Key, value: string, options: readonly (readonly [string, string])[], change: (e: Event) => void, extra: Record<string, unknown> = {}): View =>
    h(Field, { id, label: t(label), ...(extra.hint ? { hint: String(extra.hint) } : {}) },
      h("select", { id, value, onChange: change, ...(extra.disabled ? { disabled: true, "aria-describedby": `${id}-hint` } : {}) }, options.map(([v, text]) => h("option", { key: v, value: v, selected: v === value }, text))));
  return h("form", { class: "logs-filters", role: "search", "aria-label": t("logs.filters"), noValidate: true, onSubmit: (e: Event) => { e.preventDefault(); onApply(); } },
    sel("logs-stream", "logs.f.stream", draft.stream, [["diagnostic", t("logs.f.stream.diagnostic")], ["audit", t("logs.f.stream.audit")]], on("stream") as (e: Event) => void),
    sel("logs-level", "logs.f.level", audit ? "" : draft.minLevel, [["", t("logs.f.level.any")], ...LEVELS.map((l) => [l, t(`logs.level.${l}`)] as const)], on("minLevel"),
      audit ? { disabled: true, hint: t("logs.f.level.auditNote") } : {}),
    h(Field, { id: "logs-component", label: t("logs.f.component"), hint: t("logs.f.component.hint") },
      h("input", { id: "logs-component", type: "text", maxLength: 64, value: draft.component, onInput: on("component"), "aria-describedby": "logs-component-hint" })),
    h(Field, { id: "logs-text", label: t("logs.f.text"), hint: t("logs.f.text.hint") },
      h("input", { id: "logs-text", type: "search", maxLength: 256, value: draft.text, onInput: on("text"), "aria-describedby": "logs-text-hint" })),
    h(Field, { id: "logs-trace", label: t("logs.f.trace"), hint: t("logs.f.trace.hint"), error: err("both") },
      h("input", { id: "logs-trace", type: "text", maxLength: 256, value: draft.trace, onInput: on("trace"), spellcheck: false, autocomplete: "off", "aria-describedby": `logs-trace-hint${error === "both" ? " logs-trace-err" : ""}`, ...bad(err("both"), "logs-trace") })),
    sel("logs-range", "logs.f.range", draft.range, RANGES.map((r) => [r, t(`logs.range.${r}` as Key)] as const), on("range") as (e: Event) => void),
    draft.range === "custom" ? h(Field, { id: "logs-from", label: t("logs.f.from"), error: err("badDate", "emptyRange") },
      h("input", { id: "logs-from", type: "datetime-local", value: draft.from, onInput: on("from"), ...bad(err("badDate", "emptyRange"), "logs-from") })) : null,
    draft.range === "custom" ? h(Field, { id: "logs-to", label: t("logs.f.to") },
      h("input", { id: "logs-to", type: "datetime-local", value: draft.to, onInput: on("to") })) : null,
    sel("logs-order", "logs.f.order", draft.order, [["desc", t("logs.order.desc")], ["asc", t("logs.order.asc")]] as [Order, string][], on("order") as (e: Event) => void),
    h("div", { class: "logs-filter-actions" },
      h("button", { type: "submit", class: "btn btn-primary" }, t("logs.f.apply")),
      h("button", { type: "button", class: "btn", onClick: onClear }, t("logs.f.clear"))));
}
export type { Stream };
