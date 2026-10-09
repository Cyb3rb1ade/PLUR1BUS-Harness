import type { IdentityService } from "../../core/src/identity/service.ts";
import { resolveIntents } from "./intents.ts";
import type { Locale } from "./messages.ts";
import type { ChannelLogger, GatewayStateStore, SecretReader, WebSocketFactory } from "./port.ts";
import type { OutputPort } from "./outputs.ts";
import type { Sleep } from "./rate-limit.ts";

export const DISCORD_MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MEDIA_BYTES = 10 * 1024 * 1024;
export const SNOWFLAKE = /^\d{5,20}$/;

export type ReplyPolicy = "mention" | "always" | "allowlist";

/** JSON-serialisable configuration. Secret NAMES only; the bot token is read through `SecretReader`. */
export interface DiscordConfig {
  enabled?: boolean;
  tokenSecret: string;
  applicationId?: string;
  intents?: readonly string[] | number;
  allowlist: readonly string[];
  dmAllowlist: readonly string[];
  userAllowlist?: readonly string[];
  replyPolicy?: ReplyPolicy;
  maxMediaBytes?: number;
  locale?: Locale;
}

/** Non-JSON seams and host bindings. */
export interface DiscordDeps {
  secrets: SecretReader;
  pairing?: Pick<IdentityService, "claim">;
  outputs?: OutputPort;
  stateStore?: GatewayStateStore;
  logger?: ChannelLogger;
  baseUrl?: string;
  gatewayUrl?: string;
  cdnHosts?: readonly string[];
  fetch?: typeof fetch;
  webSocket?: WebSocketFactory;
  sleep?: Sleep;
  now?: () => number;
  random?: () => number;
}

export type DiscordChannelOptions = DiscordConfig & DiscordDeps;

export interface ParsedConfig {
  tokenSecret: string;
  applicationId: string | undefined;
  intents: number;
  allowlist: ReadonlySet<string>;
  dmAllowlist: ReadonlySet<string>;
  userAllowlist: ReadonlySet<string> | undefined;
  replyPolicy: ReplyPolicy;
  maxMediaBytes: number;
  locale: Locale;
}

const KEYS = new Set([
  "enabled", "tokenSecret", "applicationId", "intents", "allowlist", "dmAllowlist", "userAllowlist",
  "replyPolicy", "maxMediaBytes", "locale",
]);
const DEP_KEYS = new Set([
  "secrets", "pairing", "outputs", "stateStore", "logger", "baseUrl", "gatewayUrl", "cdnHosts", "fetch",
  "webSocket", "sleep", "now", "random",
]);

/** Splits merged channel options into the JSON config and checks that every key belongs to one of the two groups. */
export function splitOptions(opts: Record<string, unknown>): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (DEP_KEYS.has(k)) continue;
    if (!KEYS.has(k)) throw new RangeError(`unknown discord option ${JSON.stringify(k.slice(0, 40))}`);
    cfg[k] = v;
  }
  return cfg;
}

function ids(v: unknown, field: string): ReadonlySet<string> {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !SNOWFLAKE.test(x)))
    throw new RangeError(`${field} must be an array of Discord snowflake ids`);
  return new Set(v as string[]);
}

/** Validates the JSON config closed-world: unknown keys, bad ids and out-of-range limits are refused before anything runs. */
export function parseConfig(cfg: Record<string, unknown>): ParsedConfig {
  for (const k of Object.keys(cfg)) if (!KEYS.has(k)) throw new RangeError(`unknown discord config key ${JSON.stringify(k.slice(0, 40))}`);
  if (typeof cfg.tokenSecret !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(cfg.tokenSecret))
    throw new RangeError("tokenSecret must be a secret name");
  const applicationId = cfg.applicationId;
  if (applicationId !== undefined && (typeof applicationId !== "string" || !SNOWFLAKE.test(applicationId)))
    throw new RangeError("applicationId must be a snowflake id");
  const replyPolicy = cfg.replyPolicy ?? "mention";
  if (!["mention", "always", "allowlist"].includes(replyPolicy as string)) throw new RangeError("replyPolicy is invalid");
  const locale = cfg.locale ?? "en";
  if (!["en", "de"].includes(locale as string)) throw new RangeError("locale is invalid");
  const max = cfg.maxMediaBytes ?? DEFAULT_MEDIA_BYTES;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1 || max > DISCORD_MAX_MEDIA_BYTES)
    throw new RangeError("maxMediaBytes must be 1 byte .. 25 MiB");
  const intents = cfg.intents;
  if (intents !== undefined && typeof intents !== "number" && !Array.isArray(intents))
    throw new RangeError("intents must be a list of names or a bitfield");
  return {
    tokenSecret: cfg.tokenSecret,
    applicationId: applicationId as string | undefined,
    intents: resolveIntents(intents as readonly string[] | number | undefined),
    allowlist: ids(cfg.allowlist ?? [], "allowlist"),
    dmAllowlist: ids(cfg.dmAllowlist ?? [], "dmAllowlist"),
    userAllowlist: cfg.userAllowlist === undefined ? undefined : ids(cfg.userAllowlist, "userAllowlist"),
    replyPolicy: replyPolicy as ReplyPolicy,
    maxMediaBytes: max,
    locale: locale as Locale,
  };
}
