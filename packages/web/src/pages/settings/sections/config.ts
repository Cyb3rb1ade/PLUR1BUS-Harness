// Settings config sections (general, models, memory, extensions, network): forms for the keys a section owns, built from the
// running configuration (`config.get`) and the static field metadata (config/meta.ts; there is no schema RPC). Edit, review a diff
// (`config.set` with dryRun), save (`config.set` with ifRevision). Secrets-bearing keys are never shown.
import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { PageLoading, PageState } from "../../../components/page-state.ts";
import { t } from "../../../i18n.ts";
import { FailureState, Notice } from "../../common/states.ts";
import { currentRole, getApi, roleIn, useLoad } from "../../common/load.ts";
import type { SectionProps } from "../page.ts";
import { FieldRow, groupOf, groupTitle, RestartBadge } from "../config/fields.ts";
import { fieldId } from "../config/meta.ts";
import { buildFields, collectChanges, initialDraft, mapInvalid, restartKind, show, type Change, type Draft, type Field } from "../config/model.ts";
import "../../../styles/config.css";

type Loaded = { config: unknown; revision: string; restart: Record<string, string | null> };
type Plan = { live?: string[]; core?: boolean; modules?: string[] };
type Review = { changes: Change[]; plan: Plan | null; local: boolean };
type Banner = { tone: "warn" | "info"; text: string; reload?: boolean };
type Saved = { n: number; restartKeys: string[]; liveKeys: string[]; plan: Plan | null; restarted: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

async function loadConfig(section: SectionProps["section"], signal: AbortSignal): Promise<Loaded> {
  const api = getApi();
  const res = await api.rpc("config.get", undefined, { write: false, signal }) as unknown;
  const o = isObj(res) ? res : {};
  const config = o.value;
  const revision = typeof o.revision === "string" ? o.revision : "";
  // The restart class is per key (config.get with `key`); a failing key just stays "unknown".
  const keys = buildFields(config, section).map((f) => f.key);
  const classes = await Promise.all(keys.map(async (key): Promise<[string, string | null]> => {
    try {
      const r = await api.rpc("config.get", { key }, { write: false, signal }) as unknown;
      return [key, isObj(r) && typeof r.restartClass === "string" ? r.restartClass : null];
    } catch (e) {
      if ((e as { kind?: string }).kind === "aborted") throw e;
      return [key, null];
    }
  }));
  return { config, revision, restart: Object.fromEntries(classes) };
}

export function ConfigSection({ section, focus }: SectionProps): View {
  const { state, reload } = useLoad((signal) => loadConfig(section, signal), [section.id]);
  const [saved, setSaved] = useState<Saved | null>(null);
  useEffect(() => { setSaved(null); }, [section.id]);
  const title = t(section.label);
  let body: View;
  if (state.status === "loading") body = h(PageLoading, { label: t("state.loading") });
  else if (state.status === "fail") body = h(FailureState, { failure: state.failure, unavailable: t("settings.cfg.unavailable"), onRetry: reload });
  else body = h(Form, { key: state.data.revision, data: state.data, section, ...(focus === undefined ? {} : { focus }), saved, onSaved: (s: Saved) => { setSaved(s); reload(); }, reload });
  return h("section", { "data-section": section.id, "aria-labelledby": "cfg-title", class: "cfg" },
    h("h2", { id: "cfg-title", class: "cfg-title" }, title),
    saved ? h(SavedNotice, { saved }) : null,
    body);
}

function SavedNotice({ saved }: { saved: Saved }): View {
  return h(Notice, {},
    t("settings.cfg.saved", { n: saved.n }),
    saved.liveKeys.length ? ` ${t("settings.cfg.liveNotice", { keys: saved.liveKeys.join(", ") })}` : "",
    saved.restartKeys.length ? ` ${t("settings.cfg.restartNotice", { keys: saved.restartKeys.join(", ") })}` : "",
    saved.restarted.length ? ` ${t("settings.cfg.restarted", { units: saved.restarted.join(", ") })}` : "");
}

type FormProps = { data: Loaded; section: SectionProps["section"]; focus?: string; saved: Saved | null; onSaved: (s: Saved) => void; reload: () => void };

function Form({ data, section, focus, onSaved, reload }: FormProps): View {
  const role = currentRole();
  const canWrite = roleIn(role, ["owner", "admin"]);
  const fields = useMemo(() => buildFields(data.config, section, data.restart), [data, section]);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState<"review" | "save" | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, Field[]>();
    for (const f of fields) { const g = groupOf(f.key); m.set(g, [...(m.get(g) ?? []), f]); }
    return [...m.entries()];
  }, [fields]);
  const focused = focus !== undefined ? fields.find((f) => f.key === focus) : undefined;
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const o: Record<string, boolean> = {};
    groups.forEach(([g], i) => { o[g] = fields.length <= 12 || i === 0; });
    if (focused) o[groupOf(focused.key)] = true;
    return o;
  });
  const focusGroup = focused ? groupOf(focused.key) : undefined;
  const focusOpen = focusGroup !== undefined && open[focusGroup] === true;
  useEffect(() => {
    if (!focused || focusGroup === undefined) return;
    if (!focusOpen) { setOpen((o) => ({ ...o, [focusGroup]: true })); return; }
    const el = document.getElementById(fieldId(focused.key));
    if (el) { el.scrollIntoView({ block: "center" }); el.focus({ preventScroll: true }); }
  }, [focused?.key, focusOpen]);

  const { changes, errors: localErrors } = collectChanges(fields, draft);
  const dirty = changes.length;
  const edit = (key: string, value: string | boolean): void => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => { if (!(key in e)) return e; const { [key]: _drop, ...rest } = e; return rest; });
    setReview(null);
  };

  const params = (cs: readonly Change[], extra: object): object => ({ changes: cs.map((c) => ({ key: c.key, value: c.value })), ...extra, ifRevision: data.revision });

  /** Maps a failed config.set onto the form. Returns "local" when the method does not exist (the caller falls back). */
  const fail = (e: unknown): "local" | "handled" => {
    const k = e as { kind?: string; code?: number; errorCode?: string | null; reason?: string; message?: string; data?: unknown };
    if (k.kind === "aborted") return "handled";
    if (k.kind === "unavailable" || (k.kind === "rpc-error" && k.code === -32601)) return "local";
    setReview(null);
    if (k.kind === "forbidden") { setBanner({ tone: "warn", text: t("settings.cfg.readOnlyRole") }); return "handled"; }
    if (k.kind === "rpc-error" && (k.errorCode === "E_CONFLICT" || k.reason === "config-changed")) { setBanner({ tone: "warn", text: t("settings.cfg.conflict"), reload: true }); return "handled"; }
    if (k.kind === "rpc-error" && k.errorCode === "E_CONFIG_INVALID") {
      const detail = [k.message ?? "", isObj(k.data) && typeof k.data.detail === "string" ? k.data.detail : ""].filter(Boolean).join("; ");
      const m = mapInvalid(detail, changes.map((c) => c.key));
      setErrors(m.byKey);
      if (m.rest.length || Object.keys(m.byKey).length === 0) setBanner({ tone: "warn", text: t("settings.cfg.invalid", { detail: m.rest.join("; ") || detail }) });
      return "handled";
    }
    setBanner({ tone: "warn", text: t("settings.cfg.failed") });
    return "handled";
  };

  const startReview = async (): Promise<void> => {
    setBanner(null);
    if (Object.keys(localErrors).length) {
      setErrors(Object.fromEntries(Object.entries(localErrors).map(([k, v]) => [k, t(v.key, v.params)])));
      const first = Object.keys(localErrors)[0]!;
      document.getElementById(fieldId(first))?.focus();
      return;
    }
    setErrors({});
    setBusy("review");
    try {
      const res = await getApi().rpc("config.set", params(changes, { dryRun: true }) as never) as unknown;
      setReview({ changes, plan: isObj(res) && isObj(res.restart) ? res.restart as Plan : null, local: false });
    } catch (e) {
      if (fail(e) === "local") setReview({ changes, plan: null, local: true });
    } finally { setBusy(null); }
  };

  const save = async (): Promise<void> => {
    if (!review) return;
    setBanner(null);
    setBusy("save");
    try {
      const res = await getApi().rpc("config.set", params(review.changes, {}) as never) as unknown;
      const r = isObj(res) ? res : {};
      onSaved({
        n: review.changes.length,
        restartKeys: review.changes.filter((c) => restartKind(c.restartClass) === "restart").map((c) => c.key),
        liveKeys: review.changes.filter((c) => restartKind(c.restartClass) !== "restart").map((c) => c.key),
        plan: isObj(r.restart) ? r.restart as Plan : null,
        restarted: Array.isArray(r.restarted) ? r.restarted.filter((x): x is string => typeof x === "string") : [],
      });
    } catch (e) {
      if (fail(e) === "local") setBanner({ tone: "warn", text: t("settings.cfg.unavailable") });
    } finally { setBusy(null); }
  };

  if (fields.length === 0) return h(PageState, { state: "empty", title: t("settings.cfg.empty"), detail: t("settings.cfg.emptyBody") });

  const restartKeys = (review?.changes ?? []).filter((c) => restartKind(c.restartClass) === "restart").map((c) => c.key);
  return h("div", { class: "cfg-form" },
    !canWrite ? h(Notice, { tone: "info" }, h("span", { id: "cfg-ro" }, t("settings.cfg.readOnlyRole"))) : null,
    focus !== undefined && !focused ? h(Notice, {}, t("settings.cfg.focusUnknown", { key: focus })) : null,
    banner ? h("div", { class: "form-notice", "data-tone": banner.tone, role: "alert" }, banner.text, banner.reload ? [" ", h("button", { type: "button", class: "btn btn-quiet", onClick: reload }, t("settings.cfg.reload"))] : null) : null,
    groups.map(([g, fs]) => {
      const gid = `cfg-group-${g || "other"}`;
      return h("section", { key: g, class: "cfg-group", "aria-labelledby": `${gid}-h` },
        h("h3", { id: `${gid}-h`, class: "cfg-group-h" },
          h("button", { type: "button", class: "cfg-toggle", "aria-expanded": open[g] === true, "aria-controls": gid, onClick: () => { setOpen((o) => ({ ...o, [g]: !o[g] })); } },
            h("span", { "aria-hidden": "true", class: "cfg-chev" }, open[g] ? "▾" : "▸"), groupTitle(g))),
        h("div", { id: gid, hidden: open[g] !== true }, fs.map((f) =>
          h(FieldRow, { key: f.key, field: f, draft, error: errors[f.key], disabled: !canWrite, highlighted: focused?.key === f.key, onChange: edit }))));
    }),
    review ? h("section", { class: "cfg-review", "aria-labelledby": "cfg-review-h" },
      h("h3", { id: "cfg-review-h" }, t("settings.cfg.diffTitle")),
      review.local ? h("p", { class: "field-hint" }, t("settings.cfg.diffLocal")) : null,
      h("ul", { class: "cfg-diff", "aria-label": t("settings.cfg.diffCaption") }, review.changes.map((c) =>
        h("li", { key: c.key },
          h("code", { class: "cfg-diff-key" }, c.key),
          h("span", { class: "cfg-diff-val" }, h("span", { class: "cfg-old" }, show(c.old) || t("settings.cfg.unset")), h("span", { "aria-hidden": "true" }, " → "), h("span", { class: "sr-only" }, ` ${t("settings.cfg.to")} `), h("strong", { class: "cfg-new" }, show(c.value) || t("settings.cfg.unset"))),
          h(RestartBadge, { cls: c.restartClass })))),
      restartKeys.length ? h(Notice, { tone: "warn" }, t("settings.cfg.restartNotice", { keys: restartKeys.join(", ") }),
        review.plan?.core ? ` ${t("settings.cfg.planCore")}` : "", review.plan?.modules?.length ? ` ${t("settings.cfg.planModules", { modules: review.plan.modules.join(", ") })}` : "") : null,
      h("div", { class: "cfg-actions" },
        h("button", { type: "button", class: "btn", onClick: () => { setReview(null); } }, t("settings.cfg.back")),
        h("button", { type: "button", class: "btn btn-primary", disabled: busy !== null || !canWrite, onClick: () => { void save(); } }, busy === "save" ? t("settings.cfg.saving") : t("settings.cfg.save")))) : null,
    !review ? h("div", { class: "cfg-bar" },
      h("p", { class: "cfg-count", role: "status" }, dirty ? t("settings.cfg.count", { n: dirty }) : t("settings.cfg.noChanges")),
      h("div", { class: "cfg-actions" },
        h("button", { type: "button", class: "btn", disabled: dirty === 0 && Object.keys(errors).length === 0, onClick: () => { setDraft(initialDraft(fields)); setErrors({}); setBanner(null); } }, t("settings.cfg.discard")),
        h("button", { type: "button", class: "btn btn-primary", disabled: !canWrite || busy !== null || (dirty === 0 && Object.keys(localErrors).length === 0), onClick: () => { void startReview(); } }, busy === "review" ? t("settings.cfg.reviewing") : t("settings.cfg.review")),
        !canWrite ? h("button", { type: "button", class: "btn btn-primary", disabled: true, "aria-describedby": "cfg-ro" }, t("settings.cfg.save")) : null)) : null);
}
