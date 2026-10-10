// Voice language panel: pick the language and the fast/quality profile, see size and licence per model, confirm licences, download
// with progress. Used by Settings > Voice and by the setup step (`mode: "setup"` preselects the system language and a profile).
import { h } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card } from "../../components/card.ts";
import { PageLoading } from "../../components/page-state.ts";
import { lang, t, type Key } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as voiceArea from "../../i18n/voice.ts";
import { getApi } from "../../api/shared.ts";
import "../../api/voice.types.ts";
import type { VoiceLanguage, VoiceLanguageListResult, VoiceModel, VoiceProfileName } from "../../api/voice.types.ts";
import { VOICE_PROFILES } from "../../api/voice.types.ts";
import { UnavailableError } from "../../api/errors.ts";
import { FailureState, Notice } from "../common/states.ts";
import { failureOf, useLoad, type Failure } from "../common/load.ts";
import {
  acceptList, allConfirmed, applyProgress, confirmationsNeeded, formatBytes, hasResearchModel, isResearchOnly, licenceKey, missingModels, modelsOf,
  parseProgress, percentOf, preselectProfile, summarize, systemLanguage, totalBytes, voiceErrorOf, type Downloads,
} from "./model.ts";

registerArea("voice", voiceArea);

export type Applied = { language: string; profile: VoiceProfileName };
type Loaded = { languages: VoiceLanguage[]; current: Applied | null };

async function load(signal: AbortSignal): Promise<Loaded> {
  const api = getApi();
  let list: VoiceLanguageListResult;
  try {
    list = await api.rpc("voice.language.list", undefined, { write: false, signal });
  } catch (e) {
    if (voiceErrorOf(e) === "E_VOICE_UNAVAILABLE") throw new UnavailableError("voice unavailable", "voice-unavailable");
    throw e;
  }
  let current: Applied | null = null;
  try {
    const g = await api.rpc("voice.language.get", undefined, { write: false, signal });
    current = { language: g.language, profile: g.profile };
  } catch (e) {
    if ((e as { kind?: string }).kind === "aborted") throw e;
    // The current setting is a nicety; the list alone is enough to work.
  }
  return { languages: Array.isArray(list.languages) ? list.languages : [], current };
}

/** A failure of a voice call as a page failure: E_VOICE_UNAVAILABLE counts as "not served", like an unknown method. */
export function voiceFailure(e: unknown): Failure {
  return voiceErrorOf(e) === "E_VOICE_UNAVAILABLE" ? { kind: "unavailable", message: "" } : failureOf(e);
}

const languageName = (code: string): string => {
  try { return new Intl.DisplayNames([lang.value], { type: "language" }).of(code) ?? code; } catch { return code; }
};

function ModelTable({ models }: { models: VoiceModel[] }): View {
  const l = lang.value;
  return h("table", { class: "voice-models" },
    h("caption", { class: "sr-only" }, t("voice.lang.models")),
    h("thead", {}, h("tr", {}, ...(["model", "role", "size", "licence", "state"] as const).map((c) => h("th", { scope: "col", key: c }, t(`voice.lang.col.${c}` as Key))))),
    h("tbody", {}, models.map((m) => h("tr", { key: m.modelId },
      h("th", { scope: "row" }, h("code", {}, m.modelId)),
      h("td", {}, t(`voice.role.${m.role}` as Key)),
      h("td", {}, formatBytes(m.sizeBytes, l)),
      // The licence is shown as text only: its id comes from the server, so it never becomes a link.
      h("td", {}, h("span", {}, m.licenceId), isResearchOnly(m.licenceId) ? h(Badge, { tone: "warn" }, t("voice.licence.research")) : null),
      h("td", {}, m.installed ? h(Badge, { tone: "ok" }, t("voice.model.installed")) : t("voice.model.missing"))))));
}

export type LanguagePanelProps = {
  canEdit: boolean;
  /** `setup` preselects the system language and a safe profile instead of the current setting. */
  mode: "settings" | "setup";
  onApplied?: (a: Applied) => void;
  /** Setup only: the applied choice of an earlier visit of the step. */
  initial?: Applied | null;
};

export function LanguagePanel({ canEdit, mode, onApplied, initial }: LanguagePanelProps): View {
  const { state, reload } = useLoad(load, []);
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: voiceFailure(state.failure), unavailable: t("voice.unavailable.title"), onRetry: reload });
  return h(LanguageForm, { data: state.data, canEdit, mode, ...(onApplied ? { onApplied } : {}), initial: initial ?? null, reload });
}

type Phase = { kind: "idle" } | { kind: "saving" } | { kind: "downloading"; ids: string[]; applied: Applied } | { kind: "saved"; applied: Applied } | { kind: "error"; text: string };

