/** Client-Server API event shapes, reduced to what the channel reads. Everything from the homeserver is untrusted input. */
export interface MatrixEvent {
  type: string;
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  state_key?: string;
  content: Record<string, unknown>;
}

export interface SyncRoom {
  timeline?: { events?: MatrixEvent[] };
  state?: { events?: MatrixEvent[] };
  summary?: { "m.joined_member_count"?: number };
}

export interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, SyncRoom>;
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>;
    leave?: Record<string, unknown>;
  };
  account_data?: { events?: MatrixEvent[] };
}

export const MESSAGE_TYPES = ["m.text", "m.notice", "m.emote", "m.image", "m.file", "m.audio", "m.video"] as const;

export const SYNC_FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: ["m.direct"] },
  room: {
    ephemeral: { types: [] },
    account_data: { types: [] },
    state: { types: ["m.room.encryption"] },
    timeline: { types: ["m.room.message", "m.reaction", "m.room.encrypted"], limit: 50 },
  },
});

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function relates(content: Record<string, unknown>): Record<string, unknown> | undefined {
  return isObj(content["m.relates_to"]) ? content["m.relates_to"] : undefined;
}

/** Thread root, when the event is part of an `m.thread` (fallback reply metadata is not a thread link). */
export function threadRoot(content: Record<string, unknown>): string | undefined {
  const r = relates(content);
  return r?.rel_type === "m.thread" && isEventId(r.event_id) ? r.event_id : undefined;
}

/** Event id this event replies to. Thread fallbacks (`is_falling_back: true`) are not replies. */
export function replyTarget(content: Record<string, unknown>): string | undefined {
  const r = relates(content);
  if (!r) return undefined;
  if (r.rel_type === "m.thread" && r.is_falling_back !== false) return undefined;
  const reply = isObj(r["m.in_reply_to"]) ? r["m.in_reply_to"] : undefined;
  return isEventId(reply?.event_id) ? (reply!.event_id as string) : undefined;
}

export const isEventId = (v: unknown): v is string => typeof v === "string" && /^\$[^\s:]{1,255}$/.test(v);
export const isRoomId = (v: unknown): v is string => typeof v === "string" && /^![^\s:]{1,255}:[^\s]{1,255}$/.test(v);
export const isUserId = (v: unknown): v is string => typeof v === "string" && /^@[^\s:]{1,255}:[^\s]{1,255}$/.test(v);

/** Removes the legacy reply fallback (`> <@user:server> quoted` lines) when the event carries an mx-reply HTML body. */
export function stripReplyFallback(body: string, content: Record<string, unknown>): string {
  const formatted = typeof content.formatted_body === "string" ? content.formatted_body : "";
  if (!formatted.includes("mx-reply")) return body;
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i]!.startsWith(">") || lines[i] === "")) {
    if (lines[i]!.startsWith(">")) {
      i++;
      continue;
    }
    // A blank line separates the fallback quote from the reply text.
    if (i > 0) i++;
    break;
  }
  return lines.slice(i).join("\n");
}

/**
 * Whether the bot is addressed. `m.mentions` is authoritative when present; the body fallback (mxid, `@localpart`,
 * display name at a word boundary) applies only to legacy events without `m.mentions`.
 */
export function mentionsBot(
  content: Record<string, unknown>,
  body: string,
  bot: { userId: string; displayName?: string | undefined },
): boolean {
  const m = content["m.mentions"];
  if (isObj(m)) return Array.isArray(m.user_ids) && m.user_ids.includes(bot.userId);
  const localpart = bot.userId.slice(1).split(":")[0] ?? "";
  const needles = [bot.userId, `@${localpart}`];
  if (bot.displayName && bot.displayName.length >= 2) needles.push(bot.displayName);
  return needles.some((n) => boundaryMatch(body, n));
}

function boundaryMatch(text: string, needle: string): boolean {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, "i").test(text);
}

/** Thread-aware chat ids: `<roomId>` or `<roomId>:<threadRootEventId>`. The room id itself contains a colon. */
export function formatChatId(roomId: string, thread?: string): string {
  return thread === undefined ? roomId : `${roomId}:${thread}`;
}

export function parseChatId(chatId: string): { roomId: string; thread?: string } {
  const at = chatId.lastIndexOf(":$");
  if (at < 0) {
    if (!isRoomId(chatId)) throw new Error("invalid matrix conversation id");
    return { roomId: chatId };
  }
  const roomId = chatId.slice(0, at);
  const thread = chatId.slice(at + 1);
  if (!isRoomId(roomId) || !isEventId(thread)) throw new Error("invalid matrix conversation id");
  return { roomId, thread };
}

/** `@localpart` / mxid normalisation for allowlist comparisons. Matrix ids are case-sensitive for the localpart. */
export function sameUser(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a === b;
}
