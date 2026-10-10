// Settings → Memory, media part: the media index options (video, audio, captions, backfill) and the index status card with pause,
// resume and re-index. The text index is shown beside it but not written yet: the contract names no keys for it (docs/web-ui.md,
// F49). Reads `config.get` and `media.index.status`; saves only the changed keys with `config.set` (ifRevision). Suggestion
// buttons only fill the form.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { ConfirmDialog, type ConfirmResult } from "../../components/confirm-dialog.ts";
import { PageLoading } from "../../components/page-state.ts";
import { t, formatNumber, type Key } from "../../i18n.ts";
import { FailureState, Notice } from "../common/states.ts";
import { currentRole, failureOf, getApi, useLoad } from "../common/load.ts";
import type { MediaIndexStatus, MediaModality } from "../../api/media-search.types.ts";
import { ALL_MODALITIES, CAPTION_SOURCES, CLOUD_CAPTION_PROVIDER, MEDIA_PROVIDERS, SUGGESTIONS, backfillView, canManageIndex, changesOf, draftOf, mediaErrorOf, problemText, providerById, toSetup, validateMedia, type ConfigChange, type MediaDraft } from "./model.ts";
import { choiceById } from "../setup/licences.ts";
import "./rpc-types.ts";
import "../../styles/media-search.css";

type Loaded = { draft: MediaDraft; revision: string; status: MediaIndexStatus | null; statusFailure: ReturnType<typeof failureOf> | null };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const CAPTION_CHOICES = ["local", CLOUD_CAPTION_PROVIDER, "off"] as const;
const sourceLabel = (s: string): string => t(s === "prompt-then-user-then-auto" ? "mediasearch.setup.source.prompt" : s === "user-only" ? "mediasearch.setup.source.user" : "mediasearch.setup.source.off");

export function MediaIndexPanel(): View {
  const canManage = canManageIndex(currentRole());
  const { state, reload } = useLoad(async (signal) => {
    const api = getApi();
    const cfg = (await api.rpc("config.get", undefined, { write: false, signal })) as unknown;
    const o = isObj(cfg) ? cfg : {};
    let status: MediaIndexStatus | null = null;
    let statusFailure: Loaded["statusFailure"] = null;
    try { status = await api.rpc("media.index.status", {}, { write: false, signal }); } catch (e) {
      if ((e as { kind?: string }).kind === "aborted") throw e;
      statusFailure = failureOf(e);
    }
    return { draft: draftOf(o.value), revision: typeof o.revision === "string" ? o.revision : "", status, statusFailure } satisfies Loaded;
  }, []);

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("mediasearch.settings.unavailable"), onRetry: reload });
  return h(Panel, { key: state.data.revision, loaded: state.data, canManage, reload });
}

