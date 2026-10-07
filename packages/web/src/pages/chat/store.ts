// Shared state of the chat page: the API client, the history list, the agents and the hand-over of an unsent draft.
import { signal } from "@preact/signals";
import { API_ROUTES, isApiError } from "../../api/index.ts";
import { getApi } from "../../api/shared.ts";
import type { Key } from "../../i18n.ts";
import { sessionNotice, sessionState } from "../../session.ts";
import type { AgentsAnswer, SessionRecord } from "./rpc-types.ts";

export type ListState =
  | { status: "loading" }
  | { status: "ready"; sessions: SessionRecord[]; truncated: boolean }
  | { status: "error"; error: unknown };
export const list = signal<ListState>({ status: "loading" });

/** Loads the history; `silent` keeps what is shown while it refreshes (after a turn, after creating a chat). */
export async function refreshList(silent: boolean): Promise<void> {
  if (!silent) list.value = { status: "loading" };
  try {
    const r = await getApi().rpc("session.list", { kind: "direct", archived: "exclude", limit: 100 }, { write: false });
    list.value = { status: "ready", sessions: r.sessions, truncated: r.truncated };
  } catch (error) {
    if (silent && list.value.status === "ready") return;
    list.value = { status: "error", error };
  }
}

export type AgentsState = { status: "loading" } | { status: "ready"; agents: string[] } | { status: "error" };
export const agents = signal<AgentsState>({ status: "loading" });

/** GET /api/v1/agents (a real route today). */
export async function loadAgents(): Promise<void> {
  agents.value = { status: "loading" };
  try {
    const r = await getApi().get<AgentsAnswer>(API_ROUTES.agents);
    agents.value = { status: "ready", agents: Array.isArray(r.agents) ? r.agents.map((a) => a.agentId) : [] };
  } catch {
    agents.value = { status: "error" };
  }
}

/** What a failed list or load looks like to the user: the closed set of PageState kinds. */
export function stateFor(e: unknown): "forbidden" | "unavailable" | "error" {
  if (isApiError(e)) {
    if (e.kind === "forbidden") return "forbidden";
    if (e.kind === "unavailable") return "unavailable";
  }
  return "error";
}

/** The hint for a failed submit/create (docs/rpc.md: no-provider = E_NOT_AVAILABLE, turn-in-progress = E_CONFLICT). */
export function submitErrorKey(e: unknown): Key {
  if (isApiError(e)) {
    if (e.kind === "unavailable") return e.reason === "no-provider" ? "chat.err.noProvider" : "chat.err.unavailable";
    if (e.kind === "forbidden") return "chat.err.forbidden";
    if (e.kind === "rpc-error") {
      if (e.errorCode === "E_CONFLICT" && (e.reason === "turn-in-progress" || e.reason === "turn-running")) return "chat.err.busy";
      if (e.errorCode === "E_AGENT_UNKNOWN") return "chat.err.agentUnknown";
    }
  }
  return "chat.err.generic";
}

export function isAborted(e: unknown): boolean { return isApiError(e) && e.kind === "aborted"; }

/** A draft that could not be sent while a new chat was created: the chat page puts it back into the composer. */
let carried: { sessionId: string; text: string; error: Key | null } | null = null;
export function carryDraft(sessionId: string, text: string, error: Key | null): void { carried = { sessionId, text, error }; }
export function takeDraft(sessionId: string): { text: string; error: Key | null } | null {
  const c = carried;
  if (c === null || c.sessionId !== sessionId) return null;
  carried = null;
  return c;
}