function LanguageForm({ data, canEdit, mode, onApplied, initial, reload }: { data: Loaded; canEdit: boolean; mode: "settings" | "setup"; onApplied?: (a: Applied) => void; initial: Applied | null; reload: () => void }): View {
  const start = useMemo((): Applied | null => {
    if (initial && data.languages.some((l) => l.language === initial.language)) return initial;
    if (mode === "settings" && data.current) return data.current;
    const code = systemLanguage(lang.value, data.languages);
    const found = data.languages.find((l) => l.language === code);
    const profile = preselectProfile(found);
    return found && profile ? { language: found.language, profile } : found ? { language: found.language, profile: "fast" } : null;
  }, []);
  const [language, setLanguage] = useState(start?.language ?? "");
  const [profile, setProfile] = useState<VoiceProfileName | "">(
    // A profile with a research-only model is never selected for the person: only the language is.
    start && (mode === "settings" || initial || !hasResearchModel(modelsOf(data.languages.find((l) => l.language === start.language), start.profile))) ? start.profile : "",
  );
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [downloads, setDownloads] = useState<Downloads>({});
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const stream = useRef<{ close(): void } | null>(null);
  const [announce, setAnnounce] = useState("");
  const lastBucket = useRef(-1);

  useEffect(() => () => { stream.current?.close(); }, []);

  const selected = data.languages.find((l) => l.language === language);
  const models = profile === "" ? [] : modelsOf(selected, profile);
  const needed = confirmationsNeeded(models);
  const ready = canEdit && language !== "" && profile !== "" && models.length > 0 && allConfirmed(models, ticked) && phase.kind !== "saving" && phase.kind !== "downloading";
  const missing = missingModels(models);
  const bytes = (p: VoiceProfileName): number => totalBytes(modelsOf(selected, p));

  const pickLanguage = (code: string): void => {
    setLanguage(code); setTicked(new Set()); setPhase({ kind: "idle" });
    const next = data.languages.find((l) => l.language === code);
    setProfile(mode === "setup" ? (preselectProfile(next) ?? "") : profile !== "" && next?.profiles[profile] ? profile : (preselectProfile(next) ?? ""));
  };
  const pickProfile = (p: VoiceProfileName): void => { setProfile(p); setTicked(new Set()); setPhase({ kind: "idle" }); };
  const tick = (key: string, on: boolean): void => { setTicked((s) => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n; }); };

  const finish = (applied: Applied): void => {
    stream.current?.close(); stream.current = null;
    setPhase({ kind: "saved", applied });
    setAnnounce(t("voice.download.done"));
    onApplied?.(applied);
    reload();
  };

  const apply = async (): Promise<void> => {
    if (!ready) return;
    const applied: Applied = { language, profile };
    const ids = missing.map((m) => m.modelId);
    setPhase({ kind: "saving" }); setDownloads({}); setAnnounce(""); lastBucket.current = -1;
    // Listen before asking, so no progress event falls between the answer and the subscription.
    let latest: Downloads = {};
    stream.current?.close();
    stream.current = getApi().events({ onEvent: (ev) => {
      if (ev.event !== "voice.download.progress") return;
      const p = parseProgress(ev.data);
      if (!p || !ids.includes(p.modelId)) return;
      latest = applyProgress(latest, p);
      setDownloads(latest);
      const sum = summarize(ids, latest);
      if (sum.status === "failed") { setPhase({ kind: "error", text: t("voice.download.failed", { models: sum.failed.join(", ") }) }); setAnnounce(t("voice.download.failed", { models: sum.failed.join(", ") })); stream.current?.close(); stream.current = null; return; }
      if (sum.status === "done") { finish(applied); return; }
      const bucket = Math.floor(sum.percent / 10);
      if (bucket !== lastBucket.current) { lastBucket.current = bucket; setAnnounce(t("voice.download.progress", { percent: bucket * 10 })); }
    } });
    try {
      const r = await getApi().rpc("voice.language.set", { language, profile, acceptLicences: acceptList(models, ticked) });
      if (!r.downloading || ids.length === 0) { finish(applied); return; }
      // Events may already have finished the job while the answer travelled.
      if (summarize(ids, latest).status === "done") { finish(applied); return; }
      setPhase((p) => (p.kind === "saving" ? { kind: "downloading", ids, applied } : p));
    } catch (e) {
      stream.current?.close(); stream.current = null;
      const code = voiceErrorOf(e);
      setPhase({ kind: "error", text: code === "E_VOICE_LICENCE" ? t("voice.apply.errLicence") : code === "E_VOICE_UNAVAILABLE" ? t("voice.apply.errUnavailable") : t("voice.apply.errFailed") });
    }
  };

  const ids = phase.kind === "downloading" ? phase.ids : missing.map((m) => m.modelId);
  const showProgress = phase.kind === "downloading" || phase.kind === "error" && Object.keys(downloads).length > 0;
  const profileLabel = (p: VoiceProfileName): string => t(`voice.lang.profile.${p}` as Key);

  return h("div", { class: "voice-lang" },
    h("p", { class: "reading" }, mode === "setup" ? t("voice.setup.lead") : t("voice.lang.lead")),
    data.current ? h("p", { class: "field-hint" }, t("voice.lang.current", { language: languageName(data.current.language), profile: profileLabel(data.current.profile) })) : null,
    h("div", { class: "field" },
      h("label", { for: "voice-language" }, t("voice.lang.language")),
      h("select", { id: "voice-language", value: language, disabled: !canEdit || phase.kind === "saving" || phase.kind === "downloading", onChange: (e: Event) => { pickLanguage((e.target as HTMLSelectElement).value); } },
        h("option", { value: "" }, t("voice.lang.choose")),
        data.languages.map((l) => h("option", { key: l.language, value: l.language }, `${languageName(l.language)} (${l.language})`)))),
    selected ? h("fieldset", { class: "setup-opts voice-profiles", disabled: !canEdit || phase.kind === "saving" || phase.kind === "downloading" },
      h("legend", {}, t("voice.lang.profile")),
      VOICE_PROFILES.map((p) => {
        const offered = selected.profiles[p] !== undefined;
        const id = `voice-profile-${p}`;
        const research = offered && hasResearchModel(modelsOf(selected, p));
        return h("div", { key: p, class: "setup-opt" },
          h("input", { id, type: "radio", name: "voice-profile", value: p, checked: profile === p, disabled: !offered, "aria-describedby": `${id}-d`, onChange: () => { pickProfile(p); } }),
          h("label", { for: id }, profileLabel(p), research ? h(Badge, { tone: "warn" }, t("voice.licence.research")) : null),
          h("p", { class: "field-hint", id: `${id}-d` }, offered ? t("voice.lang.profile.size", { size: formatBytes(bytes(p), lang.value) }) : t("voice.lang.profile.missing")));
      })) : null,
    language.toLowerCase().startsWith("en") ? h("p", { class: "field-hint" }, t("voice.lang.suggest.en")) : null,
    mode === "setup" && language.toLowerCase().startsWith("de") ? h("p", { class: "field-hint" }, t("voice.setup.de.hint")) : null,
    models.length > 0 ? h(ModelTable, { models }) : null,
    needed.length > 0 ? h("fieldset", { class: "voice-licences" },
      h("legend", {}, t("voice.licence.legend")),
      needed.map((m) => {
        const key = licenceKey(m); const id = `voice-lic-${m.modelId}`;
        const research = isResearchOnly(m.licenceId);
        return h("div", { key, class: "setup-opt" },
          h("input", { id, type: "checkbox", checked: ticked.has(key), disabled: !canEdit || phase.kind === "saving" || phase.kind === "downloading", onChange: (e: Event) => { tick(key, (e.target as HTMLInputElement).checked); } }),
          h("label", { for: id }, t(research ? "voice.licence.confirmResearch" : "voice.licence.confirm", { licence: m.licenceId, model: m.modelId })));
      }),
      h("p", { class: "field-hint" }, allConfirmed(models, ticked) ? t("voice.licence.noLink") : t("voice.licence.needed"))) : null,
    h("div", { class: "setup-nav" },
      h("button", { type: "button", class: "btn btn-primary", id: "voice-apply", disabled: !ready, onClick: () => { void apply(); } },
        phase.kind === "saving" ? t("voice.apply.working") : missing.length > 0 ? t("voice.apply") : t("voice.apply.use"))),
    showProgress ? h(Card, { title: t("voice.download.title"), level: 3 },
      ids.map((id) => {
        const pct = percentOf(downloads[id]);
        return h("div", { key: id, class: "voice-progress" },
          h("label", { for: `voice-dl-${id}` }, t("voice.download.model", { model: id, percent: pct })),
          h("progress", { id: `voice-dl-${id}`, max: 100, value: pct }));
      })) : null,
    // The one live region: coarse progress (every 10 %), the end and failures. Not the bars themselves, which would chatter.
    h("div", { class: "sr-only", role: "status", "aria-live": "polite", id: "voice-live" }, announce),
    phase.kind === "saved" ? h(Notice, {}, t("voice.apply.saved", { language: languageName(phase.applied.language), profile: profileLabel(phase.applied.profile) })) : null,
    phase.kind === "error" ? h("p", { class: "form-error", role: "alert" }, phase.text) : null,
    !canEdit ? h(Notice, {}, t("voice.readonly")) : null);
}
