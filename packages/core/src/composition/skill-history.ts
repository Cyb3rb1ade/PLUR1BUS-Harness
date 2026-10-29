/** Restore authorized skill bodies at their original user turn, below the system zone and without reloading. */
import { createHash } from "node:crypto";
import type { ChatMessage } from "../../../providers/src/index.ts";
import type { ChatRequest } from "../session/provider.ts";
import type { RestoredSessionSkills } from "./session-skills.ts";

type Load = RestoredSessionSkills["loaded"][number];

/**
 * Original call/result bytes stay together; duplicate IDs from separate turns get deterministic replay IDs.
 * A load that the session's context view already carries (same turn and call ID) is emitted from there, as the call and
 * result pair, and never added a second time: the view has counted that copy. Only loads the request does not carry at all
 * (history a caller built itself) are placed after their original user message.
 */
export function skillHistoryMessages(req: ChatRequest, loaded: RestoredSessionSkills["loaded"]): ChatMessage[] {
  const pending = loaded.filter(load => !req.peerResults?.some(peer =>
    peer.name === "skill.load" && peer.id === load.id && peer.text === load.text));
  const users = req.messages.flatMap((message, index) => message.role === "user" ? [index] : []);
  const fallback = users.at(-2) ?? users.at(-1) ?? -1;
  const used = new Set(req.peerResults?.map(peer => peer.id) ?? []);
  const whole = new Map<number, Load>();
  const loose: Load[] = [];
  for (const load of pending) {
    const at = req.messages.findIndex(item => item.toolCall?.name === "skill.load" && item.toolCall.id === load.id
      && item.turnId === load.turnId);
    if (at < 0) loose.push(load);
    // A clipped carrier stays the view's own text: still one copy, and exactly the one it counted.
    else if (req.messages[at]!.toolCall!.whole) whole.set(at, load);
  }
  const pair = (load: Load): ChatMessage[] => {
    const suffix = createHash("sha256").update(JSON.stringify([load.turnId, load.name, load.id])).digest("hex");
    let id = load.id;
    if (used.has(id)) id = `skill-replay-${suffix}`;
    used.add(id);
    return [
      { role: "assistant", content: null, toolCalls: [{ id, name: "skill.load", arguments: JSON.stringify({ name: load.name }) }] },
      { role: "tool", toolCallId: id, content: load.text },
    ];
  };
  const result: ChatMessage[] = [];
  for (const [index, message] of req.messages.entries()) {
    const carried = whole.get(index);
    if (carried) result.push(...pair(carried));
    else result.push({ role: message.role === "tool" ? "user" : message.role, content: message.text });
    for (const load of loose) {
      const anchor = load.turnId === undefined ? -1 : req.messages.findIndex(item =>
        item.role === "user" && item.turnId === load.turnId);
      // A covered turn identity is authoritative after compaction; absent anchors must stay omitted.
      if (load.turnId && anchor < 0 && req.messages.some(item => item.turnId !== undefined)) continue;
      if (index !== (anchor >= 0 ? anchor : fallback)) continue;
      result.push(...pair(load));
    }
  }
  return result;
}
