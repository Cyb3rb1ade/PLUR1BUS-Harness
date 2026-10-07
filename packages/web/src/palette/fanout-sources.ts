// The palette's entity sources, over RPCs that exist: agents (`config.get {key:"agents"}`, the same read as the Agents page) and
// sessions (`session.list`, the caller's own direct chats, server-side full-text `search`). Each returns plain data; the caller
// builds entries and applies the cap. A rejection means "drop this group".
import { getApi } from "../api/shared.ts";
import { fold } from "./match.ts";
import type { Source } from "./fanout.ts";

export type AgentRow = { id: string; name: string };
export type SessionRow = { id: string; title: string; agentId: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseAgentRows(res: unknown): AgentRow[] {
  const value = isObj(res) && isObj(res.value) ? res.value : {};
  return Object.entries(value).filter(([, v]) => isObj(v)).map(([id, v]) => {
    const name = (v as Record<string, unknown>).displayName;
    return { id, name: typeof name === "string" && name !== "" ? name : id };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function parseSessionRows(res: unknown): SessionRow[] {
  const list = isObj(res) && Array.isArray(res.sessions) ? res.sessions : [];
  return list.filter(isObj).flatMap((s) =>
    typeof s.id === "string" ? [{ id: s.id, title: typeof s.title === "string" ? s.title : "", agentId: typeof s.agentId === "string" ? s.agentId : "" }] : []);
}

/** `config.get` has no search: the agents are read whole and filtered here (label or id, folded). */
export const agentsSource: Source = {
  id: "agent",
  async load(query, signal) {
    let res: unknown;
    try { res = await getApi().rpc("config.get", { key: "agents" }, { write: false, signal }); }
    catch (e) {
      if ((e as { errorCode?: unknown }).errorCode === "E_NOT_FOUND") return [];
      throw e;
    }
    const ws = fold(query).text.split(/\s+/).filter((w) => w !== "");
    return parseAgentRows(res).filter((a) => ws.every((w) => fold(`${a.name} ${a.id}`).text.includes(w)));
  },
};

export const sessionsSource: Source = {
  id: "session",
  async load(query, signal) {
    const r = await getApi().rpc("session.list", { kind: "direct", archived: "exclude", search: query.slice(0, 500), limit: 5 }, { write: false, signal });
    return parseSessionRows(r);
  },
};
