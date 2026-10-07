// Card list + detail (desktop spec §13.7 "list + detail"): memory.list with a topic filter and "Load more", memory.show for the
// card in the URL (`#/memories/<id>`).
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { ListDetail } from "../../components/list-detail.ts";
import { PageState } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { navigate } from "../../router.ts";
import { Facts, FailureState, Panel, scopeLabel, time } from "./common.ts";
import { caller, getApi, useLoad } from "./data.ts";

const STEP = 20;
const MAX = 100;

function ListPane({ agentId, selectedId, tick }: { agentId: string; selectedId: string | null; tick: number }): View {
  const [limit, setLimit] = useState(STEP);
  const [topicInput, setTopicInput] = useState("");
  const [topic, setTopic] = useState("");
  const { state, reload } = useLoad((signal) => getApi().rpc("memory.list", {
    caller: caller(), agentId, limit, ...(topic === "" ? {} : { topic }),
  }, { write: false, signal }), [agentId, topic], tick);

  const apply = (e: Event): void => {
    e.preventDefault();
    const next = topicInput.trim();
    setLimit(STEP);
    if (next === topic) reload(); else setTopic(next);
  };
  const more = (): void => { setLimit((n) => Math.min(MAX, n + STEP)); reload(); };

  const filter = h("form", { onSubmit: apply, class: "m-stack" },
    h("div", { class: "field" },
      h("label", { for: "memory-topic" }, t("memory.list.topic")),
      h("input", { id: "memory-topic", type: "text", value: topicInput, autocomplete: "off", onInput: (e: Event) => setTopicInput((e.target as HTMLInputElement).value) })),
    h("div", {}, h("button", { type: "submit", class: "btn" }, t("memory.list.apply"))));

  let body: View;
  if (state.status === "loading") body = h(PageState, { state: "loading" });
  else if (state.status === "fail") body = h(FailureState, { failure: state.failure, unavailable: t("memory.list.unavailable"), onRetry: reload });
  else if (state.data.items.length === 0) {
    body = h(PageState, { state: "empty", title: topic === "" ? t("memory.list.empty") : t("memory.list.emptyTopic"), detail: topic === "" ? t("memory.list.emptyDetail") : t("memory.list.emptyTopicDetail") });
  } else {
    const { items, truncated, degraded } = state.data;
    body = h("div", { class: "m-stack" },
      degraded ? h("p", {}, h(Badge, { tone: "warn" }, t("memory.list.degraded", { reason: degraded.reason }))) : null,
      h("ul", { class: "plain-list" }, items.map((c) => h("li", { key: c.id },
        h("a", { class: "nav-link", href: `#/memories/${encodeURIComponent(c.id)}`, ...(c.id === selectedId ? { "aria-current": "true" } : {}) },
          h("span", { class: "m-item" },
            h("span", { class: "m-wrap m-item-title" }, c.summary === "" ? c.id : c.summary),
            h("span", { class: "m-row" }, h(Badge, {}, scopeLabel(c.scope)), h("span", { class: "m-muted" }, time(c.createdAt)))))))),
      truncated
        ? (items.length >= MAX
          ? h("p", { class: "m-muted" }, t("memory.list.capped", { n: MAX }))
          : h("div", {}, h("button", { type: "button", class: "btn", onClick: more }, t("memory.list.more"))))
        : null);
  }
  return h("div", { class: "m-stack" }, filter, body);
}

function DetailPane({ agentId, id }: { agentId: string; id: string }): View {
  const { state, reload } = useLoad((signal) => getApi().rpc("memory.show", { caller: caller(), agentId, id }, { write: false, signal }), [agentId, id]);
  if (state.status === "loading") return h(PageState, { state: "loading" });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("memory.detail.unavailable"), notFound: t("memory.detail.notFound"), onRetry: reload });
  const c = state.data.card;
  return h(Panel, { title: c.summary === "" ? c.id : c.summary },
    h("div", { class: "m-stack" },
      h("p", {}, h(Badge, {}, scopeLabel(c.scope))),
      state.data.degraded ? h("p", {}, h(Badge, { tone: "warn" }, t("memory.list.degraded", { reason: state.data.degraded.reason }))) : null,
      h("p", { class: "m-prose" }, c.text),
      h(Facts, { rows: [
        [t("memory.detail.id"), c.id],
        [t("memory.detail.created"), time(c.createdAt)],
        [t("memory.detail.origin"), c.origin],
        [t("memory.detail.status"), c.epistemicStatus],
        c.sharedBy === undefined ? [t("memory.detail.sharedBy"), undefined] : [t("memory.detail.sharedBy"), c.sharedBy],
        c.sourceId === undefined ? [t("memory.detail.source"), undefined] : [t("memory.detail.source"), c.sourceId],
      ] })));
}

export function CardsSection({ agentId, selectedId, tick }: { agentId: string; selectedId: string | null; tick: number }): View {
  return h(ListDetail, {
    selected: selectedId !== null, listLabel: t("memory.list.label"), detailLabel: t("memory.detail.label"), onBack: () => { navigate("/memories"); },
    list: h(ListPane, { agentId, selectedId, tick }),
    detail: selectedId === null ? null : h(DetailPane, { agentId, id: selectedId, key: selectedId }),
  });
}
