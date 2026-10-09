import type { IdentityService } from "../../core/src/identity/service.ts";
import type { OutputPort } from "./outputs.ts";
import type { ChannelLogger, SecretReader, SeenStore } from "./port.ts";
import type { SocketFactory } from "./socket.ts";

export type ReplyPolicy = "mention" | "always" | "allowlist";

/** JSON-serialisable config. Secrets are referenced by NAME only. */
export interface SlackConfig {
  enabled?: boolean;
  botTokenSecret: string;
  appTokenSecret: string;
  teamId?: string;
  /** Channel / group / DM conversation ids that may talk to the bot. Empty allows nobody. */
  allowlist: string[];
  /** Slack user ids that may DM the bot. Empty means no DMs (unless the DM channel itself is allowlisted). */
  dmAllowlist: string[];
  /** If present: only these users are heard in groups (see replyPolicy for the addressed exception). */
  userAllowlist?: string[];
  replyPolicy?: ReplyPolicy;
  maxMediaBytes?: number;
  locale?: "en" | "de";
}

/** Non-JSON seams. Never derive these from inbound input. */
export interface SlackDeps {
  secrets: SecretReader;
  /** Host pairing port. Without it `/plur1bus link` is not offered. */
  pairing?: Pick<IdentityService, "claim">;
  outputs?: OutputPort;
  /** Durable dedupe of handled event ids. Corrupt state fails start closed. */
  seen?: SeenStore;
  logger?: ChannelLogger;
  fetch?: typeof fetch;
  /** Socket factory; defaults to the global WebSocket client. */
  webSocket?: SocketFactory;
  baseUrl?: string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export const DEFAULT_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const CHANNEL_ID = /^[CDGW][A-Z0-9]{2,31}$/;
const USER_ID = /^[UW][A-Z0-9]{2,31}$/;
const TEAM_ID = /^T[A-Z0-9]{2,31}$/;

export interface ResolvedConfig {
  botTokenSecret: string;
  appTokenSecret: string;
  teamId?: string;
  allow: ReadonlySet<string>;
  dm: ReadonlySet<string>;
  users?: ReadonlySet<string>;
  policy: ReplyPolicy;
  maxMediaBytes: number;
  locale: "en" | "de";
}

function secretName(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(v) || /^(xox[a-z]-|xapp-)/i.test(v))
    throw new RangeError(`${field} must be a secret name, not a credential`);
  return v;
}
function ids(v: readonly string[] | undefined, re: RegExp, field: string): Set<string> {
  if (v === undefined) return new Set();
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !re.test(x)))
    throw new RangeError(`${field} entries must be Slack ids`);
  return new Set(v);
}

export function resolveConfig(o: SlackConfig): ResolvedConfig {
  const max = o.maxMediaBytes ?? DEFAULT_MEDIA_BYTES;
  if (!Number.isSafeInteger(max) || max < 1 || max > MAX_MEDIA_BYTES) throw new RangeError("maxMediaBytes must be 1..25 MiB");
  if (o.teamId !== undefined && !TEAM_ID.test(o.teamId)) throw new RangeError("teamId must be a Slack team id");
  const policy = o.replyPolicy ?? "mention";
  if (!["mention", "always", "allowlist"].includes(policy)) throw new RangeError("invalid replyPolicy");
  const locale = o.locale ?? "en";
  if (locale !== "en" && locale !== "de") throw new RangeError("invalid locale");
  return {
    botTokenSecret: secretName(o.botTokenSecret, "botTokenSecret"),
    appTokenSecret: secretName(o.appTokenSecret, "appTokenSecret"),
    ...(o.teamId !== undefined ? { teamId: o.teamId } : {}),
    allow: ids(o.allowlist, CHANNEL_ID, "allowlist"),
    dm: ids(o.dmAllowlist, USER_ID, "dmAllowlist"),
    ...(o.userAllowlist !== undefined ? { users: ids(o.userAllowlist, USER_ID, "userAllowlist") } : {}),
    policy,
    maxMediaBytes: max,
    locale,
  };
}
