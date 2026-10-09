import { randomInt } from "node:crypto";
import type { ParsedMessage } from "./mime-parse.ts";

export interface AuthResults {
  spf: string;
  dkim: string;
  dmarc: string;
}
export const NO_AUTH: AuthResults = { spf: "none", dkim: "none", dmarc: "none" };

/** Sender entries: `user@domain` (exact) or `*@domain` (any address on exactly that domain). Lower-cased. */
export const SENDER_ENTRY = /^(\*@[a-z0-9.-]+\.[a-z0-9-]+|[^\s@*"<>,;]+@[a-z0-9.-]+\.[a-z0-9-]+)$/;

export function senderMatches(entries: readonly string[], address: string): boolean {
  const a = address.toLowerCase();
  const domain = a.slice(a.lastIndexOf("@") + 1);
  return entries.some((raw) => {
    const e = raw.toLowerCase();
    if (e.startsWith("*@")) return domain === e.slice(2);
    return a === e;
  });
}

/** Loop prevention (RFC 3834 and common practice). Returns a content-free reason, or undefined when the mail may be handled. */
export function loopReason(m: ParsedMessage, ownAddress: string): string | undefined {
  const h = m.headers;
  if (m.isReport) return "report";
  const auto = h.get("auto-submitted");
  if (auto !== undefined && auto.trim().toLowerCase() !== "no") return "auto-submitted";
  const prec = h.get("precedence")?.trim().toLowerCase();
  if (prec === "bulk" || prec === "junk" || prec === "list") return "precedence";
  if (h.has("x-auto-response-suppress")) return "auto-response-suppress";
  if (h.has("x-autoreply") || h.has("x-autorespond")) return "autoreply";
  if (h.has("list-id") || h.has("list-unsubscribe")) return "list";
  if (m.returnPath !== undefined && /^<?\s*>?$/.test(m.returnPath.trim())) return "null-sender";
  const from = m.from?.address;
  if (!from) return "no-from";
  if (from === ownAddress.toLowerCase()) return "self";
  const local = from.slice(0, from.lastIndexOf("@"));
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)$/.test(local)) return "system-sender";
  return undefined;
}

/** Removes RFC 5322 comments (nesting-aware, backslash escapes) and replaces quoted strings with "" so that no `;`,
 *  `=` or `(` inside them can be mistaken for structure. */
export function stripCfws(v: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === "\\") {
      if (depth > 0 || quoted) i++;
      else {
        out += c + (v[i + 1] ?? "");
        i++;
      }
      continue;
    }
    if (depth > 0) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      continue;
    }
    if (quoted) {
      if (c === '"') {
        quoted = false;
        out += '""';
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "(") depth = 1;
    else out += c;
  }
  return out;
}

/**
 * Reads the Authentication-Results header added by the MTA that delivered into the bot's mailbox (`authServId`).
 * Only headers whose authserv-id matches are considered; the topmost one is used. Each resinfo contributes only its
 * leading `method=result`; nothing after it is scanned. Without a configured authserv-id, or without a matching header,
 * every result is "none" (fail closed). Information only: no signature is verified here.
 */
export function parseAuthResults(headers: readonly string[], authServId: string | undefined): AuthResults {
  const out: AuthResults = { ...NO_AUTH };
  if (!authServId) return out;
  const want = authServId.toLowerCase();
  const header = headers.find((h) => {
    const id = stripCfws(h).split(";")[0]!.trim().split(/\s+/)[0] ?? "";
    return id.toLowerCase() === want;
  });
  if (header === undefined) return out;
  const [, ...resinfos] = stripCfws(header).split(";");
  for (const r of resinfos) {
    const m = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)\b/i.exec(r);
    if (!m) continue;
    const k = m[1]!.toLowerCase() as keyof AuthResults;
    if (out[k] === "none") out[k] = m[2]!.toLowerCase();
  }
  return out;
}

/**
 * The auth policy used by `requireAuthPass` and by approval replies: DMARC pass only. DMARC already encodes
 * identifier alignment with the From domain. An SPF+DKIM fallback would accept any sender's own valid SPF and DKIM
 * results, since neither is checked against From, so it is not offered.
 */
export function authPasses(a: AuthResults): boolean {
  return a.dmarc === "pass";
}

const SAFE_MIME = /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|wav|x-wav|flac|aac)|application\/(pdf|octet-stream|zip|json)|text\/plain)$/;
export function safeMime(mime: string): boolean {
  return SAFE_MIME.test(mime.toLowerCase());
}
export function attachmentKind(mime: string): "image" | "audio" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

/** Removes quoted history and a trailing signature, conservatively: `> ` lines, a "wrote:" / "schrieb:" attribution
 *  line and everything after it, the "-- " signature delimiter and everything after it. */
export function stripQuotedText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l === "-- " || l === "--") break;
    if (/^On .{1,250}wrote:\s*$/.test(l) || /^Am .{1,250}schrieb .{0,250}:\s*$/.test(l)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}\s*$/i.test(l) || /^-{2,}\s*Ursprüngliche Nachricht\s*-{2,}\s*$/i.test(l)) break;
    if (/^\s*>/.test(l)) continue;
    kept.push(l);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

/** Crockford base32 without I, L, O, U. Single-use approval codes are 8 of these, shown as XXXX-XXXX. */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newApprovalCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const CODE_BODY = "[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}";
/** `XXXX-XXXX 2` (dash optional) as the first line of a reply. Returns the canonical code and choice number. */
export function parseApprovalReply(line: string): { code: string; choice: number } | undefined {
  const m = new RegExp(`^(${CODE_BODY})\\s+([1-9])\\s*$`, "i").exec(line.trim());
  if (!m) return undefined;
  const raw = m[1]!.toUpperCase().replace("-", "");
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, choice: Number(m[2]) };
}
/** `link <code>` or `/link <code>` on its own line. */
export function parseLinkCommand(line: string): string | undefined {
  const m = /^\/?link\s+([A-Za-z0-9_-]{4,64})\s*$/i.exec(line.trim());
  return m?.[1];
}

/** Sliding-window limiter keyed by string. Bounded number of keys. Injected clock. */
export class SlidingWindow {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, number[]>();
  constructor(max: number, windowMs: number, now: () => number) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }
  take(key: string): boolean {
    const t = this.#now();
    const list = (this.#hits.get(key) ?? []).filter((x) => t - x < this.#windowMs);
    if (list.length >= this.#max) {
      this.#hits.set(key, list);
      return false;
    }
    list.push(t);
    this.#hits.delete(key);
    this.#hits.set(key, list);
    while (this.#hits.size > 2000) this.#hits.delete(this.#hits.keys().next().value!);
    return true;
  }
}
