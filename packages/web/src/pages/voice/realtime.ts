// Real-time voice profile: the form (shared by Settings > Voice and the per-agent override), the measured costs next to it and the
// global panel that loads and saves it.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card } from "../../components/card.ts";
import { PageLoading } from "../../components/page-state.ts";
import { lang, t, type Key } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as voiceArea from "../../i18n/voice.ts";
import { getApi } from "../../api/shared.ts";
import "../../api/voice.types.ts";
import type { VoiceFeatureEffective, VoiceFeatureMode, VoiceFeatureName, VoiceMetrics, VoiceRealtimeProfile } from "../../api/voice.types.ts";
import { VOICE_FEATURES } from "../../api/voice.types.ts";
import { UnavailableError } from "../../api/errors.ts";
import { FailureState, Notice } from "../common/states.ts";
import { useLoad } from "../common/load.ts";
import { voiceFailure } from "./language.ts";
import { BUDGET_MS, ENDPOINTING, clampInt, draftOf, modesOf, msText, parseBudget, setParams, type Draft, type FieldId, voiceErrorOf } from "./model.ts";

registerArea("voice", voiceArea);

export type RealtimeData = { profile: VoiceRealtimeProfile; metrics: VoiceMetrics | null };

/** Profile and metrics of the global settings (or of one agent). Metrics are optional: without them the form still works. */
export async function loadRealtime(signal: AbortSignal, agentId?: string): Promise<RealtimeData> {
  const api = getApi();
  const p = agentId === undefined ? undefined : { agentId };
  let profile: VoiceRealtimeProfile;
  try {
    profile = await api.rpc("voice.realtime.profile.get", p, { write: false, signal });
  } catch (e) {
    if (voiceErrorOf(e) === "E_VOICE_UNAVAILABLE") throw new UnavailableError("voice unavailable", "voice-unavailable");
    throw e;
  }
  let metrics: VoiceMetrics | null = null;
  try { metrics = await api.rpc("voice.metrics.get", p, { write: false, signal }); } catch (e) { if ((e as { kind?: string }).kind === "aborted") throw e; }
  return { profile, metrics };
}

/** Per-agent form: marks a field as overridden (it differs from the global value) or inherited. */
const marker = (overridden: ReadonlySet<FieldId> | undefined, id: FieldId): View | null =>
  overridden ? h("span", { class: "badge", "data-tone": overridden.has(id) ? "warn" : "neutral" }, t(overridden.has(id) ? "voice.agent.overridden" : "voice.agent.inherits")) : null;

const EFFECTIVE_TONE: Record<VoiceFeatureEffective, "ok" | "warn"> = { applied: "ok", "engine-fixed": "warn" };

export type RealtimeFormProps = {
  idp: string;
  draft: Draft;
  onChange: (d: Draft) => void;
  canEdit: boolean;
  /** What the server reports as `effective` per feature (read-only). */
  effective?: Partial<Record<VoiceFeatureName, VoiceFeatureEffective>>;
  metrics?: VoiceMetrics | null;
  /** The fields this agent overrides; given only in the per-agent form, which then marks every field as inherited or overridden. */
  overridden?: ReadonlySet<FieldId>;
};

