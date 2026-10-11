// Settings > Modules & Updates model: the load of module.list and module.graph, the four actions, and the pure dependency helpers.
// "Depends on" follows the graph's edges (from depends on to); "affected" is everything a stop or restart takes down with it,
// the dependents and their dependents. The helpers take the graph as data, so the confirmations and the list agree.
import { getApi } from "../../common/load.ts";
import "./rpc-types.ts";
import type { ModuleGraph, ModuleListResult } from "./rpc-types.ts";

export type ModuleEntry = ModuleListResult["modules"][number];
export type ModuleAction = "start" | "stop" | "restart";
export type ModulesData = { modules: ModuleEntry[]; graph: ModuleGraph | null };

/** The list is required; the graph is optional, so a list without it still shows its modules (with no dependencies). */
export async function fetchModules(signal: AbortSignal): Promise<ModulesData> {
  const api = getApi();
  const [list, graph] = await Promise.all([
    api.rpc("module.list", undefined, { write: false, signal }),
    api.rpc("module.graph", undefined, { write: false, signal }).catch((e: unknown) => {
      if ((e as { kind?: unknown }).kind === "aborted") throw e;
      return null;
    }),
  ]);
  return { modules: list.modules, graph };
}

/** Subscribes this connection to module.state. The notifications only hint that the list changed; the data is never taken from them. */
export async function watchModules(): Promise<void> {
  await getApi().rpc("module.watch", undefined, { write: false });
}

export async function runAction(action: ModuleAction, name: string): Promise<void> {
  const api = getApi();
  if (action === "start") await api.rpc("module.start", { name });
  else if (action === "stop") await api.rpc("module.stop", { name });
  else await api.rpc("module.restart", { name });
}

export async function installModule(path: string): Promise<{ name: string; version: string; replaced: boolean }> {
  return getApi().rpc("module.install", { path });
}

export async function uninstallModule(name: string): Promise<void> {
  await getApi().rpc("module.uninstall", { name });
}

const unique = (xs: readonly string[]): string[] => [...new Set(xs)];

/** Modules this one depends on (needs and consumes edges), the core included. */
export function dependencies(graph: ModuleGraph | null, name: string): string[] {
  if (!graph) return [];
  return unique(graph.edges.filter((e) => e.from === name).map((e) => e.to)).sort();
}

/** Modules that depend on this one directly. */
export function dependents(graph: ModuleGraph | null, name: string): string[] {
  if (!graph) return [];
  return unique(graph.edges.filter((e) => e.to === name).map((e) => e.from)).sort();
}

/** Every module a stop or restart of `name` takes down with it: its dependents, their dependents, and so on. Sorted, `name` excluded. */
export function affected(graph: ModuleGraph | null, name: string): string[] {
  const seen = new Set<string>([name]);
  const out: string[] = [];
  const queue = [name];
  for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
    for (const d of dependents(graph, cur)) {
      if (seen.has(d)) continue;
      seen.add(d); out.push(d); queue.push(d);
    }
  }
  return out.sort();
}

/** What `name` needs that is missing or invalid (a needs name, or a consumes capability nobody provides). */
export function unresolved(graph: ModuleGraph | null, name: string): string[] {
  if (!graph) return [];
  return unique(graph.unresolved.filter((u) => u.from === name).map((u) => u.name ?? u.capability ?? "?")).sort();
}

/** The other members of every needs-cycle that contains `name`. */
export function cycleMembers(graph: ModuleGraph | null, name: string): string[] {
  if (!graph) return [];
  return unique(graph.cycles.filter((c) => c.includes(name)).flat().filter((m) => m !== name)).sort();
}

/** A running child (ready, degraded or still starting) can be stopped or restarted; anything else can be started. */
export function isRunning(m: ModuleEntry): boolean {
  const state = m.child?.process.state;
  return state === "ready" || state === "degraded" || state === "starting";
}

/** The error text a failed call shows: the server's message, with its machine reason when it has one. */
export function messageOf(e: unknown): string {
  const o = (typeof e === "object" && e !== null ? e : {}) as { message?: unknown; reason?: unknown };
  const message = typeof o.message === "string" && o.message !== "" ? o.message : "error";
  return typeof o.reason === "string" && o.reason !== "" ? `${message} (${o.reason})` : message;
}
