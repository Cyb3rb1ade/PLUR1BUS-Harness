// Agents page (`/agents`, `/agents/new`, `/agents/<id>`, K3): list and detail from `config.get agents`, multi-step create
// with a client idempotency key via `config.set`. Pause, archive, export and delete have no RPC (F39) and are shown as
// unavailable. Only owner/admin may create or change; other roles can view.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { ListDetail } from "../../components/list-detail.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { t, type Key } from "../../i18n.ts";
import { navigate } from "../../router.ts";
import type { PageProps } from "../registry.ts";
import { currentRole, roleIn, useLoad } from "../common/load.ts";
import { FailureState, Notice } from "../common/states.ts";
import { CreateAgent } from "./create.ts";
import { AgentDetail, whenText } from "./detail.ts";
import { readAgents, type Agent } from "./model.ts";
import { registerArea } from "../../i18n/index.ts";
import * as agentsArea from "../../i18n/agents.ts";
import "../../styles/agents.css";

registerArea("agents", agentsArea);


function Row({ agent, current }: { agent: Agent; current: boolean }): View {
  const n = agent.skills.length;
  return h("li", {},
    h("a", { class: "nav-link a-row", href: `#/agents/${encodeURIComponent(agent.id)}`, ...(current ? { "aria-current": "true" } : {}) },
      h("span", { class: "a-row-name" }, agent.name),
      h("span", { class: "a-mono a-row-id" }, agent.id),
      h("span", { class: "a-row-meta" }, t("agents.list.created", { when: whenText(agent.createdAt) }), " · ", n === 1 ? t("agents.skills.one") : t("agents.skills.count", { count: n })),
      h(Badge, { tone: agent.state === "active" ? "ok" : agent.state === "paused" ? "warn" : "neutral" }, t(`agents.state.${agent.state}` as Key))));
}

/** Arrow keys move between the rows of the list (Home/End jump); Tab still reaches every row. */
function arrows(e: KeyboardEvent): void {
  const k = e.key;
  if (k !== "ArrowDown" && k !== "ArrowUp" && k !== "Home" && k !== "End") return;
  const links = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("a.a-row"));
  const at = links.indexOf(document.activeElement as HTMLElement);
  if (links.length === 0) return;
  const to = k === "Home" ? 0 : k === "End" ? links.length - 1 : Math.max(0, Math.min(links.length - 1, at + (k === "ArrowDown" ? 1 : -1)));
  e.preventDefault();
  links[to]?.focus();
}

export function AgentsPage({ sub }: PageProps): View {
  const { state, reload } = useLoad((signal) => readAgents(signal), []);
  const [fresh, setFresh] = useState<Agent[]>([]);
  const [flash, setFlash] = useState("");
  const canManage = roleIn(currentRole(), ["owner", "admin"]);
  const title = t("nav.agents");

  if (state.status === "loading") return h(Page, { title }, h(PageLoading, { label: t("state.loading") }));
  if (state.status === "fail") return h(Page, { title }, h(FailureState, { failure: state.failure, unavailable: t("agents.unavailable.title"), onRetry: reload }));

  const loaded = state.data.agents;
  const agents = [...fresh.filter((f) => !loaded.some((a) => a.id === f.id)), ...loaded];
  const create = canManage
    ? h("a", { class: "btn btn-primary", href: "#/agents/new" }, t("agents.create"))
    : null;

  if (agents.length === 0 && sub === undefined) {
    return h(Page, { title }, h(PageState, { state: "empty", title: t("agents.empty.title"), detail: t("agents.empty.body") }, create ?? h(Notice, {}, t("agents.noCreateRole"))));
  }

  const isNew = sub === "new";
  const id = sub === undefined || isNew ? null : decodeURIComponent(sub);
  const agent = id === null ? undefined : agents.find((a) => a.id === id);

  const list = h("div", {},
    create ?? h(Notice, {}, t("agents.noCreateRole")),
    h("ul", { class: "plain-list", "aria-label": t("agents.list.label"), onKeyDown: arrows }, agents.map((a) => h(Row, { key: a.id, agent: a, current: a.id === id }))));

  const onCreated = (a: Agent, already: boolean): void => {
    setFresh((f) => [a, ...f.filter((x) => x.id !== a.id)]);
    setFlash(t(already ? "agents.flash.already" : "agents.flash.created", { name: a.name }));
    reload();
    navigate(`/agents/${encodeURIComponent(a.id)}`);
  };

  let detail: View;
  if (isNew) detail = canManage ? h(CreateAgent, { existing: agents, onCreated }) : h(PageState, { state: "forbidden" });
  else if (agent) detail = h("div", {}, flash ? h(Notice, {}, flash) : null, h(AgentDetail, { key: agent.id, agent, canManage }));
  else detail = h(PageState, { state: "empty", title: t("agents.notFound.title"), detail: t("shared.notFound.detail") }, h("a", { class: "btn", href: "#/agents" }, t("agents.notFound.back")));

  return h(Page, { title, width: "full" },
    h(ListDetail, { list, detail, selected: sub !== undefined, listLabel: t("agents.list.label"), detailLabel: t("agents.detail.label"), onBack: () => { navigate("/agents"); } }));
}
