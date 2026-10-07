// Rendering of one config field and of the groups: label, key, widget by kind, default, restart badge, help, error. Controls are
// `id="cfg-<key with dots as dashes>"` (the anchor of the palette's deep links) and point at their hint and error with aria-describedby.
import { h } from "preact";
import type { View } from "../../../view.ts";
import { Badge } from "../../../components/card.ts";
import { t } from "../../../i18n.ts";
import { SETTINGS } from "../../../palette/settings-index.ts";
import { effective, redact, restartKind, show, type Draft, type Field } from "./model.ts";
import { fieldId, humanize } from "./meta.ts";

const HELP = new Map(SETTINGS.filter((s) => s.help).map((s) => [s.key, s.help as string]));

export function RestartBadge({ cls }: { cls: string | null }): View {
  const kind = restartKind(cls);
  if (kind === "live") return h(Badge, { tone: "ok" }, t("settings.cfg.restart.live"));
  if (kind === "unknown") return h(Badge, { tone: "neutral" }, t("settings.cfg.restart.unknown"));
  return h(Badge, { tone: "warn" }, cls !== null && cls.startsWith("module:") ? t("settings.cfg.restart.module", { name: cls.slice(7) }) : t("settings.cfg.restart.core"));
}

const defaultText = (f: Field): string => {
  const d = f.def;
  if (d === undefined) return t("settings.cfg.noDefault");
  return t("settings.cfg.default", { value: Array.isArray(d) ? (d.length ? d.join(", ") : "[]") : show(d) });
};

export type FieldRowProps = {
  field: Field; draft: Draft; error: string | undefined; disabled: boolean; highlighted: boolean;
  onChange: (key: string, value: string | boolean) => void;
};

export function FieldRow({ field: f, draft, error, disabled, highlighted, onChange }: FieldRowProps): View {
  const id = fieldId(f.key);
  const raw = draft[f.key];
  const help = HELP.get(f.key);
  const meta = [defaultText(f), f.min !== undefined ? t("settings.cfg.min", { min: f.min }) : "", f.max !== undefined ? t("settings.cfg.max", { max: f.max }) : ""].filter(Boolean).join(" · ");
  const described = [`${id}-key`, f.readOnly ? "" : `${id}-meta`, help ? `${id}-help` : "", f.kind === "strings" || f.kind === "ints" ? `${id}-list` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ");
  const common = { id, disabled, "aria-describedby": described, ...(error ? { "aria-invalid": true } : {}) };
  const onInput = (e: Event): void => { onChange(f.key, (e.target as HTMLInputElement).value); };
  let control: View;
  switch (f.kind) {
    case "bool":
      control = h("span", { class: "cfg-switch" },
        h("input", { ...common, type: "checkbox", role: "switch", checked: raw === true, onChange: (e: Event) => { onChange(f.key, (e.target as HTMLInputElement).checked); } }),
        h("span", { "aria-hidden": "true" }, raw === true ? t("settings.cfg.on") : t("settings.cfg.off")));
      break;
    case "enum":
      control = h("select", { ...common, value: String(raw ?? ""), onChange: onInput }, (f.options ?? []).map((o) => h("option", { value: o, selected: o === raw }, o)));
      break;
    case "strings": case "ints":
      control = h("textarea", { ...common, rows: 3, spellcheck: false, value: String(raw ?? ""), onInput });
      break;
    case "json":
      control = h("pre", { id, class: "cfg-json", tabIndex: 0, "aria-describedby": described },
        effective(f) === undefined ? t("settings.cfg.readonly.unset") : JSON.stringify(redact(effective(f)), null, 2));
      break;
    default:
      control = h("input", { ...common, type: "text", ...(f.kind === "string" ? {} : { inputmode: "numeric" }), autocomplete: "off", spellcheck: false, value: String(raw ?? ""), onInput });
  }
  return h("div", { class: "cfg-field", "data-key": f.key, ...(highlighted ? { "data-focus": "true" } : {}) },
    h("div", { class: "cfg-head" },
      h("label", { for: id }, humanize(f.key)),
      h(RestartBadge, { cls: f.restartClass })),
    h("p", { class: "cfg-key", id: `${id}-key` }, h("span", { class: "sr-only" }, `${t("settings.cfg.key")}: `), h("code", null, f.key)),
    control,
    f.readOnly ? h("p", { class: "field-hint" }, t("settings.cfg.readonly.note"), " ", t("settings.cfg.readonly.masked")) : null,
    f.kind === "strings" || f.kind === "ints" ? h("p", { class: "field-hint", id: `${id}-list` }, t("settings.cfg.listHint")) : null,
    f.readOnly ? null : h("p", { class: "field-hint", id: `${id}-meta` }, meta),
    help ? h("p", { class: "field-hint", id: `${id}-help` }, help) : null,
    error ? h("p", { class: "form-error", id: `${id}-err` }, error) : null);
}

/** Group heading text: the first key segment ("core.recall.softBudgetMs" is in "Core"); single-segment keys share "Other". */
export const groupOf = (key: string): string => (key.includes(".") ? key.split(".")[0]! : "");
export const groupTitle = (g: string): string => (g === "" ? t("settings.cfg.groupOther") : humanize(g));
