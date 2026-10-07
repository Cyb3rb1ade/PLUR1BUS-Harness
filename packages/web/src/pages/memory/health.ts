// Health card: core.status (engine, models, store schema, shared memory) and memory.state (card counts) of the chosen agent.
// Each source fails on its own: a missing memory.state leaves the engine facts in place and says so.
import { h } from "preact";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { formatNumber, t } from "../../i18n.ts";
import { Facts, Panel, duration } from "./common.ts";
import { getApi, caller, useLoad, type Failure } from "./data.ts";
import type { Degraded } from "./rpc-types.ts";

type ModelLite = { state: string; warming?: boolean; id?: string | null; error?: string };
/** The part of core.status this page reads (docs/rpc.md CoreStatus). */
export type CoreStatusLite = {
  process: { state: string; reason?: string };
  uptimeMs: number;
  engine: {
    ready: boolean; degraded: Degraded | null;
    models?: { embedder?: ModelLite; reranker?: ModelLite };
    sharedMemory?: { supported: boolean; mode: string; reason?: string };
    storeSchema?: { current: string | null; expected: string };
  };
  agents: { agentId: string }[];
};

export async function loadCoreStatus(signal: AbortSignal): Promise<CoreStatusLite> {
  return (await getApi().rpc("core.status", undefined, { write: false, signal })) as CoreStatusLite;
}

function model(m: ModelLite | undefined): string {
  if (!m) return t("memory.none");
  const base = t(`memory.model.${m.state === "ready" || m.state === "loading" || m.state === "failed" || m.state === "disabled" ? m.state : "unknown"}`);
  return `${base}${m.id ? ` (${m.id})` : ""}${m.warming ? `, ${t("memory.model.warming")}` : ""}${m.error ? `: ${m.error}` : ""}`;
}

function EngineBadge({ engine }: { engine: CoreStatusLite["engine"] }): View {
  if (!engine.ready) return h(Badge, { tone: "err" }, t("memory.health.notReady"));
  if (engine.degraded) return h(Badge, { tone: "warn" }, t("memory.health.degraded"));
  return h(Badge, { tone: "ok" }, t("memory.health.ready"));
}

function Schema({ s }: { s: NonNullable<CoreStatusLite["engine"]["storeSchema"]> }): View {
  const behind = s.current !== s.expected;
  return h("span", { class: "m-row" },
    h("span", {}, s.current === null ? t("memory.health.schemaUnknown", { expected: s.expected }) : behind ? `${s.current} → ${s.expected}` : s.current),
    behind ? h(Badge, { tone: "warn" }, t("memory.health.migration")) : h(Badge, { tone: "ok" }, t("memory.health.upToDate")));
}

const count = (n: number | null): string => (n === null ? t("memory.none") : formatNumber(n));

export type HealthProps = { agentId: string; core: CoreStatusLite | null; coreFailure: Failure | null; tick: number };

export function Health({ agentId, core, coreFailure, tick }: HealthProps): View {
  const counts = useLoad((signal) => getApi().rpc("memory.state", { caller: caller(), agentId }, { write: false, signal }), [agentId], tick);
  const e = core?.engine;
  return h(Panel, { title: t("memory.health.title"), aside: e ? h(EngineBadge, { engine: e }) : null },
    h("div", { class: "m-stack" },
      core && e ? h(Facts, { rows: [
        [t("memory.health.degradation"), e.degraded ? `${e.degraded.reason} (${e.degraded.capability})${e.degraded.detail ? `: ${e.degraded.detail}` : ""}` : undefined],
        [t("memory.health.process"), core.process.reason ? `${core.process.state} (${core.process.reason})` : core.process.state],
        [t("memory.health.uptime"), duration(core.uptimeMs)],
        [t("memory.health.embedder"), model(e.models?.embedder)],
        [t("memory.health.reranker"), model(e.models?.reranker)],
        [t("memory.health.schema"), e.storeSchema ? h(Schema, { s: e.storeSchema }) : t("memory.none")],
        [t("memory.health.shared"), e.sharedMemory ? (e.sharedMemory.supported ? `${t("memory.health.supported")} (${e.sharedMemory.mode})` : `${t("memory.health.unsupported")}${e.sharedMemory.reason ? `: ${e.sharedMemory.reason}` : ""}`) : t("memory.none")],
      ] }) : h("p", { class: "m-muted" }, coreFailure?.kind === "forbidden" ? t("memory.health.statusForbidden") : t("memory.health.statusUnavailable")),
      counts.state.status === "loading" ? h("p", { role: "status", class: "m-muted" }, t("state.loading"))
        : counts.state.status === "fail" ? h("p", { class: "m-muted" }, counts.state.failure.kind === "forbidden" ? t("memory.health.countsForbidden") : t("memory.health.countsUnavailable"))
        : h(Facts, { rows: [
          [t("memory.scope.agentPrivate"), count(counts.state.data.cards.agentPrivate)],
          [t("memory.scope.workspace"), count(counts.state.data.cards.workspace)],
          [t("memory.scope.user"), count(counts.state.data.cards.user)],
          [t("memory.health.tombstones"), count(counts.state.data.tombstones)],
          [t("memory.health.archive"), counts.state.data.archiveDir],
          ...(counts.state.data.degraded ? [[t("memory.health.countsDegraded"), `${counts.state.data.degraded.reason} (${counts.state.data.degraded.capability})`] as const] : []),
        ] })));
}