function Panel({ loaded, canManage, reload }: { loaded: Loaded; canManage: boolean; reload: () => void }): View {
  const [draft, setDraft] = useState<MediaDraft>(loaded.draft);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // The text index is not written here yet, so the caption preselection is checked against the default local provider.
  const problems = validateMedia({ textProvider: "egemma2", media: toSetup(draft), privacyPin: false, ncConfirmed: false });
  const changes: ConfigChange[] = changesOf(loaded.draft, draft);
  const set = (patch: (d: MediaDraft) => MediaDraft): void => { setDraft((d) => patch(d)); setMessage(null); };
  const mediaProvider = providerById(draft.provider);

  const save = async (): Promise<void> => {
    if (busy || changes.length === 0 || problems.length > 0) return;
    setBusy(true); setMessage(null);
    try {
      await getApi().rpc("config.set", { changes, ifRevision: loaded.revision } as never, { write: true });
      setMessage({ tone: "ok", text: t("mediasearch.settings.saved") });
      reload();
    } catch (e) {
      const code = mediaErrorOf(e);
      setMessage({ tone: "err", text: code ? problemText(code) : t("mediasearch.settings.saveFailed") });
    } finally { setBusy(false); }
  };

  // A suggestion fills the modalities only; every other value stays as it is until saved.
  const suggest = (s: (typeof SUGGESTIONS)[number]): void => { set((d) => ({ ...d, modalities: [...s.modalities] as MediaModality[] })); };

  return h("section", { class: "media-index", "aria-labelledby": "media-index-title", "data-section": "media-index" },
    h("h3", { id: "media-index-title", class: "cfg-title" }, t("mediasearch.settings.title")),
    h("p", { class: "field-hint" }, t("mediasearch.settings.lead")),
    !canManage ? h(Notice, {}, t("mediasearch.settings.readOnly")) : null,
    h("div", { class: "media-areas" },
      h("section", { class: "setup-area", "aria-labelledby": "media-text-title" },
        h("h4", { id: "media-text-title" }, t("mediasearch.settings.textIndex")),
        h("p", { class: "field-hint" }, t("mediasearch.settings.textNote"))),
      h("section", { class: "setup-area", "aria-labelledby": "media-media-title" },
        h("h4", { id: "media-media-title" }, t("mediasearch.settings.mediaIndex")),
        h("div", { class: "setup-opt" },
          h("input", { id: "cfg-memory-mediaEmbedding-enabled", type: "checkbox", checked: draft.enabled, disabled: !canManage, onChange: (e: Event) => { set((d) => ({ ...d, enabled: (e.target as HTMLInputElement).checked })); } }),
          h("label", { for: "cfg-memory-mediaEmbedding-enabled" }, t("mediasearch.setup.enabled"))),
        draft.enabled ? h("div", {},
          h("label", { class: "field", for: "cfg-memory-mediaEmbedding-provider" },
            h("span", { class: "field-label" }, t("mediasearch.setup.provider")),
            h("select", { id: "cfg-memory-mediaEmbedding-provider", value: draft.provider, disabled: !canManage, onChange: (e: Event) => { set((d) => ({ ...d, provider: (e.target as HTMLSelectElement).value })); } },
              MEDIA_PROVIDERS.map((p) => h("option", { key: p.id, value: p.id }, p.name)))),
          h("dl", { class: "setup-facts" },
            h("dt", {}, t("mediasearch.setup.licence")), h("dd", {}, choiceById(draft.provider)?.licence ?? mediaProvider?.licence ?? "—"),
            h("dt", {}, t("mediasearch.setup.size")), h("dd", {}, t("mediasearch.setup.sizeUnknown"))),
          h("fieldset", { class: "setup-opts" }, h("legend", {}, t("mediasearch.setup.modalities")),
            h("p", { class: "field-hint" }, t("mediasearch.setup.modalitiesHint")),
            ALL_MODALITIES.map((m) => {
              const id = `cfg-memory-mediaEmbedding-modality-${m}`;
              return h("div", { key: m, class: "setup-opt" },
                h("input", { id, type: "checkbox", checked: draft.modalities.includes(m), disabled: !canManage || !mediaProvider?.caps[m], onChange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; set((d) => ({ ...d, modalities: ALL_MODALITIES.filter((x) => (x === m ? on : d.modalities.includes(x))) })); } }),
                h("label", { for: id }, t(`mediasearch.setup.modality.${m}` as Key)));
            }),
            h("div", { class: "setup-nav" }, SUGGESTIONS.map((s) => h("button", { key: s.id, type: "button", class: "btn btn-quiet", disabled: !canManage, onClick: () => { suggest(s); } }, t(`mediasearch.settings.suggest.${s.id}` as Key))))),
          h("fieldset", { class: "setup-opts" }, h("legend", {}, t("mediasearch.settings.video")),
            numberField("cfg-memory-mediaEmbedding-video-segmentSec", "mediasearch.settings.segmentSec", draft.video.segmentSec, 1, canManage, (v) => set((d) => ({ ...d, video: { ...d.video, segmentSec: v } }))),
            numberField("cfg-memory-mediaEmbedding-video-maxFrames", "mediasearch.settings.maxFrames", draft.video.maxFrames, 1, canManage, (v) => set((d) => ({ ...d, video: { ...d.video, maxFrames: v } }))),
            h("div", { class: "setup-opt" }, h("input", { id: "cfg-memory-mediaEmbedding-video-sceneDetect", type: "checkbox", checked: draft.video.sceneDetect, disabled: !canManage, onChange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; set((d) => ({ ...d, video: { ...d.video, sceneDetect: on } })); } }), h("label", { for: "cfg-memory-mediaEmbedding-video-sceneDetect" }, t("mediasearch.settings.sceneDetect")))),
          h("fieldset", { class: "setup-opts" }, h("legend", {}, t("mediasearch.settings.audio")),
            numberField("cfg-memory-mediaEmbedding-audio-segmentSec", "mediasearch.settings.segmentSec", draft.audio.segmentSec, 1, canManage, (v) => set((d) => ({ ...d, audio: { ...d.audio, segmentSec: v } }))),
            numberField("cfg-memory-mediaEmbedding-audio-maxSeconds", "mediasearch.settings.maxSeconds", draft.audio.maxSeconds, 1, canManage, (v) => set((d) => ({ ...d, audio: { ...d.audio, maxSeconds: v } })))),
          h("fieldset", { class: "setup-opts" }, h("legend", {}, t("mediasearch.settings.caption")),
            CAPTION_CHOICES.map((c) => {
              const id = `cfg-memory-mediaEmbedding-caption-${c}`;
              return h("div", { key: c, class: "setup-opt" },
                h("input", { id, type: "radio", name: "cfg-caption-provider", checked: draft.caption.provider === c, disabled: !canManage, onChange: () => { set((d) => ({ ...d, caption: { ...d.caption, provider: c } })); } }),
                h("label", { for: id }, t(c === "local" ? "mediasearch.setup.caption.local" : c === "off" ? "mediasearch.setup.caption.off" : "mediasearch.setup.caption.cloud")));
            }),
            h("label", { class: "field", for: "cfg-memory-mediaEmbedding-caption-source" }, h("span", { class: "field-label" }, t("mediasearch.setup.captionSource")),
              h("select", { id: "cfg-memory-mediaEmbedding-caption-source", value: draft.caption.source, disabled: !canManage, onChange: (e: Event) => { set((d) => ({ ...d, caption: { ...d.caption, source: (e.target as HTMLSelectElement).value } })); } },
                CAPTION_SOURCES.map((s) => h("option", { key: s, value: s }, sourceLabel(s))))),
            numberField("cfg-memory-mediaEmbedding-caption-maxChars", "mediasearch.settings.captionMaxChars", draft.caption.maxChars, 20, canManage, (v) => set((d) => ({ ...d, caption: { ...d.caption, maxChars: v } }))),
            h("div", { class: "setup-opt" }, h("input", { id: "cfg-memory-mediaEmbedding-caption-perSegment", type: "checkbox", checked: draft.caption.perSegment, disabled: !canManage, onChange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; set((d) => ({ ...d, caption: { ...d.caption, perSegment: on } })); } }), h("label", { for: "cfg-memory-mediaEmbedding-caption-perSegment" }, t("mediasearch.settings.captionPerSegment")))),
          h("label", { class: "field", for: "cfg-memory-mediaEmbedding-backfill" }, h("span", { class: "field-label" }, t("mediasearch.settings.backfill")),
            h("select", { id: "cfg-memory-mediaEmbedding-backfill", value: draft.backfill, disabled: !canManage, onChange: (e: Event) => { set((d) => ({ ...d, backfill: (e.target as HTMLSelectElement).value === "manual" ? "manual" : "auto" })); } },
              h("option", { value: "auto" }, t("mediasearch.settings.backfill.auto")),
              h("option", { value: "manual" }, t("mediasearch.settings.backfill.manual"))))) : h("p", { class: "field-hint" }, t("mediasearch.status.disabled")))),
    problems.length > 0 ? h("p", { class: "form-error", role: "alert" }, problemText(problems[0]!.code)) : null,
    message ? h("p", { role: message.tone === "err" ? "alert" : "status", class: message.tone === "err" ? "form-error" : "field-hint" }, message.text) : null,
    h("div", { class: "setup-nav" }, h("button", { type: "button", class: "btn btn-primary", disabled: !canManage || busy || changes.length === 0 || problems.length > 0, onClick: () => { void save(); } }, t("mediasearch.settings.save"))),
    loaded.statusFailure?.kind === "unavailable" ? h(Notice, {}, t("mediasearch.settings.unavailable")) : null,
    loaded.status ? h(StatusCard, { status: loaded.status, canManage, reload }) : null,
  );
}

