import { StoredImage } from "../surfaces/stored-image.ts";
import { h } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { isApiError } from "../../api/index.ts";
import { Badge } from "../../components/card.ts";
import { PageState } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import type { View } from "../../view.ts";
import { Composer } from "./composer.ts";
import { ChatController } from "./controller.ts";
import type { Entry } from "./model.ts";
import { stateFor, takeDraft } from "./store.ts";

function Message({ e, agent }: { e: Entry; agent: string }): View {
  const who = e.role === "user" ? t("chat.role.user") : e.role === "assistant" ? agent : e.role === "tool" ? t("chat.role.tool") : t("chat.role.system");
  const cancelled = e.state === "failed" && e.error === "cancelled";
  return h("div", { class: "msg", "data-role": e.role },
    h("div", { class: "msg-who" }, who,
      e.state === "running" ? h(Badge, { tone: "info" }, t("chat.state.running")) : null,
      e.state === "completed" ? h(Badge, { tone: "ok" }, t("chat.state.completed")) : null,
      e.state === "failed" ? h(Badge, { tone: cancelled ? "neutral" : "err" }, cancelled ? t("chat.state.cancelled") : t("chat.state.failed")) : null),
    h("div", { class: "msg-text" }, e.text),
    e.outputId ? h(StoredImage, { id: e.outputId, download: true }) : null,
    e.state === "failed" && !cancelled && e.error ? h("p", { class: "msg-detail" }, t("chat.failed.detail", { error: e.error })) : null);
}

function LoadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }): View {
  if (isApiError(error) && error.kind === "rpc-error") {
    if (error.errorCode === "E_NOT_FOUND") return h(PageState, { state: "empty", title: t("chat.notFound.title"), detail: t("chat.notFound.body") });
    if (error.errorCode === "E_CONFLICT") return h(PageState, { state: "empty", title: t("chat.archived.title"), detail: t("chat.archived.body") });
  }
  const state = stateFor(error);
  if (state === "unavailable") return h(PageState, { state, title: t("chat.unavailable.title"), detail: t("chat.unavailable.body") });
  return h(PageState, state === "error" ? { state, onRetry } : { state });
}

export function SessionView({ sessionId }: { sessionId: string }): View {
  const ctl = useMemo(() => new ChatController(sessionId), [sessionId]);
  const carried = useMemo(() => takeDraft(sessionId), [sessionId]);
  const [draft, setDraft] = useState(carried?.text ?? "");
  const box = useRef<HTMLTextAreaElement>(null);
  const logEl = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (carried?.error) ctl.notice.value = carried.error;
    void ctl.start();
    return () => { ctl.stop(); };
  }, [ctl, carried]);

  const load = ctl.load.value;
  const tr = ctl.tr.value;
  const ready = load.status === "ready";

  // Opening a chat puts the cursor in the composer; once, when it has loaded.
  useEffect(() => { if (ready) box.current?.focus(); }, [ready, ctl]);
  // Follow the end of the transcript unless the reader scrolled up.
  useLayoutEffect(() => { const el = logEl.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [tr]);

  if (load.status === "loading") return h(PageState, { state: "loading", title: t("chat.loadingSession") });
  if (load.status === "error") return h(LoadFailure, { error: load.error, onRetry: () => { void ctl.start(); } });

  const { session } = load;
  const running = tr.runningTurnId !== null;
  const agent = session.agentId;
  const live = [...tr.entries].reverse().find((e) => e.role === "assistant" && e.state !== undefined);
  const status = live === undefined ? "" : live.state === "running" ? t("chat.status.running", { agent })
    : live.state === "completed" ? t("chat.status.completed") : live.error === "cancelled" ? t("chat.status.cancelled") : t("chat.status.failed");
  const incognito = session.memoryMode === "incognito";
  const notice = ctl.notice.value;
  const liveState = ctl.live.value;

  const submit = async (): Promise<void> => {
    const text = draft.replace(/\s+$/, "");
    if (text === "") return;
    setDraft("");
    stick.current = true;
    const ok = await ctl.send(text);
    if (!ok) setDraft((d) => (d === "" ? text : d));
    box.current?.focus();
  };

  return h("div", { class: "chat-pane transcript" },
    h("div", { class: "chat-head" },
      h("h2", null, session.title || t("chat.untitled")),
      h(Badge, null, agent),
      incognito ? h(Badge, { tone: "info" }, t("chat.incognito")) : null),
    liveState === "unavailable" ? h("p", { class: "chat-note" }, t("chat.live.polling")) : null,
    liveState === "retrying" ? h("p", { class: "chat-note", role: "status" }, t("chat.live.reconnecting")) : null,
    h("div", {
      class: "chat-log", role: "log", "aria-live": "polite", "aria-relevant": "additions", "aria-busy": String(running),
      "aria-label": t("chat.transcript.label", { agent }), tabIndex: 0, ref: logEl,
      onScroll: () => { const el = logEl.current; if (el) stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 48; },
    }, tr.entries.length === 0 ? h("p", { class: "chat-empty" }, t("chat.transcript.empty")) : tr.entries.map((e) => h(Message, { key: e.id, e, agent }))),
    h("div", { class: "sr-only", role: "status" }, status),
    notice ? h("p", { class: "chat-notice", role: "alert" }, t(notice)) : null,
    h(Composer, {
      label: t("chat.compose.label", { agent }), placeholder: t("chat.compose.placeholder", { agent }), value: draft, onInput: setDraft,
      onSend: () => { void submit(); }, sendLabel: t("chat.send"), ready: !ctl.sending.value, running,
      onStop: () => { void ctl.cancel().then(() => { box.current?.focus(); }); }, box,
    }));
}
