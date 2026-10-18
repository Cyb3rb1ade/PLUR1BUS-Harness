// Agent creation uses the server saga with one actor-bound idempotency key per attempt.
import { getApi } from "../../api/shared.ts";

export type AgentState = "active" | "paused" | "archived";
export type Agent = { id: string; name: string; createdAt: string | null; skills: string[]; state: AgentState };
export type AgentsData = { agents: Agent[]; revision: string };

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const NAME_MAX = 80;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseAgents(res: unknown): AgentsData {
  const o = isObj(res) ? res : {};
  const value = isObj(o.value) ? o.value : {};
  const agents = Object.entries(value).filter(([, v]) => isObj(v)).map(([id, v]): Agent => {
    const a = v as Record<string, unknown>;
    const state = a.state === "paused" || a.state === "archived" ? a.state : "active";
    return {
      id,
      name: typeof a.displayName === "string" && a.displayName !== "" ? a.displayName : id,
      createdAt: typeof a.createdAt === "string" ? a.createdAt : null,
      skills: Array.isArray(a.skills) ? a.skills.filter((s): s is string => typeof s === "string") : [],
      state,
    };
  });
  agents.sort((x, y) => (y.createdAt ?? "").localeCompare(x.createdAt ?? "") || x.id.localeCompare(y.id));
  return { agents, revision: typeof o.revision === "string" ? o.revision : "" };
}

/** `config.get` of key `agents`. A configuration without that key answers E_NOT_FOUND on some servers: then the whole
 *  configuration gives the revision and the list is empty. */
export async function readAgents(signal?: AbortSignal): Promise<AgentsData> {
  const api = getApi();
  const opts = { write: false, ...(signal ? { signal } : {}) };
  try {
    return parseAgents(await api.rpc("config.get", { key: "agents" }, opts));
  } catch (e) {
    if ((e as { errorCode?: unknown }).errorCode !== "E_NOT_FOUND") throw e;
    const whole = await api.rpc("config.get", undefined, opts);
    const value = isObj(whole) && isObj(whole.value) ? whole.value.agents : undefined;
    return parseAgents({ value, revision: isObj(whole) ? whole.revision : "" });
  }
}

/** Installed skill names (`ext.list`, kind skill); throws when the RPC is missing or fails. */
export async function readSkills(signal?: AbortSignal): Promise<string[]> {
  const res = await getApi().rpc("ext.list", { kind: ["skill"] }, { write: false, ...(signal ? { signal } : {}) });
  const items = isObj(res) && Array.isArray(res.items) ? res.items : [];
  return items.filter(isObj).map((i) => i.name).filter((n): n is string => typeof n === "string");
}

export function slug(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return s.replace(/-+$/g, "");
}

export type Attempt = { key: string; createdAt: string };
export const newAttempt = (): Attempt => ({ key: globalThis.crypto.randomUUID(), createdAt: new Date().toISOString() });
/** The id to suggest: from the name, else reserved from the attempt key so a nameless suggestion is still unique. */
export const reservedId = (name: string, a: Attempt): string => slug(name) || `agent-${a.key.slice(0, 8)}`;

export type CreateInput = { id: string; name: string; skills: readonly string[] };
export type CreateFailure = "taken" | "conflict" | "invalid" | "forbidden" | "unavailable" | "failed";
export type CreateOutcome = { ok: true; already: boolean; agent: Agent } | { ok: false; kind: CreateFailure; detail?: string };

/** Retries send the same idempotency key; only the server decides whether the write already committed. */
export async function createAgent(a: Attempt, v: CreateInput): Promise<CreateOutcome> {
  try {
    const result = await getApi().rpc("agent.create", { name: v.id, displayName: v.name, skills: [...v.skills], idempotencyKey: a.key });
    return { ok: true, already: isObj(result) && result.replayed === true, agent: { id: v.id, name: v.name, createdAt: a.createdAt, skills: [...v.skills], state: "active" } };
  } catch (e) {
    const o = (typeof e === "object" && e !== null ? e : {}) as { kind?: unknown; errorCode?: unknown; message?: unknown };
    if (o.kind === "forbidden") return { ok: false, kind: "forbidden" };
    if (o.kind === "unavailable") return { ok: false, kind: "unavailable" };
    if (o.errorCode === "E_AGENT_EXISTS") return { ok: false, kind: "taken" };
    if (o.errorCode === "E_CONFLICT") return { ok: false, kind: "conflict" };
    if (o.errorCode === "E_CONFIG_INVALID") return { ok: false, kind: "invalid", detail: typeof o.message === "string" ? o.message : "" };
    return { ok: false, kind: "failed" };
  }
}

export async function pauseAgent(agentId: string): Promise<void> {
  await getApi().rpc("agent.pause", { agentId });
}

export async function resumeAgent(agentId: string): Promise<void> {
  await getApi().rpc("agent.resume", { agentId });
}

export async function archiveAgent(agentId: string): Promise<void> {
  await getApi().rpc("agent.archive", { agentId });
}

export async function unarchiveAgent(agentId: string): Promise<void> {
  await getApi().rpc("agent.unarchive", { agentId });
}

export async function exportAgent(agentId: string, offerOnly = false) {
  return await getApi().rpc("agent.export", { agentId, offerOnly });
}

export type DeleteAgentOutcome = { ok: true } | { ok: false; kind: "unavailable" | "engine-erasure-unavailable" | "forbidden" | "failed"; message?: string };

export async function deleteAgent(agentId: string, confirmName: string, exportOfferId: string): Promise<DeleteAgentOutcome> {
  try {
    await getApi().rpc("agent.delete", { agentId, confirmName, exportOfferId });
    return { ok: true };
  } catch (e) {
    const o = (typeof e === "object" && e !== null ? e : {}) as { kind?: unknown; errorCode?: unknown; message?: unknown; reason?: unknown };
    if (o.kind === "unavailable" || o.errorCode === "E_NOT_AVAILABLE") return { ok: false, kind: "unavailable" };
    if (o.kind === "forbidden" || o.errorCode === "E_DENIED") return { ok: false, kind: "forbidden" };
    if (o.reason === "engine-erasure-unavailable" || o.errorCode === "E_ENGINE_ERASURE_UNAVAILABLE" || (typeof o.message === "string" && o.message.includes("engine erasure"))) {
      return { ok: false, kind: "engine-erasure-unavailable" };
    }
    return { ok: false, kind: "failed", ...(typeof o.message === "string" ? { message: o.message } : {}) };
  }
}

export type AgentRight = { userId: string; right: "use" | "manage" };

export async function readAgentRights(agentId: string, signal?: AbortSignal): Promise<AgentRight[]> {
  try {
    const res = await getApi().rpc("agent.rights.get", { agentId }, { write: false, ...(signal ? { signal } : {}) });
    const o = typeof res === "object" && res !== null ? (res as { rights?: unknown }) : {};
    if (Array.isArray(o.rights)) {
      return o.rights.filter((r): r is AgentRight => typeof r === "object" && r !== null && ((r as AgentRight).right === "use" || (r as AgentRight).right === "manage"));
    }
    return [];
  } catch {
    return [];
  }
}

