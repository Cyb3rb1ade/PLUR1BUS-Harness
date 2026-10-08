export const DISCORD_INTENTS: Readonly<Record<string, number>> = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MODERATION: 1 << 2,
  GUILD_EXPRESSIONS: 1 << 3,
  GUILD_INTEGRATIONS: 1 << 4,
  GUILD_WEBHOOKS: 1 << 5,
  GUILD_INVITES: 1 << 6,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  /** Privileged: enable "Message Content Intent" in the developer portal, otherwise the gateway closes with 4014. */
  MESSAGE_CONTENT: 1 << 15,
};
export const DEFAULT_INTENT_NAMES = ["GUILDS", "GUILD_MESSAGES", "DIRECT_MESSAGES", "MESSAGE_CONTENT"] as const;

/** Accepts a list of intent names (preferred) or a raw bitfield. Unknown names and out-of-range values are refused. */
export function resolveIntents(v: readonly string[] | number | undefined): number {
  if (v === undefined) v = DEFAULT_INTENT_NAMES;
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 0 || v >= 1 << 26) throw new RangeError("intents must be a valid bitfield");
    return v;
  }
  let bits = 0;
  for (const name of v) {
    const bit = DISCORD_INTENTS[name];
    if (bit === undefined) throw new RangeError(`unknown intent ${JSON.stringify(String(name).slice(0, 40))}`);
    bits |= bit;
  }
  return bits;
}
