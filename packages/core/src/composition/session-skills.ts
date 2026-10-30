// N-C4/D1: reconstruct only completed, owned skill selections and successful load envelopes for session continuity.
import type { ChatRequest } from "../session/provider.ts";
import type { SessionStore } from "../session/store.ts";
import { MAX_SKILL_FILE_BYTES } from "../toolcall/skill-tools.ts";

export interface RestoredSessionSkills {
  selected: readonly string[];
  /** name is the skill name for current-authority filtering; text retains the original result envelope bytes. */
  loaded: readonly { id: string; name: string; text: string; turnId?: string }[];
}

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SKILL_ID = /^skill:[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_RESULT_BYTES = 512 * 1024;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function successfulBody(output: unknown, name: string): output is string {
  if (typeof output !== "string" || Buffer.byteLength(output) > MAX_RESULT_BYTES) return false;
  let result: Record<string, unknown> | undefined;
  try { result = object(JSON.parse(output)); } catch { return false; }
  if (!result || result.isError !== false || (result.truncated !== undefined && result.truncated !== false)) return false;
  if (result.tool !== undefined && result.tool !== "skill.load") return false;
  const value = object(result.value);
  return value?.name === name && typeof value.text === "string" && Buffer.byteLength(value.text) <= MAX_SKILL_FILE_BYTES
    && Array.isArray(value.files) && value.files.length <= 1024
    && value.files.every(file => typeof file === "string" && Buffer.byteLength(file) <= 16 * 1024);
}

/** The caller must re-filter returned names against the turn's current authorized capability view before rendering. */
export function restoreSessionSkills(
  store: SessionStore,
  req: Pick<ChatRequest, "sessionId" | "agentId" | "principal">,
): RestoredSessionSkills {
  const session = store.getSession(req.sessionId);
  if (!req.principal || session?.agentId !== req.agentId || session.owner !== req.principal) {
    return { selected: [], loaded: [] };
  }
  const calls = new Map<string, { id: string; name: string }>();
  const loaded = new Map<string, { id: string; name: string; text: string; turnId?: string }>();
  let selected: string[] = [];
  for (const event of store.skillEvents(session.id)) {
    if (event.type === "skills.selected") {
      const skills = Array.isArray(event.data.skills) ? event.data.skills : [];
      selected = [...new Set(skills.map(skill => object(skill)?.id)
        .filter((id): id is string => typeof id === "string" && SKILL_ID.test(id)))];
      continue;
    }
    const id = event.data.id;
    if (!event.turnId || typeof id !== "string" || !id || id.length > 256) continue;
    const key = JSON.stringify([event.turnId, id]);
    const name = object(event.data.args)?.name;
    if (event.type === "tool.call" && event.data.name === "skill.load"
      && typeof name === "string" && SKILL_NAME.test(name)) calls.set(key, { id, name });
    const call = calls.get(key);
    if (event.type !== "tool.result" || !call || event.data.isError === true) continue;
    if (successfulBody(event.data.output, call.name)) {
      loaded.set(call.name, { id: call.id, name: call.name, text: event.data.output, turnId: event.turnId });
    }
  }
  return { selected, loaded: [...loaded.values()] };
}
