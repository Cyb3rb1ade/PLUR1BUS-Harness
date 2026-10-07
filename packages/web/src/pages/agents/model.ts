// Agents data and the create protocol. Agents live in config key `agents.<id>` ({ displayName, createdAt, skills }); there are
// no lifecycle RPCs (docs/web-ui.md F38/F39). Creation is idempotent on the client: one `Attempt` (random key + createdAt) per
// create attempt; before writing, the current configuration is read and an existing entry carrying this attempt's createdAt and
// name is OUR earlier write (lost response), so the retry reports success without writing again.
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

/** Read, check, write with `ifRevision`. Safe to call again after any failure with the same attempt. */
export async function createAgent(a: Attempt, v: CreateInput): Promise<CreateOutcome> {
  try {
    const cur = await readAgents();
    const ex = cur.agents.find((x) => x.id === v.id);
    if (ex) return ex.createdAt === a.createdAt && ex.name === v.name ? { ok: true, already: true, agent: ex } : { ok: false, kind: "taken" };
    await getApi().rpc("config.set", { changes: [{ key: `agents.${v.id}`, value: { displayName: v.name, createdAt: a.createdAt, skills: [...v.skills] } }], ifRevision: cur.revision });
    return { ok: true, already: false, agent: { id: v.id, name: v.name, createdAt: a.createdAt, skills: [...v.skills], state: "active" } };
  } catch (e) {
    const o = (typeof e === "object" && e !== null ? e : {}) as { kind?: unknown; errorCode?: unknown; message?: unknown };
    if (o.kind === "forbidden") return { ok: false, kind: "forbidden" };
    if (o.kind === "unavailable") return { ok: false, kind: "unavailable" };
    if (o.errorCode === "E_CONFLICT") return { ok: false, kind: "conflict" };
    if (o.errorCode === "E_CONFIG_INVALID") return { ok: false, kind: "invalid", detail: typeof o.message === "string" ? o.message : "" };
    return { ok: false, kind: "failed" };
  }
}
