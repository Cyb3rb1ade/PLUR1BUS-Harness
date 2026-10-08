import { randomBytes } from "node:crypto";
import { EmailError } from "./wire.ts";

export interface OutAttachment {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}
export interface BuildInput {
  from: { name?: string; address: string };
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Message-ID without angle brackets. */
  messageId: string;
  /** Epoch milliseconds from the injected clock. */
  date: number;
  inReplyTo?: string;
  references?: readonly string[];
  attachments?: readonly OutAttachment[];
  /** Injected for deterministic boundaries in tests. */
  boundary?: () => string;
}

const CRLF = "\r\n";

/** Refuses CR, LF and NUL in any header value (header injection). */
export function assertHeaderValue(name: string, value: string): string {
  if (/[\r\n\0]/.test(value)) throw new EmailError("protocol", `refusing header ${name} with control characters`);
  return value;
}

/** RFC 2047 B-encoding for non-ASCII text, in words of at most 45 UTF-8 bytes (never splitting a code point). */
export function encodeWords(s: string): string {
  assertHeaderValue("encoded", s);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
      chunk = "";
      bytes = 0;
    }
    chunk += ch;
    bytes += b;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
  return words.join(" ");
}

function formatAddress(a: { name?: string; address: string }): string {
  if (!a.name) return a.address;
  const n = assertHeaderValue("From", a.name);
  if (/^[\x20-\x7e]*$/.test(n) && !/["\\<>()@,;:]/.test(n)) return `${n} <${a.address}>`;
  return `${encodeWords(n)} <${a.address}>`;
}

/** Base64 of `data` in 76-column lines, without a trailing line break. */
export function base64Body(data: Uint8Array): string {
  return Buffer.from(data).toString("base64").replace(/.{1,76}/g, "$&" + CRLF).replace(/\r\n$/, "");
}

/** Safe attachment filename: basename only, anything outside a conservative set replaced, 100 characters at most. */
export function sanitizeFilename(name: string | undefined): string {
  const base = (name ?? "").trim().split(/[\\/]/).pop()?.trim() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 100);
  return cleaned || "attachment";
}

/** One MIME entity: its header lines, a blank line, then its body. No trailing CRLF. */
function entity(headers: readonly string[], body: string): string {
  return [...headers, "", body].join(CRLF);
}

function textEntity(subtype: "plain" | "html", text: string): string {
  return entity(
    [`Content-Type: text/${subtype}; charset=utf-8`, "Content-Transfer-Encoding: base64"],
    base64Body(Buffer.from(text, "utf8")),
  );
}

export function buildMessage(input: BuildInput): Buffer {
  if (/[\r\n]/.test(input.from.address) || !input.from.address.includes("@"))
    throw new EmailError("protocol", "invalid sender address");
  const newBoundary = input.boundary ?? (() => `b${randomBytes(12).toString("hex")}`);

  // Primary body: text/plain alone, or multipart/alternative with HTML.
  let primary: string;
  if (input.html !== undefined) {
    const alt = newBoundary();
    primary = entity(
      [`Content-Type: multipart/alternative; boundary="${alt}"`],
      [
        `--${alt}`,
        textEntity("plain", input.text),
        `--${alt}`,
        textEntity("html", input.html),
        `--${alt}--`,
      ].join(CRLF),
    );
  } else {
    primary = textEntity("plain", input.text);
  }

  const atts = input.attachments ?? [];
  let top = primary;
  if (atts.length > 0) {
    const mixed = newBoundary();
    const parts = [`--${mixed}`, primary];
    for (const a of atts) {
      const name = sanitizeFilename(a.filename);
      const type = assertHeaderValue("Content-Type", a.mimeType).replace(/[^A-Za-z0-9.+/-]/g, "");
      if (!type.includes("/")) throw new EmailError("protocol", "invalid attachment type");
      parts.push(
        `--${mixed}`,
        entity(
          [
            `Content-Type: ${type}; name="${name}"`,
            `Content-Disposition: attachment; filename="${name}"`,
            "Content-Transfer-Encoding: base64",
          ],
          base64Body(a.data),
        ),
      );
    }
    parts.push(`--${mixed}--`);
    top = entity([`Content-Type: multipart/mixed; boundary="${mixed}"`], parts.join(CRLF));
  }

  const headers: string[] = [
    `From: ${formatAddress(input.from)}`,
    `To: ${assertHeaderValue("To", input.to)}`,
    `Subject: ${encodeWords(input.subject)}`,
    `Date: ${new Date(input.date).toUTCString()}`,
    `Message-ID: <${assertHeaderValue("Message-ID", input.messageId)}>`,
    "MIME-Version: 1.0",
    // RFC 3834: an automatic reply to a human's message is marked auto-replied. No Precedence header is set.
    "Auto-Submitted: auto-replied",
  ];
  if (input.inReplyTo) headers.push(`In-Reply-To: <${assertHeaderValue("In-Reply-To", input.inReplyTo)}>`);
  if (input.references?.length)
    headers.push(`References: ${input.references.map((r) => `<${assertHeaderValue("References", r)}>`).join(" ")}`);
  return Buffer.from(`${headers.join(CRLF)}${CRLF}${top}${CRLF}`, "utf8");
}
