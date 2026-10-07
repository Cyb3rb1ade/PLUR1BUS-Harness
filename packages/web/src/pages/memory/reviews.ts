// Reviews: change proposals against shared copies that wait for the sharing agent (memory.proposals.list, status pending).
// Read-only here: accepting or rejecting changes shared memory, and that confirmation flow is a follow-up of this page.
import { h } from "preact";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { PageState } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { FailureState, Panel, S, time } from "./common.ts";
import { caller, getApi, useLoad } from "./data.ts";

export function Reviews({ agentId, tick }: { agentId: string; tick: number }): View {
  const { state, reload } = useLoad((signal) => getApi().rpc("memory.proposals.list", { caller: caller(), agentId, status: "pending", limit: 20 }, { write: false, signal }), [agentId], tick);
  let body: View;
  if (state.status === "loading") body = h(PageState, { state: "loading" });
  else if (state.status === "fail") body = h(FailureState, { failure: state.failure, unavailable: t("memory.reviews.unavailable"), onRetry: reload });
  else if (state.data.items.length === 0) body = h(PageState, { state: "empty", title: t("memory.reviews.empty"), detail: t("memory.reviews.emptyDetail") });
  else {
    const { items, truncated, unreadable } = state.data;
    body = h("div", { style: S.stack },
      h("ul", { class: "plain-list" }, items.map((p) => h("li", { key: p.id, style: { ...S.item, padding: "8px 0", borderBottom: "1px solid var(--line)" } },
        h("span", { style: S.row }, h(Badge, { tone: "warn" }, t("memory.reviews.pending")), h(Badge, {}, t(`memory.scope.${p.target}`)),
          h("span", { style: S.muted }, t("memory.reviews.from", { proposer: p.proposerAgentId, when: time(p.createdAt) }))),
        p.note ? h("span", { style: S.clamp }, p.note) : null,
        h("span", { style: S.clamp }, h("strong", {}, t("memory.reviews.before")), " ", p.oldText),
        h("span", { style: S.clamp }, h("strong", {}, t("memory.reviews.after")), " ", p.newText)))),
      truncated ? h("p", { style: S.muted }, t("memory.reviews.truncated")) : null,
      unreadable > 0 ? h("p", { style: S.muted }, t("memory.reviews.unreadable", { n: unreadable })) : null);
  }
  return h(Panel, { title: t("memory.reviews.title"), aside: state.status === "ok" && state.data.items.length > 0 ? h(Badge, { tone: "warn" }, String(state.data.items.length)) : null }, body);
}
