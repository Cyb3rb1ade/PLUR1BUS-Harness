import type { Locale } from "./messages.ts";
import { SENDER_ENTRY } from "./policy.ts";

/** Secret NAMES only. Passwords are read through SecretReader. JSON-serialisable. */
export interface EmailServerConfig {
  host: string;
  port: number;
  security: "tls" | "starttls";
  user: string;
  passwordSecret: string;
}
export interface EmailImapConfig extends EmailServerConfig {
  folder?: string;
  idle?: boolean;
  pollIntervalSec?: number;
}
export interface EmailConfig {
  enabled?: boolean;
  /** The bot's own mailbox address. Also used as the stable accountId for /link. */
  address: string;
  displayName?: string;
  imap: EmailImapConfig;
  smtp: EmailServerConfig;
  /** Permitted sender addresses: `a@b.c` (exact) or `*@b.c` (domain). Empty = nobody. */
  dmAllowlist: string[];
  /** Unused by email (every mail is direct). Accepted so the common schema shape validates. */
  allowlist?: string[];
  replyPolicy?: "mention" | "always" | "allowlist";
  /** Attachment size limit (inbound and outbound). Default 10 MiB, hard maximum 25 MiB. */
  maxAttachmentBytes?: number;
  /** Drop mail unless the trusted Authentication-Results shows dmarc=pass (alignment included). Default false. */
  requireAuthPass?: boolean;
  /**
   * authserv-id of the MTA that delivers into the bot's mailbox. Only its Authentication-Results headers are read.
   * Unset = every auth result is "none" (fail closed).
   */
  authServId?: string;
  /** Approver addresses per prompt come from the prompt itself; this is only the default for logs and text. */
  locale?: Locale;
}

export interface NormalizedConfig {
  address: string;
  displayName: string | undefined;
  imap: { host: string; port: number; security: "tls" | "starttls"; user: string; passwordSecret: string; folder: string; idle: boolean; pollIntervalSec: number };
  smtp: { host: string; port: number; security: "tls" | "starttls"; user: string; passwordSecret: string };
  dmAllowlist: string[];
  maxAttachmentBytes: number;
  requireAuthPass: boolean;
  authServId: string | undefined;
  locale: Locale;
}

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
export const ADDRESS = /^[^\s@*"<>,;()\\]+@[a-z0-9.-]+\.[a-z0-9-]+$/i;
const PLAIN = /^[^\0\r\n]{1,256}$/;
const SECRET_NAME = /^[A-Za-z0-9_.:/-]{1,200}$/;
const MAX_ATTACHMENT = 25 * 1024 * 1024;

function server(name: string, s: EmailServerConfig): void {
  if (!s || typeof s !== "object") throw new RangeError(`${name} is required`);
  if (!HOST.test(s.host)) throw new RangeError(`${name}.host is invalid`);
  if (!Number.isSafeInteger(s.port) || s.port < 1 || s.port > 65535) throw new RangeError(`${name}.port is invalid`);
  if (s.security !== "tls" && s.security !== "starttls") throw new RangeError(`${name}.security must be tls or starttls`);
  if (!PLAIN.test(s.user)) throw new RangeError(`${name}.user is invalid`);
  if (!SECRET_NAME.test(s.passwordSecret)) throw new RangeError(`${name}.passwordSecret must be a secret name`);
}

/** Validates and applies defaults. Throws RangeError with fixed text; never echoes the rejected value. */
export function normalizeConfig(c: EmailConfig): NormalizedConfig {
  const address = c.address?.toLowerCase();
  if (typeof address !== "string" || !ADDRESS.test(address)) throw new RangeError("address is invalid");
  server("imap", c.imap);
  server("smtp", c.smtp);
  const folder = c.imap.folder ?? "INBOX";
  if (!PLAIN.test(folder) || folder.length > 255) throw new RangeError("imap.folder is invalid");
  const poll = c.imap.pollIntervalSec ?? 60;
  if (!Number.isSafeInteger(poll) || poll < 10 || poll > 3600) throw new RangeError("imap.pollIntervalSec must be 10..3600");
  if (c.imap.idle !== undefined && typeof c.imap.idle !== "boolean") throw new RangeError("imap.idle must be boolean");
  if (!Array.isArray(c.dmAllowlist)) throw new RangeError("dmAllowlist must be an array");
  const dm = c.dmAllowlist.map((e) => {
    if (typeof e !== "string" || !SENDER_ENTRY.test(e.toLowerCase())) throw new RangeError("dmAllowlist entry is invalid");
    return e.toLowerCase();
  });
  const max = c.maxAttachmentBytes ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max < 1 || max > MAX_ATTACHMENT) throw new RangeError("maxAttachmentBytes must be 1..25 MiB");
  if (c.requireAuthPass !== undefined && typeof c.requireAuthPass !== "boolean") throw new RangeError("requireAuthPass must be boolean");
  if (c.authServId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(c.authServId))
    throw new RangeError("authServId is invalid");
  const locale = c.locale ?? "en";
  if (locale !== "en" && locale !== "de") throw new RangeError("locale must be en or de");
  if (c.displayName !== undefined && (!PLAIN.test(c.displayName) || c.displayName.length > 200))
    throw new RangeError("displayName is invalid");
  return {
    address,
    displayName: c.displayName,
    imap: {
      host: c.imap.host,
      port: c.imap.port,
      security: c.imap.security,
      user: c.imap.user,
      passwordSecret: c.imap.passwordSecret,
      folder,
      idle: c.imap.idle ?? true,
      pollIntervalSec: poll,
    },
    smtp: { host: c.smtp.host, port: c.smtp.port, security: c.smtp.security, user: c.smtp.user, passwordSecret: c.smtp.passwordSecret },
    dmAllowlist: dm,
    maxAttachmentBytes: max,
    requireAuthPass: c.requireAuthPass ?? false,
    authServId: c.authServId,
    locale,
  };
}
