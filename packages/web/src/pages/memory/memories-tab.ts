// The "Memories" tab: agent choice, health, reviews, search with explanation, card list + detail. Every part loads and fails
// on its own; only a missing agent list (no way to say whose memory to read) takes the whole tab down.
import { signal } from "@preact/signals";
import { h } from "preact";
import type { View } from "../../view.ts";
import { PageState } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { CardsSection } from "./cards.ts";
import { FailureState } from "./common.ts";
import { failureOf, getApi, useLoad, type Failure } from "./data.ts";
import { Health, loadCoreStatus, type CoreStatusLite } from "./health.ts";
import { Reviews } from "./reviews.ts";
import { Search } from "./search.ts";

type Agents = { agents: string[]; core: CoreStatusLite | null; coreFailure: Failure | null };

/** Agents come from core.status; when that is not served, the REST list of the Harness API (GET /api/v1/agents, which exists
 *  today) keeps the page usable, and the health card says the engine status is missing. */
async function loadAgents(signal: AbortSignal): Promise<Agents> {
  try {
    const core = await loadCoreStatus(signal);
    return { agents: core.agents.map((a) => a.agentId), core, coreFailure: null };
  } catch (first) {
    if ((first as { kind?: string }).kind === "aborted") throw first;
    try {
      const rest = await getApi().get<{ agents?: { agentId?: unknown }[] }>("/api/v1/agents", { signal });
      return { agents: (rest.agents ?? []).flatMap((a) => (typeof a.agentId === "string" ? [a.agentId] : [])), core: null, coreFailure: failureOf(first) };
    } catch { throw first; }
  }
}

/** The chosen agent survives tab changes and reloads within the page session. */
const chosen = signal<string | null>(null);

export type MemoriesTabProps = { selectedId: string | null; tick: number; proposalTick: number };

export function MemoriesTab({ selectedId, tick, proposalTick }: MemoriesTabProps): View {
  const { state, reload } = useLoad(loadAgents, [], tick);
  if (state.status === "loading") return h(PageState, { state: "loading" });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("memory.unavailable.title"), onRetry: reload });
  const { agents, core, coreFailure } = state.data;
  if (agents.length === 0) return h(PageState, { state: "empty", title: t("memory.noAgents"), detail: t("memory.noAgentsDetail") });
  const agentId = chosen.value !== null && agents.includes(chosen.value) ? chosen.value : agents[0]!;

  return h("div", { class: "m-stack" },
    agents.length > 1
      ? h("div", { class: "inline-field" },
        h("label", { for: "memory-agent" }, t("memory.agent")),
        h("select", { id: "memory-agent", value: agentId, onChange: (e: Event) => { chosen.value = (e.target as HTMLSelectElement).value; } },
          agents.map((a) => h("option", { key: a, value: a, selected: a === agentId }, a))))
      : null,
    h(Health, { agentId, core, coreFailure, tick }),
    h(Reviews, { agentId, tick: tick + proposalTick }),
    h(Search, { key: agentId, agentId }),
    h(CardsSection, { key: agentId, agentId, selectedId, tick }));
}
