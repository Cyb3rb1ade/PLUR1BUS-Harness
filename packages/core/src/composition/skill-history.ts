/** Restore authorized skill bodies at their original user turn, below the system zone and without reloading. */
import { createHash } from "node:crypto";
import type { ChatMessage } from "../../../providers/src/index.ts";
import type { ChatRequest } from "../session/provider.ts";
import type { RestoredSessionSkills } from "./session-skills.ts";

/** Original call/result bytes stay together; duplicate IDs from separate turns get deterministic replay IDs. */
export function skillHistoryMessages(req: ChatRequest, loaded: RestoredSessionSkills["loaded"]): ChatMessage[] {
  const pending = loaded.filter(load => !req.peerResults?.some(peer =>
    peer.name === "skill.load" && peer.id === load.id && peer.text === load.text));
  const users = req.messages.flatMap((message, index) => message.role === "user" ? [index] : []);
  const fallback = users.at(-2) ?? users.at(-1) ?? -1;
  const used = new Set(req.peerResults?.map(peer => peer.id) ?? []);
  const result: ChatMessage[] = [];
  for (const [index, message] of req.messages.entries()) {
    result.push({ role: message.role === "tool" ? "user" : message.role, content: message.text });
    for (const load of pending) {
      const anchor = load.turnId === undefined ? -1 : req.messages.findIndex(item =>
        item.role === "user" && item.turnId === load.turnId);
      if (index !== (anchor >= 0 ? anchor : fallback)) continue;
      const suffix = createHash("sha256").update(JSON.stringify([load.turnId, load.name, load.id])).digest("hex");
      let id = load.id;
      if (used.has(id)) id = `skill-replay-${suffix}`;
      used.add(id);
      result.push({ role: "assistant", content: null,
        toolCalls: [{ id, name: "skill.load", arguments: JSON.stringify({ name: load.name }) }] });
      result.push({ role: "tool", toolCallId: id, content: load.text });
    }
  }
  return result;
}
