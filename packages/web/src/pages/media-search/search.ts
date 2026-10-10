// Media search in the Media view: text search, kind filter, "Find similar" (likeMediaId) on every medium, hits with score,
// caption and, for video and audio, the segment with a jump into the player, and caption editing for people allowed to edit.
// Empty states: media off, no media index on this engine (unavailable), backfill still running (not everything searchable).
import { h } from "preact";
import { useState } from "preact/hooks";
import { signal } from "@preact/signals";
import type { View } from "../../view.ts";
import { PageLoading } from "../../components/page-state.ts";
import { t, formatNumber, type Key } from "../../i18n.ts";
import { FailureState, Notice } from "../common/states.ts";
import { currentRole, failureOf, getApi, useLoad } from "../common/load.ts";
import type { MediaHit, MediaIndexStatus, MediaKind } from "../../api/media-search.types.ts";
import { MEDIA_KINDS, backfillView, canEditCaption, jumpSeconds, mediaErrorOf, problemText, searchParams, segmentLabel, type SearchForm } from "./model.ts";
import "./rpc-types.ts";

/** The medium "Find similar" points at. Set by a SimilarButton on a medium, read by the search form. */
export const similarTo = signal<string | null>(null);

/** The "Find similar" button of one medium in the Media view. Pressing it runs a search for media like this one. */
export function SimilarButton({ mediaId }: { mediaId: string }): View {
  return h("button", { type: "button", class: "btn btn-quiet", onClick: () => { similarTo.value = mediaId; document.getElementById("media-search-title")?.scrollIntoView?.({ block: "start" }); } },
    t("mediasearch.search.similar"));
}

type Player = { hit: MediaHit; src: string; kind: MediaKind } | null;

export function MediaSearch(): View {
  const { state, reload } = useLoad(async (signal) => {
    try {
      const status = await getApi().rpc("media.index.status", {}, { write: false, signal });
      return { status, failure: null as ReturnType<typeof failureOf> | null };
    } catch (e) {
      if ((e as { kind?: string }).kind === "aborted") throw e;
      return { status: null as MediaIndexStatus | null, failure: failureOf(e) };
    }
  }, []);
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("mediasearch.search.unavailable"), onRetry: reload });
  const { status, failure } = state.data;
  if (failure?.kind === "unavailable" || failure?.kind === "not-found") return h(Frame, {}, h(Notice, {}, t("mediasearch.search.unavailable")));
  if (!status) return h(FailureState, { failure: failure ?? { kind: "error", message: "" }, unavailable: t("mediasearch.search.unavailable"), onRetry: reload });
  if (!status.enabled) return h(Frame, {}, h(Notice, {}, t("mediasearch.search.off")));
  return h(SearchBody, { status });
}

function Frame({ children }: { children?: unknown }): View {
  return h("section", { class: "card media-search", "aria-labelledby": "media-search-title" }, h("h2", { id: "media-search-title" }, t("mediasearch.search.title")), h("p", { class: "field-hint" }, t("mediasearch.search.lead")), children as View);
}

