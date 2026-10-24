// Rendering of one config field and of the groups: label, key, widget by kind, default, restart badge, help, error. Controls are
// `id="cfg-<key with dots as dashes>"` (the anchor of the palette's deep links) and point at their hint and error with aria-describedby.
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { getApi } from "../../../api/shared.ts";
import type { View } from "../../../view.ts";
import { Badge } from "../../../components/card.ts";
import { t, type Key } from "../../../i18n.ts";
import { SETTINGS } from "../../../palette/settings-index.ts";
import { coreDraftValue, coreSliderValue, effective, redact, restartKind, show, type CoreInfo, type Draft, type Field } from "./model.ts";
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

/** Why `supervisor.maxCores` does not do what its value says: the OS cannot bind, the binding failed, or the value exceeds the
 *  host's cores (then every core is used). */
function coreNote(f: Field, c: CoreInfo): string | undefined {
  if (c.state === "unsupported") return t("settings.cores.unsupported");
  if (c.state === "failed") return t("settings.cores.failed", { reason: c.reason ?? "" });
  const v = effective(f);
  return typeof v === "number" && v > c.detected ? t("settings.cores.above", { n: v }) : undefined;
}

/** The value of the core slider in words, for its `aria-valuetext` and the visible label beside it. */
function coreText(position: number, total: number): string {
  if (total === 1) return t("settings.cores.single");
  return position >= total ? t("settings.cores.all", { total }) : t("settings.cores.some", { n: position, total });
}

export type FieldRowProps = {
  field: Field; draft: Draft; error: string | undefined; disabled: boolean; highlighted: boolean;
  onChange: (key: string, value: string | boolean) => void;
};

export function FieldRow({ field: f, draft, error, disabled, highlighted, onChange }: FieldRowProps): View {
  const [probe, setProbe] = useState<"idle" | "running" | "ok" | "failed">("idle");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  useEffect(() => { active.current?.abort(); setProbe("idle"); }, [draft[f.key]]);
  const test = async (): Promise<void> => {
    if (active.current && !active.current.signal.aborted) return;
    const controller = new AbortController(); active.current = controller; setProbe("running");
    try { await getApi().rpc("models.test", { model: String(draft[f.key]) }, { signal: controller.signal }); if (!controller.signal.aborted) setProbe("ok"); }
    catch { if (!controller.signal.aborted) setProbe("failed"); }
    finally { if (active.current === controller) active.current = null; }
  };
  const id = fieldId(f.key);
  const raw = draft[f.key];
  const role = f.key.startsWith("modelRoles.") ? f.key.slice(11) : undefined;
  const cores = f.cores;
  const help = role ? t(`settings.roles.${role}` as Key) : cores ? t("settings.cores.hint") : HELP.get(f.key);
  const meta = cores ? t("settings.cores.meta", { total: cores.detected })
    : [defaultText(f), f.min !== undefined ? t("settings.cfg.min", { min: f.min }) : "", f.max !== undefined ? t("settings.cfg.max", { max: f.max }) : ""].filter(Boolean).join(" · ");
  const note = cores ? coreNote(f, cores) : undefined;
  const described = [`${id}-key`, f.readOnly ? "" : `${id}-meta`, help ? `${id}-help` : "", note ? `${id}-note` : "", f.kind === "strings" || f.kind === "ints" ? `${id}-list` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ");
  const common = { id, disabled, "aria-describedby": described, ...(error ? { "aria-invalid": true } : {}) };
  const onInput = (e: Event): void => { onChange(f.key, (e.target as HTMLInputElement).value); };
  let control: View;
  if (cores) {
    // supervisor.maxCores: 1 up to the cores the supervisor detected; the right end is every core and is stored as 0.
    const total = cores.detected;
    const position = coreSliderValue(String(raw ?? ""), total);
    const text = coreText(position, total);
    control = h("div", { class: "cfg-range" },
      h("input", { ...common, type: "range", min: 1, max: total, step: 1, value: position, disabled: disabled || total === 1, "aria-valuetext": text,
        onInput: (e: Event) => { onChange(f.key, coreDraftValue(Number((e.target as HTMLInputElement).value), total)); } }),
      h("span", { class: "cfg-range-value", "aria-hidden": "true" }, text));
  } else switch (f.kind) {
    case "bool":
      control = h("span", { class: "cfg-switch" },
        h("input", { ...common, type: "checkbox", role: "switch", checked: raw === true, onChange: (e: Event) => { onChange(f.key, (e.target as HTMLInputElement).checked); } }),
        h("span", { "aria-hidden": "true" }, raw === true ? t("settings.cfg.on") : t("settings.cfg.off")));
      break;
    case "enum":
      // A value from a newer harness is not among the known options: it stays visible (and selected) instead of showing the first option.
      control = h("select", { ...common, value: String(raw ?? ""), onChange: onInput },
        (typeof raw === "string" && raw !== "" && !(f.options ?? []).includes(raw) ? [raw, ...(f.options ?? [])] : (f.options ?? [])).map(o => {
          const choice = f.choices?.find(c => c.value === o);
          const label = o === "" ? t("settings.cfg.unset") : choice?.label ?? o;
          const reason = choice?.disabled ? ` — ${t(`settings.roles.${choice.disabled}` as Key)}` : "";
          return h("option", { value: o, selected: o === raw, disabled: !!choice?.disabled }, label + reason);
        }));
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
      h("label", { for: id }, f.key === "decision.backend" ? t("settings.decision.backend") : humanize(f.key)),
      h(RestartBadge, { cls: f.restartClass })),
    h("p", { class: "cfg-key", id: `${id}-key` }, h("span", { class: "sr-only" }, `${t("settings.cfg.key")}: `), h("code", null, f.key)),
    control,
    role && !["embedding", "rerank"].includes(role) ? h("div", {},
      h("p", { class: "field-hint" }, t("settings.roles.testHint")),
      h("button", { type: "button", class: "btn", disabled: disabled || !raw || probe === "running", onClick: () => { void test(); } }, t("settings.roles.test")),
      probe === "idle" ? null : h("p", { role: probe === "failed" ? "alert" : "status", class: "field-hint" }, t(`settings.roles.test${probe === "running" ? "Running" : probe === "ok" ? "Ok" : "Failed"}`))) : null,
    f.readOnly ? h("p", { class: "field-hint" }, t("settings.cfg.readonly.note"), " ", t("settings.cfg.readonly.masked")) : null,
    f.kind === "strings" || f.kind === "ints" ? h("p", { class: "field-hint", id: `${id}-list` }, t("settings.cfg.listHint")) : null,
    f.readOnly ? null : h("p", { class: "field-hint", id: `${id}-meta` }, meta),
    help ? h("p", { class: "field-hint", id: `${id}-help` }, help) : null,
    note ? h("p", { class: "field-hint", id: `${id}-note`, "data-tone": "warn" }, note) : null,
    error ? h("p", { class: "form-error", id: `${id}-err` }, error) : null);
}

/** Group heading text: the first key segment ("core.recall.softBudgetMs" is in "Core"); single-segment keys share "Other". */
export const groupOf = (key: string): string => (key.includes(".") ? key.split(".")[0]! : "");
export const groupTitle = (g: string): string => (g === "decision" ? t("settings.decision.title") : g === "" ? t("settings.cfg.groupOther") : humanize(g));
