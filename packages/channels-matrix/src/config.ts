import { validateHomeserverUrl } from "./api.ts";
import { isRoomId, isUserId } from "./events.ts";
import type { Locale } from "./messages.ts";

export type ReplyPolicy = "mention" | "always" | "allowlist";

/** JSON-serialisable configuration (secret NAMES only). Mirrored in config.schema.json by the lead. */
export interface MatrixConfig {
  enabled?: boolean;
  homeserverUrl: string;
  /** The bot's own mxid, e.g. `@bot:example.org`. Checked against `whoami` at start. */
  userId: string;
  /** Name of the secret that holds the access token. The token itself never appears in config. */
  accessTokenSecret: string;
  /** Optional device id; if set it must match `whoami`. */
  deviceId?: string;
  autoJoin?: "allowlist" | "never";
  /** Room ids that may talk to the bot. Empty = nobody, inbound and outbound. */
  allowlist: readonly string[];
  /** Sender mxids that may DM the bot. Empty = no DMs. */
  dmAllowlist: readonly string[];
  /** If present, only these senders are heard in groups. Required when `replyPolicy` is `allowlist`. */
  userAllowlist?: readonly string[];
  replyPolicy?: ReplyPolicy;
  maxMediaBytes?: number;
  locale?: Locale;
}

export const DEFAULT_MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const HARD_MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export interface ResolvedConfig {
  homeserverUrl: string;
  userId: string;
  accessTokenSecret: string;
  deviceId: string | undefined;
  autoJoin: "allowlist" | "never";
  allow: ReadonlySet<string>;
  dmAllow: ReadonlySet<string>;
  users: ReadonlySet<string> | undefined;
  replyPolicy: ReplyPolicy;
  maxMediaBytes: number;
  locale: Locale;
}

const SECRET_NAME = /^[A-Za-z0-9_./-]{1,200}$/;

export function resolveConfig(cfg: MatrixConfig): ResolvedConfig {
  if (typeof cfg !== "object" || cfg === null) throw new TypeError("matrix config must be an object");
  const homeserverUrl = validateHomeserverUrl(cfg.homeserverUrl);
  if (!isUserId(cfg.userId) || cfg.userId.length > 255) throw new RangeError("userId must be a full mxid");
  if (typeof cfg.accessTokenSecret !== "string" || !SECRET_NAME.test(cfg.accessTokenSecret))
    throw new RangeError("accessTokenSecret must be a secret name");
  if (cfg.deviceId !== undefined && !/^[A-Za-z0-9._-]{1,255}$/.test(cfg.deviceId))
    throw new RangeError("deviceId has an invalid shape");
  const autoJoin = cfg.autoJoin ?? "allowlist";
  if (autoJoin !== "allowlist" && autoJoin !== "never") throw new RangeError("autoJoin must be allowlist or never");
  for (const r of cfg.allowlist) if (!isRoomId(r)) throw new RangeError("allowlist entries must be room ids");
  for (const u of cfg.dmAllowlist) if (!isUserId(u)) throw new RangeError("dmAllowlist entries must be mxids");
  if (cfg.userAllowlist) for (const u of cfg.userAllowlist) if (!isUserId(u)) throw new RangeError("userAllowlist entries must be mxids");
  const replyPolicy = cfg.replyPolicy ?? "mention";
  if (!["mention", "always", "allowlist"].includes(replyPolicy)) throw new RangeError("invalid replyPolicy");
  if (replyPolicy === "allowlist" && cfg.userAllowlist === undefined)
    throw new RangeError("replyPolicy allowlist requires userAllowlist");
  const maxMediaBytes = cfg.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  if (!Number.isSafeInteger(maxMediaBytes) || maxMediaBytes < 1 || maxMediaBytes > HARD_MAX_MEDIA_BYTES)
    throw new RangeError("maxMediaBytes must be 1 byte .. 25 MiB");
  const locale = cfg.locale ?? "en";
  if (locale !== "en" && locale !== "de") throw new RangeError("locale must be en or de");
  return {
    homeserverUrl,
    userId: cfg.userId,
    accessTokenSecret: cfg.accessTokenSecret,
    deviceId: cfg.deviceId,
    autoJoin,
    allow: new Set(cfg.allowlist),
    dmAllow: new Set(cfg.dmAllowlist),
    users: cfg.userAllowlist ? new Set(cfg.userAllowlist) : undefined,
    replyPolicy,
    maxMediaBytes,
    locale,
  };
}