function SearchBody({ status }: { status: MediaIndexStatus }): View {
  const role = currentRole();
  const bf = backfillView(status.backfill);
  const [form, setForm] = useState<SearchForm>({ text: "", kinds: [...MEDIA_KINDS], fuseCaptions: false });
  const [hits, setHits] = useState<MediaHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [player, setPlayer] = useState<Player>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");

  const like = similarTo.value;
  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const params = searchParams({ ...form, ...(like ? { likeMediaId: like } : {}) });
    if (!params) { setHits(null); setError(t("mediasearch.search.noQuery")); return; }
    setBusy(true); setError("");
    try {
      const r = await getApi().rpc("media.search", params, { write: false });
      setHits(r.hits);
    } catch (err) {
      setHits(null);
      const code = mediaErrorOf(err);
      setError(code ? problemText(code) : t("mediasearch.search.failed"));
    } finally { setBusy(false); }
  };

  const play = async (hit: MediaHit): Promise<void> => {
    try {
      const f = (await getApi().rpc("media.output.get", { id: hit.mediaId, file: 0 }, { write: false })) as { data?: string; mimeType?: string };
      if (typeof f.data !== "string" || typeof f.mimeType !== "string") throw new Error("no media");
      setPlayer({ hit, kind: hit.kind, src: `data:${f.mimeType};base64,${f.data}#t=${jumpSeconds(hit.segment?.startMs ?? 0)}` });
    } catch {
      setError(t("mediasearch.search.failed"));
    }
  };

  const saveCaption = async (hit: MediaHit): Promise<void> => {
    try {
      await getApi().rpc("media.caption.set", { mediaId: hit.mediaId, text: draftText.trim() }, { write: true });
      setHits((list) => (list ?? []).map((x) => (x.mediaId === hit.mediaId ? { ...x, caption: draftText.trim() } : x)));
      setEditing(null);
    } catch (err) {
      setError(mediaErrorOf(err) ? problemText(mediaErrorOf(err)!) : t("mediasearch.search.captionFailed"));
    }
  };

  const toggleKind = (k: MediaKind, on: boolean): void => {
    setForm((f) => ({ ...f, kinds: MEDIA_KINDS.filter((x) => (x === k ? on : f.kinds.includes(x))) }));
  };

  return h(Frame, {},
    bf.state === "running" ? h(Notice, {}, t("mediasearch.search.backfill", { done: formatNumber(bf.done), total: formatNumber(bf.total) })) : null,
    h("form", { onSubmit: (e: Event) => { void submit(e); }, noValidate: true, "aria-label": t("mediasearch.search.title") },
      like ? h("p", { class: "field-hint", role: "status" },
        t("mediasearch.search.similarTo", { id: like }), " ",
        h("button", { type: "button", class: "btn btn-quiet", onClick: () => { similarTo.value = null; setHits(null); } }, t("mediasearch.search.clear"))) : null,
      h("label", { class: "field", for: "media-search-text" },
        h("span", { class: "field-label" }, t("mediasearch.search.text")),
        h("input", { id: "media-search-text", type: "search", value: form.text, disabled: like !== null, onInput: (e: Event) => { setForm((f) => ({ ...f, text: (e.target as HTMLInputElement).value })); } })),
      h("fieldset", { class: "setup-opts" }, h("legend", {}, t("mediasearch.search.kinds")),
        MEDIA_KINDS.map((k) => {
          const id = `media-search-kind-${k}`;
          return h("div", { key: k, class: "setup-opt" },
            h("input", { id, type: "checkbox", checked: form.kinds.includes(k), onChange: (e: Event) => { toggleKind(k, (e.target as HTMLInputElement).checked); } }),
            h("label", { for: id }, t(`mediasearch.search.kind.${k}` as Key)));
        })),
      h("div", { class: "setup-opt" },
        h("input", { id: "media-search-fuse", type: "checkbox", checked: form.fuseCaptions, onChange: (e: Event) => { setForm((f) => ({ ...f, fuseCaptions: (e.target as HTMLInputElement).checked })); } }),
        h("label", { for: "media-search-fuse" }, t("mediasearch.search.fuse"))),
      h("button", { type: "submit", class: "btn btn-primary", disabled: busy }, busy ? t("mediasearch.search.loading") : t("mediasearch.search.submit"))),
    error ? h("p", { class: "form-error", role: "alert" }, error) : null,
    hits === null ? null : hits.length === 0 ? h("p", { role: "status" }, t("mediasearch.search.empty")) : h("section", { "aria-label": t("mediasearch.search.count", { n: hits.length }) },
      h("p", { role: "status" }, t("mediasearch.search.count", { n: formatNumber(hits.length) })),
      h("ol", { class: "plain-list media-hits" }, hits.map((hit) => h("li", { key: `${hit.mediaId}:${hit.segment?.idx ?? 0}`, class: "media-hit" },
        h("span", { class: "badge", "data-tone": "neutral" }, t(`mediasearch.search.kind.${hit.kind}` as Key)), " ",
        h("span", {}, t("mediasearch.search.score", { score: hit.score.toFixed(2) })), " ",
        hit.segment ? h("span", {}, t("mediasearch.search.segment", { range: segmentLabel(hit.segment.startMs, hit.segment.endMs) })) : null,
        editing === hit.mediaId
          ? h("form", { onSubmit: (e: Event) => { e.preventDefault(); void saveCaption(hit); }, "aria-label": t("mediasearch.search.editCaption") },
            h("label", { class: "field", for: `media-caption-${hit.mediaId}` }, h("span", { class: "field-label" }, t("mediasearch.search.captionLabel")),
              h("input", { id: `media-caption-${hit.mediaId}`, type: "text", value: draftText, onInput: (e: Event) => { setDraftText((e.target as HTMLInputElement).value); } })),
            h("button", { type: "submit", class: "btn btn-primary" }, t("mediasearch.search.captionSave")),
            h("button", { type: "button", class: "btn btn-quiet", onClick: () => { setEditing(null); } }, t("mediasearch.search.captionCancel")))
          : h("p", { class: "field-hint" }, hit.caption ? t("mediasearch.search.caption", { text: hit.caption }) : t("mediasearch.search.noCaption")),
        h("div", { class: "setup-nav" },
          hit.segment && (hit.kind === "video" || hit.kind === "audio") ? h("button", { type: "button", class: "btn", onClick: () => { void play(hit); } }, t("mediasearch.search.jump", { time: segmentStart(hit) })) : null,
          canEditCaption(role) && editing !== hit.mediaId ? h("button", { type: "button", class: "btn btn-quiet", onClick: () => { setEditing(hit.mediaId); setDraftText(hit.caption ?? ""); } }, t("mediasearch.search.editCaption")) : null,
          h(SimilarButton, { mediaId: hit.mediaId })))))),
      player ? h("div", { class: "media-player", "aria-label": t("mediasearch.search.jump", { time: segmentStart(player.hit) }) },
        player.kind === "video"
          ? h("video", { controls: true, src: player.src, "data-start": String(jumpSeconds(player.hit.segment?.startMs ?? 0)), onloadedmetadata: seekTo(player) })
          : h("audio", { controls: true, src: player.src, "data-start": String(jumpSeconds(player.hit.segment?.startMs ?? 0)), onloadedmetadata: seekTo(player) }),
        h("button", { type: "button", class: "btn btn-quiet", onClick: () => { setPlayer(null); } }, t("mediasearch.search.close")))
        : null);
}

/** Moves a freshly loaded player to the segment start (the `#t=` fragment alone does not seek a data: URL). */
const seekTo = (player: NonNullable<Player>) => (e: Event): void => {
  (e.currentTarget as HTMLMediaElement).currentTime = jumpSeconds(player.hit.segment?.startMs ?? 0);
};

const segmentStart = (hit: MediaHit): string => {
  const sec = jumpSeconds(hit.segment?.startMs ?? 0);
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};
