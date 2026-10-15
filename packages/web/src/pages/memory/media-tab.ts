// Media tab of the Memories page (`#/memories/media`): whether the media index is on, its provider, model, variant and dimension,
// the item counts, the backfill and why it is paused, with pause, resume and a re-index that needs the typed confirmation word.
// Reads `media.index.status`; the actions call `media.index.pause|resume|reindex` (re-index sends `confirm: true`). Owner and
// Admin see the actions, every other role sees the state only. The Settings card (media-search/settings.ts) keeps its own layout;
// the rules and the texts both use come from media-search/model.ts and the mediasearch catalogue.
import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { ConfirmDialog, type ConfirmResult } from "../../components/confirm-dialog.ts";
import { PageLoading } from "../../components/page-state.ts";
import { formatNumber, t, type Key } from "../../i18n.ts";
import type { MediaIndexStatus } from "../../../../rpc-schema/generated/types.ts";
import { FailureState, Notice } from "../common/states.ts";
import { backfillView, canManageIndex, mediaErrorOf, problemText } from "../media-search/model.ts";
import { currentRole, getApi, useLoad } from "./data.ts";
import "../../styles/media-search.css";

type Message = { tone: "ok" | "err"; text: string } | null;

/** The Memory page's Refresh button bumps `tick`, which reloads the status. */
export function MediaTab({ tick }: { tick: number }): View {
  const canManage = canManageIndex(currentRole());
  // The message lives here, not in Panel: an action reloads the status, and a message kept in Panel would be lost with it.
  const [message, setMessage] = useState<Message>(null);
  const { state, reload } = useLoad((signal) => getApi().rpc("media.index.status", {}, { write: false, signal }), [tick]);

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("memory.media.unavailable"), onRetry: reload });
  return h(Panel, { status: state.data, canManage, reload, message, setMessage });
}

/** Text for a refused action: the E_MEDIA_* code when the server named one, else the generic action failure. */
function actionFailure(e: unknown): string {
  const code = mediaErrorOf(e);
  return code ? problemText(code) : t("mediasearch.status.actionFailed");
}

function Panel({ status, canManage, reload, message, setMessage }: { status: MediaIndexStatus; canManage: boolean; reload: () => void; message: Message; setMessage: (m: Message) => void }): View {
  const [busy, setBusy] = useState("");
  const acting = useRef(false); // set in the click itself, so a second click before the re-render sends nothing
  const [confirming, setConfirming] = useState(false);
  const bf = backfillView(status.backfill);
  const { counts } = status;
  const nothingYet = counts.indexed + counts.pending + counts.failed + counts.unsupported === 0 && bf.state !== "running";
  const reasonKey = bf.paused ? (`mediasearch.status.reason.${bf.paused}` as Key) : null;

  const act = async (method: "media.index.pause" | "media.index.resume"): Promise<void> => {
    if (acting.current) return;
    acting.current = true;
    setBusy(method); setMessage(null);
    try {
      await getApi().rpc(method, {}, { write: true });
      setMessage({ tone: "ok", text: t(method === "media.index.pause" ? "memory.media.paused" : "memory.media.resumed") });
      reload();
    } catch (e) { setMessage({ tone: "err", text: actionFailure(e) }); } finally { acting.current = false; setBusy(""); }
  };

  // The dialog stays open until the server accepted the call; a refusal is shown inside it.
  const reindex = async (): Promise<ConfirmResult> => {
    try {
      await getApi().rpc("media.index.reindex", { confirm: true }, { write: true });
      setMessage({ tone: "ok", text: t("memory.media.reindexing") });
      reload();
      return { ok: true };
    } catch (e) { return { ok: false, message: actionFailure(e) }; }
  };

  return h("section", { class: "card media-status memory-media", "aria-labelledby": "memory-media-title" },
    h("h2", { id: "memory-media-title" }, t("memory.media.title")),
    h("p", { class: "field-hint" }, t("memory.media.lead")),
    h("p", {}, `${t("memory.media.index")}: ${t(status.enabled ? "memory.media.on" : "memory.media.off")}`),
    status.enabled ? null : h(Notice, {}, t("mediasearch.status.disabled")),
    h("dl", { class: "setup-facts" },
      h("dt", {}, t("mediasearch.status.provider")), h("dd", {}, status.provider),
      h("dt", {}, t("mediasearch.status.model")), h("dd", {}, status.model),
      h("dt", {}, t("mediasearch.status.variant")), h("dd", {}, status.variant ?? "—"),
      h("dt", {}, t("mediasearch.status.dim")), h("dd", {}, String(status.dim))),
    h("p", {}, t("mediasearch.status.counts")),
    h("ul", { class: "plain-list" },
      h("li", {}, `${t("mediasearch.status.indexed")}: ${formatNumber(counts.indexed)}`),
      h("li", {}, `${t("mediasearch.status.pending")}: ${formatNumber(counts.pending)}`),
      h("li", {}, `${t("mediasearch.status.failed")}: ${formatNumber(counts.failed)}`),
      h("li", {}, `${t("mediasearch.status.unsupported")}: ${formatNumber(counts.unsupported)}`)),
    nothingYet && status.enabled ? h("p", { class: "field-hint" }, t("memory.media.empty")) : null,
    h("p", {}, `${t("mediasearch.status.backfill")}: ${t(`mediasearch.status.state.${bf.state}` as Key)} · ${t("mediasearch.status.progress", { done: formatNumber(bf.done), total: formatNumber(bf.total) })}`),
    h("progress", { value: bf.done, max: Math.max(1, bf.total), "aria-label": t("mediasearch.status.backfill") }),
    h("p", { role: "status", "aria-live": "polite", class: "sr-only" }, t("mediasearch.status.progressAnnounce", { done: formatNumber(bf.done), total: formatNumber(bf.total) })),
    reasonKey ? h("p", { class: "field-hint" }, t(reasonKey)) : null,
    canManage
      ? h("div", { class: "setup-nav" },
          bf.state === "running" ? h("button", { type: "button", class: "btn", disabled: busy !== "", onClick: () => { void act("media.index.pause"); } }, t("mediasearch.status.pause")) : null,
          bf.state === "paused" ? h("button", { type: "button", class: "btn", disabled: busy !== "", onClick: () => { void act("media.index.resume"); } }, t("mediasearch.status.resume")) : null,
          h("button", { type: "button", class: "btn", disabled: busy !== "" || !status.enabled, onClick: () => { setConfirming(true); } }, t("mediasearch.status.reindex")))
      : h("p", { class: "field-hint" }, t("mediasearch.status.noPermission")),
    message ? h("p", { role: message.tone === "err" ? "alert" : "status", class: message.tone === "err" ? "form-error" : "field-hint" }, message.text) : null,
    confirming ? h(ConfirmDialog, {
      title: t("mediasearch.status.reindexTitle"), confirmLabel: t("mediasearch.status.reindexConfirm"), danger: true,
      // Re-indexing is expensive: the person types the word before the confirm button works.
      expected: t("memory.media.reindexWord"), onConfirm: reindex, onClose: () => { setConfirming(false); },
    }, h("p", {}, t("mediasearch.status.reindexBody"))) : null,
  );
}
