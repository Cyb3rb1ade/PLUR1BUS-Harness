// The media part of the wizard's Memory step: text and media index side by side, the media index on or off, its modalities,
// captioning, caption source and backfill. Shows and edits `answers.media` only; the wizard page validates and saves
// (model.ts: validate, changesFor). Untouched defaults write nothing (mediaSetupChanges).
import { h } from "preact";
import type { View } from "../../view.ts";
import { t, type Key } from "../../i18n.ts";
import { choiceById } from "../setup/licences.ts";
import type { CaptionSourceSetting, MediaBackfillSetting, MediaErrorCode, MediaModality } from "../../api/media-search.types.ts";
import { ALL_MODALITIES, CAPTION_CHOICES, CAPTION_SOURCES, MEDIA_PROVIDERS, captionPreselection, effectiveCaption, problemText, providerById, type CaptionChoice, type MediaSetup } from "./model.ts";

export type MediaSetupProps = {
  textProvider: string;
  media: MediaSetup;
  set: (m: Partial<MediaSetup>) => void;
  /** The validation problem to show (set by the wizard's validation), if any. */
  error?: MediaErrorCode | "caption-required" | "modalities-required" | undefined;
};

const captionLabel = (c: CaptionChoice): string => (c === "local" ? t("mediasearch.setup.caption.local") : c === "off" ? t("mediasearch.setup.caption.off") : t("mediasearch.setup.caption.cloud"));
const sourceLabel = (s: CaptionSourceSetting): string => t(s === "prompt-then-user-then-auto" ? "mediasearch.setup.source.prompt" : s === "user-only" ? "mediasearch.setup.source.user" : "mediasearch.setup.source.off");

export function MediaSetupStep({ textProvider, media, set, error }: MediaSetupProps): View {
  const provider = providerById(media.provider) ?? MEDIA_PROVIDERS[0]!;
  const pre = captionPreselection(textProvider);
  const caption = effectiveCaption(media, textProvider);
  const textName = providerById(textProvider)?.name ?? textProvider;
  const toggle = (m: MediaModality, on: boolean): void => {
    const next = ALL_MODALITIES.filter((x) => (x === m ? on : media.modalities.includes(x)));
    set({ modalities: next });
  };
  const errorId = "media-setup-error";
  const choice = choiceById(provider.id);

  return h("div", { class: "setup-media" },
    h("div", { class: "setup-areas" },
      h("section", { class: "setup-area", "aria-labelledby": "setup-area-text" },
        h("h3", { id: "setup-area-text" }, t("mediasearch.setup.textArea")),
        h("p", { class: "field-hint" }, `${t("mediasearch.setup.provider")}: ${textName}`)),
      h("section", { class: "setup-area", "aria-labelledby": "setup-area-media" },
        h("h3", { id: "setup-area-media" }, t("mediasearch.setup.mediaArea")),
        h("div", { class: "setup-opt" },
          h("input", { id: "setup-media-enabled", type: "checkbox", checked: media.enabled, onChange: (e: Event) => { set({ enabled: (e.target as HTMLInputElement).checked }); } }),
          h("label", { for: "setup-media-enabled" }, t("mediasearch.setup.enabled"))),
        media.enabled ? h("div", { class: "setup-media-body" },
          h("label", { class: "field" },
            h("span", { class: "field-label" }, t("mediasearch.setup.provider")),
            h("select", { id: "setup-media-provider", value: provider.id, onChange: (e: Event) => { set({ provider: (e.target as HTMLSelectElement).value }); } },
              MEDIA_PROVIDERS.map((p) => h("option", { key: p.id, value: p.id }, p.name)))),
          h("dl", { class: "setup-facts" },
            h("dt", {}, t("mediasearch.setup.model")), h("dd", {}, provider.name),
            h("dt", {}, t("mediasearch.setup.licence")), h("dd", {}, choice?.licence ?? provider.licence),
            h("dt", {}, t("mediasearch.setup.size")), h("dd", {}, t("mediasearch.setup.sizeUnknown"))),
          h("fieldset", { class: "setup-opts" },
            h("legend", {}, t("mediasearch.setup.modalities")),
            h("p", { class: "field-hint" }, t("mediasearch.setup.modalitiesHint")),
            ALL_MODALITIES.map((m) => {
              const id = `setup-modality-${m}`;
              return h("div", { key: m, class: "setup-opt" },
                h("input", { id, type: "checkbox", checked: media.modalities.includes(m), disabled: !provider.caps[m], onChange: (e: Event) => { toggle(m, (e.target as HTMLInputElement).checked); } }),
                h("label", { for: id }, t(`mediasearch.setup.modality.${m}` as Key)));
            })),
          h("fieldset", { class: "setup-opts" },
            h("legend", {}, t("mediasearch.setup.caption")),
            h("p", { class: "field-hint" }, t("mediasearch.setup.captionHint")),
            pre === null ? h("p", { class: "field-hint", role: "note" }, t("mediasearch.setup.captionPick")) : null,
            CAPTION_CHOICES.map((c) => {
              const id = `setup-caption-${c}`;
              return h("div", { key: c, class: "setup-opt" },
                h("input", { id, type: "radio", name: "setup-caption", checked: caption === c, onChange: () => { set({ caption: c }); } }),
                h("label", { for: id }, captionLabel(c)));
            })),
          h("label", { class: "field" },
            h("span", { class: "field-label" }, t("mediasearch.setup.captionSource")),
            h("select", { id: "setup-caption-source", value: media.captionSource, onChange: (e: Event) => { set({ captionSource: (e.target as HTMLSelectElement).value as CaptionSourceSetting }); } },
              CAPTION_SOURCES.map((s) => h("option", { key: s, value: s }, sourceLabel(s))))),
          h("fieldset", { class: "setup-opts" },
            h("legend", {}, t("mediasearch.setup.backfill")),
            (["auto", "manual"] as MediaBackfillSetting[]).map((b) => {
              const id = `setup-backfill-${b}`;
              return h("div", { key: b, class: "setup-opt" },
                h("input", { id, type: "radio", name: "setup-backfill", checked: media.backfill === b, onChange: () => { set({ backfill: b }); } }),
                h("label", { for: id }, t(`mediasearch.setup.backfill.${b}` as Key)));
            })),
          h("p", { class: "field-hint" }, t("mediasearch.setup.privacy")))
          : h("p", { class: "field-hint" }, t("mediasearch.setup.skippable"))),
    ),
    error ? h("p", { class: "form-error", role: "alert", id: errorId }, problemText(error)) : null,
    choice?.nc ? h("p", { class: "field-hint" }, t("mediasearch.setup.nc")) : null,
  );
}