function numberField(id: string, label: Key, value: number, min: number, enabled: boolean, onChange: (v: number) => void): View {
  return h("label", { class: "field", for: id },
    h("span", { class: "field-label" }, t(label)),
    h("input", { id, type: "number", min: String(min), value: String(value), disabled: !enabled, onInput: (e: Event) => { const v = Math.floor(Number((e.target as HTMLInputElement).value)); if (Number.isFinite(v) && v >= min) onChange(v); } }));
}

/** Index status: provider, model, variant, dimension, item counts, backfill progress and its actions. */
export function StatusCard({ status, canManage, reload }: { status: MediaIndexStatus; canManage: boolean; reload: () => void }): View {
  const bf = backfillView(status.backfill);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState(false);
  const act = async (method: "media.index.pause" | "media.index.resume"): Promise<void> => {
    setBusy(method); setErr("");
    try { await getApi().rpc(method, {}, { write: true }); reload(); } catch { setErr(t("mediasearch.status.actionFailed")); } finally { setBusy(""); }
  };
  const reindex = async (): Promise<ConfirmResult> => {
    try { await getApi().rpc("media.index.reindex", { confirm: true }, { write: true }); reload(); return { ok: true }; } catch { return { ok: false, message: t("mediasearch.status.actionFailed") }; }
  };
  const reasonKey = bf.paused ? (`mediasearch.status.reason.${bf.paused}` as Key) : null;
  return h("section", { class: "card media-status", "aria-labelledby": "media-status-title" },
    h("h4", { id: "media-status-title" }, t("mediasearch.status.title")),
    h("dl", { class: "setup-facts" },
      h("dt", {}, t("mediasearch.status.provider")), h("dd", {}, status.provider),
      h("dt", {}, t("mediasearch.status.model")), h("dd", {}, status.model),
      h("dt", {}, t("mediasearch.status.variant")), h("dd", {}, status.variant ?? "—"),
      h("dt", {}, t("mediasearch.status.dim")), h("dd", {}, String(status.dim))),
    h("p", {}, t("mediasearch.status.counts")),
    h("ul", { class: "plain-list" },
      h("li", {}, `${t("mediasearch.status.indexed")}: ${formatNumber(status.counts.indexed)}`),
      h("li", {}, `${t("mediasearch.status.pending")}: ${formatNumber(status.counts.pending)}`),
      h("li", {}, `${t("mediasearch.status.failed")}: ${formatNumber(status.counts.failed)}`),
      h("li", {}, `${t("mediasearch.status.unsupported")}: ${formatNumber(status.counts.unsupported)}`)),
    h("p", {}, `${t("mediasearch.status.backfill")}: ${t(`mediasearch.status.state.${bf.state}` as Key)} · ${t("mediasearch.status.progress", { done: formatNumber(bf.done), total: formatNumber(bf.total) })}`),
    h("progress", { value: bf.done, max: Math.max(1, bf.total), "aria-label": t("mediasearch.status.backfill") }),
    h("p", { role: "status", "aria-live": "polite", class: "sr-only" }, t("mediasearch.status.progressAnnounce", { done: formatNumber(bf.done), total: formatNumber(bf.total) })),
    reasonKey ? h("p", { class: "field-hint" }, t(reasonKey)) : null,
    canManage ? h("div", { class: "setup-nav" },
      bf.state === "running" ? h("button", { type: "button", class: "btn", disabled: busy !== "", onClick: () => { void act("media.index.pause"); } }, t("mediasearch.status.pause")) : null,
      bf.state === "paused" ? h("button", { type: "button", class: "btn", disabled: busy !== "", onClick: () => { void act("media.index.resume"); } }, t("mediasearch.status.resume")) : null,
      h("button", { type: "button", class: "btn", disabled: busy !== "", onClick: () => { setConfirm(true); } }, t("mediasearch.status.reindex"))) : h("p", { class: "field-hint" }, t("mediasearch.status.noPermission")),
    err ? h("p", { class: "form-error", role: "alert" }, err) : null,
    confirm ? h(ConfirmDialog, {
      title: t("mediasearch.status.reindexTitle"), confirmLabel: t("mediasearch.status.reindexConfirm"),
      onConfirm: reindex, onClose: () => { setConfirm(false); },
    }, h("p", {}, t("mediasearch.status.reindexBody"))) : null,
  );
}
