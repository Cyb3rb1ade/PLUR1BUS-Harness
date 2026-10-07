// Chat page (`/chat`, `/chat/new`, `/chat/<sessionId>`): history column + conversation (desktop spec §13.7 "chat" pattern;
// ListDetail pushes the conversation in compact). Backend contract: docs/rpc.md session.*; /rpc and /events are not on
// origin/main yet, so every call can end in `unavailable`, which this page shows as such.
import { h } from "preact";
import { useEffect } from "preact/hooks";
import { Badge } from "../../components/card.ts";
import { ListDetail } from "../../components/list-detail.ts";
import { Page } from "../../components/page.ts";
import { PageState } from "../../components/page-state.ts";
import { formatDateTime, t } from "../../i18n.ts";
import { navigate } from "../../router.ts";
import type { View } from "../../view.ts";
import type { PageProps } from "../registry.ts";
import { NewChat } from "./new-chat.ts";
import type { SessionRecord } from "./rpc-types.ts";
import { SessionView } from "./session-view.ts";
import { list, refreshList, stateFor } from "./store.ts";

function History({ sessions, truncated, current }: { sessions: SessionRecord[]; truncated: boolean; current: string | null }): View {
  return h("div", null,
    h("div", { class: "chat-list-head" },
      h("h2", null, t("chat.list.heading")),
      h("a", { class: "btn btn-primary", href: "#/chat/new" }, t("chat.new"))),
    sessions.length === 0
      ? h(PageState, { state: "empty", title: t("chat.empty.title"), detail: t("chat.empty.body") })
      : h("ul", { class: "chat-rows" }, sessions.map((s) => h("li", { key: s.id },
        h("a", { class: "chat-row", href: `#/chat/${encodeURIComponent(s.id)}`, ...(s.id === current ? { "aria-current": "page" } : {}) },
          h("span", { class: "chat-row-title" }, s.title || t("chat.untitled")),
          h("span", { class: "chat-row-meta" }, h("span", { class: "chat-row-agent" }, s.agentId),
            s.memoryMode === "incognito" ? h(Badge, { tone: "info" }, t("chat.incognito")) : null,
            h("span", {}, formatDateTime(new Date(s.lastTurnAt ?? s.updatedAt)))))))),
    truncated ? h("p", { class: "chat-note" }, t("chat.truncated")) : null);
}

export function ChatPage({ item, sub }: PageProps): View {
  useEffect(() => { void refreshList(false); }, []);
  const title = t(item.label);
  const ls = list.value;

  if (ls.status === "loading") return h(Page, { title, width: "full" }, h(PageState, { state: "loading" }));
  if (ls.status === "error") {
    const state = stateFor(ls.error);
    return h(Page, { title, width: "full" },
      state === "unavailable" ? h(PageState, { state, title: t("chat.unavailable.title"), detail: t("chat.unavailable.body") })
        : state === "error" ? h(PageState, { state, onRetry: () => { void refreshList(false); } }) : h(PageState, { state }));
  }

  const first = sub?.split("/")[0];
  const sessionId = first === undefined || first === "new" ? null : decodeURIComponent(first);
  const detail = sessionId === null ? h(NewChat, {}) : h(SessionView, { key: sessionId, sessionId });
  return h(Page, { title, width: "full" },
    h(ListDetail, {
      list: h(History, { sessions: ls.sessions, truncated: ls.truncated, current: sessionId }),
      detail, empty: h(NewChat, {}), selected: first !== undefined,
      listLabel: t("chat.list.label"), detailLabel: t("chat.detail.label"), onBack: () => { navigate("/chat"); },
    }));
}