export function RealtimeForm({ idp, draft, onChange, canEdit, effective, metrics, overridden }: RealtimeFormProps): View {
  const l = lang.value;
  const set = (p: Partial<Draft>): void => { onChange({ ...draft, ...p }); };
  const feat = (f: VoiceFeatureName, p: { mode?: VoiceFeatureMode; maxMs?: number | null }): void => {
    const cur = draft.features[f];
    const maxMs = p.maxMs === undefined ? cur.maxMs : p.maxMs === null ? undefined : p.maxMs;
    onChange({ ...draft, features: { ...draft.features, [f]: { mode: p.mode ?? cur.mode, ...(maxMs !== undefined ? { maxMs } : {}) } } });
  };
  const check = (id: string, label: Key, hint: Key | null, value: boolean, field: "enabled" | "speculative" | "ackSound"): View =>
    h("div", { class: "setup-opt" },
      h("input", { id: `${idp}-${id}`, type: "checkbox", checked: value, disabled: !canEdit, ...(hint ? { "aria-describedby": `${idp}-${id}-d` } : {}), onChange: (e: Event) => { set({ [field]: (e.target as HTMLInputElement).checked }); } }),
      h("label", { for: `${idp}-${id}` }, t(label), marker(overridden, field)),
      hint ? h("p", { class: "field-hint", id: `${idp}-${id}-d` }, t(hint)) : null);

  return h("div", { class: "voice-rt" },
    h("div", { class: "voice-rt-basic" },
      check("enabled", "voice.rt.enabled", null, draft.enabled, "enabled"),
      h("div", { class: "field" },
        h("label", { for: `${idp}-endpointing` }, t("voice.rt.endpointing"), marker(overridden, "endpointingMs")),
        h("input", {
          id: `${idp}-endpointing`, type: "range", min: ENDPOINTING.min, max: ENDPOINTING.max, step: ENDPOINTING.step, value: draft.endpointingMs, disabled: !canEdit,
          "aria-describedby": `${idp}-endpointing-d`, "aria-valuetext": msText(draft.endpointingMs, l),
          onInput: (e: Event) => { set({ endpointingMs: clampInt(Number((e.target as HTMLInputElement).value), ENDPOINTING.min, ENDPOINTING.max) }); },
        }),
        h("p", { class: "field-hint", id: `${idp}-endpointing-d` }, t("voice.rt.endpointing.hint", { ms: draft.endpointingMs }))),
      check("speculative", "voice.rt.speculative", "voice.rt.speculative.hint", draft.speculative, "speculative"),
      check("ack", "voice.rt.ack", "voice.rt.ack.hint", draft.ackSound, "ackSound")),
    h("table", { class: "voice-features" },
      h("caption", {}, t("voice.feat.title")),
      h("thead", {}, h("tr", {}, ...(["feature", "mode", "budget", "cost", "state"] as const).map((c) => h("th", { scope: "col", key: c }, t(`voice.feat.col.${c}` as Key))))),
      h("tbody", {}, VOICE_FEATURES.map((f) => {
        const s = draft.features[f];
        const cost = metrics?.featureCost[f];
        const eff = effective?.[f];
        const fixed = eff === "engine-fixed";
        const id = `${idp}-f-${f}`;
        return h("tr", { key: f, "data-feature": f, ...(fixed ? { "data-effective": "engine-fixed" } : {}) },
          h("th", { scope: "row" }, h("label", { for: `${id}-mode` }, t(`voice.feat.${f}` as Key)), marker(overridden, `feature.${f}`)),
          h("td", {}, h("select", { id: `${id}-mode`, value: s.mode, disabled: !canEdit, onChange: (e: Event) => { feat(f, { mode: (e.target as HTMLSelectElement).value as VoiceFeatureMode }); } },
            modesOf(f).map((m) => h("option", { key: m, value: m }, t(`voice.mode.${m}` as Key))))),
          h("td", {}, h("input", {
            id: `${id}-ms`, type: "number", inputMode: "numeric", min: BUDGET_MS.min, max: BUDGET_MS.max, step: 10, value: s.maxMs ?? "", disabled: !canEdit, "aria-label": `${t(`voice.feat.${f}` as Key)}: ${t("voice.feat.col.budget")}`,
            onChange: (e: Event) => { const v = parseBudget((e.target as HTMLInputElement).value); feat(f, { maxMs: v ?? null }); },
          })),
          h("td", {}, cost ? t("voice.cost.value", { median: msText(cost.medianMs, l), p95: msText(cost.p95Ms, l) }) : h("span", { class: "field-hint" }, t("voice.cost.none"))),
          h("td", {}, eff ? h(Badge, { tone: EFFECTIVE_TONE[eff] }, t(fixed ? "voice.effective.fixed" : "voice.effective.applied")) : null,
            fixed ? h("p", { class: "field-hint" }, t("voice.effective.fixedNote")) : null));
      }))));
}

