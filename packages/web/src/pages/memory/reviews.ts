// Reviews: change proposals against shared copies that wait for the sharing agent (memory.proposals.list, status pending).
// Read-only here: accepting or rejecting changes shared memory, and that confirmation flow is a follow-up of this page.
import { h } from "preact";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { PageState } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { FailureState, Panel, time } from "./common.ts";
import { getApi, useLoad } from "./data.ts";

export function Reviews({ agentId, tick }: { agentId: string; tick: number }): View {
  const { state, reload } = useLoad((signal) => getApi().rpc("memory.proposals.list", { agentId, status: "pending", limit: 20 }, { write: false, signal }), [agentId], tick);
  let body: View;
  if (state.status === "loading") body = h(PageState, { state: "loading" });
  else if (state.status === "fail") body = h(FailureState, { failure: state.failure, unavailable: t("memory.reviews.unavailable"), onRetry: reload });
  else if (state.data.items.length === 0) body = h(PageState, { state: "empty", title: t("memory.reviews.empty"), detail: t("memory.reviews.emptyDetail") });
  else {
    const { items, truncated, unreadable } = state.data;
    body = h("div", { class: "m-stack" },
      h("ul", { class: "plain-list" }, items.map((p) => h("li", { key: p.id, class: "m-item m-review" },
        h("span", { class: "m-row" }, h(Badge, { tone: "warn" }, t("memory.reviews.pending")), h(Badge, {}, t(`memory.scope.${p.target}`)),
          h("span", { class: "m-muted" }, t("memory.reviews.from", { proposer: p.proposerAgentId, when: time(p.createdAt) }))),
        p.note ? h("span", { class: "m-wrap" }, p.note) : null,
        h("span", { class: "m-wrap" }, h("strong", {}, t("memory.reviews.before")), " ", p.oldText),
        h("span", { class: "m-wrap" }, h("strong", {}, t("memory.reviews.after")), " ", p.newText)))),
      truncated ? h("p", { class: "m-muted" }, t("memory.reviews.truncated")) : null,
      unreadable > 0 ? h("p", { class: "m-muted" }, t("memory.reviews.unreadable", { n: unreadable })) : null);
  }
  return h(Panel, { title: t("memory.reviews.title"), aside: state.status === "ok" && state.data.items.length > 0 ? h(Badge, { tone: "warn" }, String(state.data.items.length)) : null }, body);
}
