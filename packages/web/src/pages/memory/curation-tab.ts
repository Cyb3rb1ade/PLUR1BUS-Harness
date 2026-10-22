// Human Neo keep/drop curation. D31 shared-memory proposals stay in the Memories tab.
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { PageState } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { FailureState, Panel } from "./common.ts";
import { failureOf, getApi, useLoad, type Failure } from "./data.ts";
import { loadAgents } from "./memories-tab.ts";
import type { CurationRecord } from "./rpc-types.ts";

function Candidate({ row, agentId, onResolved }: { row: CurationRecord; agentId: string; onResolved: () => void }): View {
  const [action, setAction] = useState<"keep" | "drop" | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const resolve = async (): Promise<void> => {
    if (busy || action === null) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setFailure(null);
    try {
      await getApi().rpc("memory.curation.resolve", { agentId, id: row.id, action }, { write: true, signal: controller.signal });
      if (!controller.signal.aborted) onResolved();
    } catch (error) { if (!controller.signal.aborted) setFailure(failureOf(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const refused = failure?.kind === "forbidden";
  return h("li", { class: "m-item" },
    h("span", { class: "m-muted" }, `${row.id} · ${t(`memory.curation.status.${row.status}`)}`),
    h("p", { class: "m-wrap" }, row.text),
    action === null ? h("div", { class: "m-row" },
      h("button", { class: "btn", type: "button", disabled: busy || refused, onClick: () => setAction("keep") }, t("memory.curation.keep")),
      h("button", { class: "btn", type: "button", disabled: busy || refused, onClick: () => setAction("drop") }, t("memory.curation.drop")))
      : h("div", { class: "m-stack" },
        h("p", {}, t(action === "keep" ? "memory.curation.confirmKeep" : "memory.curation.confirmDrop")),
        h("div", { class: "m-row" },
          h("button", { class: "btn", type: "button", disabled: busy || refused, onClick: () => { void resolve(); } }, t("memory.curation.confirm")),
          h("button", { class: "btn btn-quiet", type: "button", disabled: busy, onClick: () => setAction(null) }, t("memory.curation.cancel")))),
    failure ? h(FailureState, { failure, unavailable: t("memory.curation.unavailable") }) : null);
}

function Queue({ agentId, tick }: { agentId: string; tick: number }): View {
  const [bump, setBump] = useState(0);
  const { state, reload } = useLoad(signal => getApi().rpc("memory.curation.list", { agentId, limit: 100 }, { write: false, signal }), [agentId], tick + bump);
  if (state.status === "loading") return h(PageState, { state: "loading" });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("memory.curation.unavailable"), onRetry: reload });
  return h(Panel, { title: t("memory.tab.curation") },
    h("p", { class: "m-muted" }, t("memory.curation.distinction")),
    state.data.items.length === 0 ? h("p", { role: "status" }, t("memory.curation.empty"))
      : h("ul", { class: "plain-list" }, state.data.items.map(row => h(Candidate, { key: row.id, row, agentId, onResolved: () => setBump(n => n + 1) }))),
    state.data.truncated ? h("p", { role: "status", class: "m-muted" }, t("memory.curation.truncated")) : null);
}

export function CurationTab({ tick }: { tick: number }): View {
  const [chosen, setChosen] = useState("");
  const { state, reload } = useLoad(loadAgents, [], tick);
  if (state.status === "loading") return h(PageState, { state: "loading" });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("memory.curation.unavailable"), onRetry: reload });
  const agents = state.data.agents;
  const agentId = agents.includes(chosen) ? chosen : agents[0];
  if (!agentId) return h(PageState, { state: "empty", title: t("memory.noAgents"), detail: t("memory.noAgentsDetail") });
  return h("div", { class: "m-stack" },
    h("div", { class: "inline-field" }, h("label", { for: "curation-agent" }, t("memory.agent")),
      h("select", { id: "curation-agent", value: agentId, onChange: (event: Event) => setChosen((event.target as HTMLSelectElement).value) }, agents.map(id => h("option", { key: id, value: id, selected: id === agentId }, id)))),
    h(Queue, { key: agentId, agentId, tick }));
}