export function MetricsView({ metrics, failed }: { metrics: VoiceMetrics | null; failed?: boolean }): View {
  const l = lang.value;
  const m = metrics?.speechEndToFirstAudio;
  return h(Card, { title: t("voice.metrics.title"), level: 3 },
    h("p", { class: "field-hint" }, t("voice.metrics.lead")),
    m && m.samples > 0
      ? h("p", { class: "voice-latency", role: "status" }, t("voice.metrics.value", { median: msText(m.medianMs, l), p95: msText(m.p95Ms, l), samples: m.samples, window: Math.max(1, Math.round((metrics?.windowSec ?? 0) / 60)) }))
      : h("p", { class: "field-hint", role: "status" }, failed ? t("voice.metrics.unavailable") : t("voice.metrics.none")));
}

export function validDraft(d: Draft): boolean {
  if (!Number.isFinite(d.endpointingMs) || d.endpointingMs < ENDPOINTING.min || d.endpointingMs > ENDPOINTING.max) return false;
  return VOICE_FEATURES.every((f) => d.features[f].maxMs === undefined || (Number.isFinite(d.features[f].maxMs) && d.features[f].maxMs! >= BUDGET_MS.min && d.features[f].maxMs! <= BUDGET_MS.max));
}

export function RealtimePanel({ canEdit }: { canEdit: boolean }): View {
  const { state, reload } = useLoad((s) => loadRealtime(s), []);
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: voiceFailure(state.failure), unavailable: t("voice.unavailable.title"), onRetry: reload });
  return h(RealtimeLoaded, { data: state.data, canEdit });
}

function RealtimeLoaded({ data, canEdit }: { data: RealtimeData; canEdit: boolean }): View {
  const [saved, setSaved] = useState<VoiceRealtimeProfile>(data.profile);
  const [draft, setDraft] = useState<Draft>(() => draftOf(data.profile));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const save = async (): Promise<void> => {
    if (!validDraft(draft)) { setMsg({ tone: "err", text: t("voice.rt.invalid") }); return; }
    setBusy(true); setMsg(null);
    try {
      const next = await getApi().rpc("voice.realtime.profile.set", setParams(draft));
      setSaved(next); setDraft(draftOf(next)); setMsg({ tone: "ok", text: t("voice.rt.saved") });
    } catch { setMsg({ tone: "err", text: t("voice.rt.saveFailed") }); }
    setBusy(false);
  };
  const effective: Partial<Record<VoiceFeatureName, VoiceFeatureEffective>> = {};
  for (const f of VOICE_FEATURES) { const e = saved.features[f]?.effective; if (e) effective[f] = e; }
  return h("div", { class: "voice-rt-page" },
    h(Card, { title: t("voice.rt.title"), level: 3 },
      h("p", { class: "reading" }, t("voice.rt.lead")),
      h(RealtimeForm, { idp: "voice-rt", draft, onChange: (d) => { setDraft(d); setMsg(null); }, canEdit, effective, metrics: data.metrics }),
      h("div", { class: "setup-nav" }, h("button", { type: "button", class: "btn btn-primary", id: "voice-rt-save", disabled: !canEdit || busy, onClick: () => { void save(); } }, t("voice.rt.save"))),
      msg ? h("p", { role: msg.tone === "err" ? "alert" : "status", class: msg.tone === "err" ? "form-error" : "field-hint" }, msg.text) : null,
      !canEdit ? h(Notice, {}, t("voice.readonly")) : null),
    h(MetricsView, { metrics: data.metrics, failed: data.metrics === null }));
}
