import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { getApi, useLoad } from "../common/load.ts";
import { PageLoading } from "../../components/page-state.ts";
import { formatDateTime, t, type Key } from "../../i18n.ts";

type Item = { id: string; agentId: string; activity: { state: string; since: number } };
type Page = { items: Item[]; nextCursor?: string };
export function AgentActivity(): View {
  const [agentId, setAgentId] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const { state, reload } = useLoad(async signal => await getApi().rpc("agent.activity.list", {
    ...(agentId ? { agentId } : {}), ...(since ? { since: new Date(since).toISOString() } : {}), ...(until ? { until: new Date(until).toISOString() } : {}), ...(cursor ? { cursor } : {}), limit: 50,
  }, { write: false, signal }) as Page, [agentId, since, until, cursor]);
  return h("section", { "aria-labelledby": "agent-activity-heading" },
    h("h2", { id: "agent-activity-heading" }, t("activity.agent.title")),
    h("div", { class: "activity-range" },
      h("label", {}, t("activity.agent.filter"), h("input", { value: agentId, onInput: (e: Event) => { setAgentId((e.currentTarget as HTMLInputElement).value); setCursor(undefined); } })),
      h("label", {}, t("activity.agent.since"), h("input", { type: "datetime-local", value: since, onChange: (e: Event) => { setSince((e.currentTarget as HTMLInputElement).value); setCursor(undefined); } })),
      h("label", {}, t("activity.agent.until"), h("input", { type: "datetime-local", value: until, onChange: (e: Event) => { setUntil((e.currentTarget as HTMLInputElement).value); setCursor(undefined); } }))),
    state.status === "loading" ? h(PageLoading, { label: t("state.loading") }) : state.status === "fail" ? h("p", { role: "status" }, t("activity.agent.unavailable"), " ", h("button", { type: "button", class: "btn", onClick: () => { setCursor(undefined); reload(); } }, t("activity.agent.reload"))) : h("div", {},
      h("ul", { class: "plain-list activity-list" }, state.data.items.map(i => h("li", { key: i.id, class: "activity-entry" }, `${i.agentId}: ${t(`activity.agent.state.${i.activity.state}` as Key)} · ${formatDateTime(new Date(i.activity.since))}`))),
      state.data.nextCursor ? h("button", { class: "btn", type: "button", onClick: () => setCursor(state.data.nextCursor) }, t("activity.more")) : null));
}
