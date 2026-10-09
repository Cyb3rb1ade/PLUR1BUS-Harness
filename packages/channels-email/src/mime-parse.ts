import { htmlToText } from "./html-text.ts";

export interface Mailbox {
  name?: string;
  /** lower-cased addr-spec */
  address: string;
}
export interface ParsedAttachment {
  filename?: string;
  mimeType: string;
  data: Uint8Array;
  inline: boolean;
}
export interface ParsedMessage {
  headers: HeaderMap;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  subject: string;
  /** Set only when the From header is unambiguous (exactly one header, one mailbox). */
  from?: Mailbox;
  /** Why `from` is unusable. Callers MUST drop mail when this is set. */
  fromProblem?: FromProblem;
  to: Mailbox[];
  date?: number;
  returnPath?: string;
  text: string;
  /** True when no text/plain part existed and the text came from HTML. */
  fromHtml: boolean;
  attachments: ParsedAttachment[];
  /** Attachments skipped because they exceeded the size limit (count only). */
  skippedAttachments: number;
  /** multipart/report, message/delivery-status or similar machine-generated report. */
  isReport: boolean;
  contentType: string;
}
export interface ParseOptions {
  maxAttachmentBytes?: number;
  maxParts?: number;
  maxDepth?: number;
}

export class HeaderMap {
  readonly #m = new Map<string, string[]>();
  add(name: string, value: string): void {
    const k = name.toLowerCase();
    const l = this.#m.get(k);
    if (l) l.push(value);
    else this.#m.set(k, [value]);
  }
  get(name: string): string | undefined {
    return this.#m.get(name.toLowerCase())?.[0];
  }
  getAll(name: string): string[] {
    return [...(this.#m.get(name.toLowerCase()) ?? [])];
  }
  has(name: string): boolean {
    return this.#m.has(name.toLowerCase());
  }
}

// ---------- low-level decoders ----------

function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? "utf-8").trim().toLowerCase().replace(/^"|"$/g, "") || "utf-8";
  const norm = label === "us-ascii" || label === "ascii" ? "windows-1252" : label;
  try {
    return new TextDecoder(norm).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
/** Header bytes: UTF-8 when valid (8-bit headers per RFC 6532), else Latin-1. */
function decodeHeaderBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export function decodeQuotedPrintable(input: string | Uint8Array): Buffer {
  const s = typeof input === "string" ? input : Buffer.from(input).toString("latin1");
  const out: number[] = [];
  const lines = s.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li]!;
    let soft = false;
    if (line.endsWith("=")) {
      soft = true;
      line = line.slice(0, -1);
    } else line = line.replace(/[ \t]+$/, "");
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 0x3d && /^[0-9A-Fa-f]{2}$/.test(line.slice(i + 1, i + 3))) {
        out.push(parseInt(line.slice(i + 1, i + 3), 16));
        i += 2;
      } else out.push(c & 0xff);
    }
    if (!soft && li < lines.length - 1) out.push(0x0d, 0x0a);
  }
  return Buffer.from(out);
}

function decodeQEncodedWord(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "_") out.push(0x20);
    else if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

/** RFC 2047 encoded-word decoder for unstructured header text. Whitespace between adjacent encoded words is dropped. */
export function decodeEncodedWords(s: string): string {
  const re = /=\?([A-Za-z0-9_\-]+)(?:\*[A-Za-z0-9-]+)?\?([bBqQ])\?([^?\s]*)\?=/g;
  let out = "";
  let last = 0;
  let prevWasWord = false;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const between = s.slice(last, m.index);
    if (!(prevWasWord && /^\s*$/.test(between))) out += between;
    const bytes = m[2]!.toLowerCase() === "b" ? Buffer.from(m[3]!, "base64") : decodeQEncodedWord(m[3]!);
    out += decodeBytes(bytes, m[1]);
    last = m.index + m[0].length;
    prevWasWord = true;
  }
  return out + s.slice(last);
}

// ---------- structured header helpers ----------

export interface ContentType {
  type: string;
  subtype: string;
  params: Record<string, string>;
}
function splitParams(value: string): { main: string; params: Record<string, string> } {
  const parts: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === "\\" && q) {
      cur += value[++i] ?? "";
    } else if (c === '"') {
      q = !q;
      cur += c;
    } else if (c === ";" && !q) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const params: Record<string, string> = {};
  const cont = new Map<string, { n: number; v: string }[]>();
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    let k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    // RFC 2231: name*0*=..., name*1=..., name*=utf-8''...
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(k);
    if (m) {
      k = m[1]!;
      const list = cont.get(k) ?? [];
      list.push({ n: m[2] ? Number(m[2]) : 0, v });
      cont.set(k, list);
    } else params[k] = v;
  }
  for (const [k, list] of cont) {
    list.sort((a, b) => a.n - b.n);
    const joined = list.map((x) => x.v).join("");
    const e = /^([A-Za-z0-9_-]*)'[^']*'(.*)$/.exec(joined);
    if (e) {
      const bytes = Buffer.from(e[2]!.replace(/%([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
      params[k] = decodeBytes(bytes, e[1] || "utf-8");
    } else params[k] = joined;
  }
  return { main: parts[0]!.trim(), params };
}
export function parseContentType(v: string | undefined): ContentType {
  if (!v) return { type: "text", subtype: "plain", params: {} };
  const { main, params } = splitParams(v);
  const [t, st] = main.toLowerCase().split("/");
  if (!t || !st || !/^[a-z0-9.+-]+$/.test(t) || !/^[a-z0-9.+-]+$/.test(st)) return { type: "text", subtype: "plain", params };
  return { type: t, subtype: st, params };
}

/** Extracts `<id>` tokens (without brackets). */
export function parseMessageIds(v: string | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const m of v.matchAll(/<([^<>\s]{1,998})>/g)) out.push(m[1]!);
  return out;
}

const ADDR_SPEC = /^[^\s@<>"(),;:\\\[\]]+@[^\s@<>"(),;:\\\[\]]+$/;

interface ScanItem {
  /** Text outside angle-addrs with comments removed (quoted strings kept verbatim). */
  text: string;
  /** Angle-addrs found OUTSIDE quoted strings and comments. */
  angles: string[];
}
interface Scan {
  items: ScanItem[];
  group: boolean;
  malformed: boolean;
}
/** One-pass tokenizer: tracks quoted strings (with backslash escapes) and nested comments, so `<`, `>`, `,`, `:` and `@`
 *  inside them never count. Nothing here decodes encoded-words: those are display text only and are decoded afterwards. */
function scanAddresses(v: string): Scan {
  const items: ScanItem[] = [];
  let text = "";
  let angles: string[] = [];
  let angleBuf = "";
  let q = false;
  let paren = 0;
  let inAngle = false;
  let group = false;
  let malformed = false;
  const put = (c: string) => {
    if (inAngle) angleBuf += c;
    else text += c;
  };
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (q) {
      if (c === "\\") put(c + (v[++i] ?? ""));
      else {
        if (c === '"') q = false;
        put(c);
      }
      continue;
    }
    if (paren > 0) {
      if (c === "\\") i++;
      else if (c === "(") paren++;
      else if (c === ")") paren--;
      continue;
    }
    if (c === '"') {
      q = true;
      put(c);
    } else if (c === "(") {
      paren = 1;
      if (!inAngle) text += " ";
    } else if (c === "<") {
      if (inAngle) malformed = true;
      inAngle = true;
      angleBuf = "";
    } else if (c === ">") {
      if (!inAngle) malformed = true;
      else {
        angles.push(angleBuf.trim());
        inAngle = false;
        text += " ";
      }
    } else if (inAngle) angleBuf += c;
    else if (c === ":") {
      group = true;
      text += c;
    } else if (c === "," || c === ";") {
      items.push({ text, angles });
      text = "";
      angles = [];
    } else text += c;
  }
  if (q || paren > 0 || inAngle) malformed = true;
  items.push({ text, angles });
  return { items: items.filter((it) => it.text.trim() !== "" || it.angles.length > 0), group, malformed };
}

function displayName(raw: string): string | undefined {
  let n = raw.trim();
  if (n.startsWith('"') && n.endsWith('"') && n.length >= 2) n = n.slice(1, -1).replace(/\\(.)/g, "$1");
  n = decodeEncodedWords(n).trim();
  return n || undefined;
}
function itemMailbox(it: ScanItem): Mailbox | undefined {
  if (it.angles.length > 1) return undefined;
  let addr: string;
  let name: string | undefined;
  if (it.angles.length === 1) {
    addr = it.angles[0]!;
    name = displayName(it.text);
  } else {
    addr = it.text.trim();
  }
  if (!ADDR_SPEC.test(addr)) return undefined;
  return { ...(name ? { name } : {}), address: addr.toLowerCase() };
}

/** Lenient list parser (To, Sender, ...): invalid entries are skipped. NEVER use for authorization decisions on From. */
export function parseAddressList(v: string | undefined): Mailbox[] {
  if (!v) return [];
  const scan = scanAddresses(v);
  const out: Mailbox[] = [];
  for (const it of scan.items) {
    const m = itemMailbox(it);
    if (m) out.push(m);
  }
  return out;
}

export type FromProblem = "missing" | "duplicate" | "malformed" | "multiple" | "group" | "sender-mismatch" | "duplicate-return-path";
/** Strict single-mailbox parse. Anything ambiguous (several mailboxes or angle-addrs, group syntax, unbalanced
 *  quotes/comments/brackets) returns undefined so the caller drops the mail. */
export function parseStrictMailbox(v: string): Mailbox | undefined | "group" | "multiple" {
  const scan = scanAddresses(v);
  if (scan.malformed) return undefined;
  if (scan.group) return "group";
  if (scan.items.length !== 1 || scan.items[0]!.angles.length > 1) return "multiple";
  return itemMailbox(scan.items[0]!);
}

// ---------- entity parsing ----------

interface Entity {
  headers: HeaderMap;
  ct: ContentType;
  cte: string;
  disposition: string;
  filename: string | undefined;
  body: Buffer;
}

function indexOfBlank(buf: Buffer): { end: number; bodyStart: number } {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (buf[i + 1] === 0x0a) return { end: i, bodyStart: i + 2 };
      if (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) return { end: i, bodyStart: i + 3 };
    }
  }
  return { end: buf.length, bodyStart: buf.length };
}

function parseHeaderBlock(block: Buffer): HeaderMap {
  const text = decodeHeaderBytes(block);
  const lines = text.split(/\r?\n/);
  const unfolded: string[] = [];
  for (const l of lines) {
    if (/^[ \t]/.test(l) && unfolded.length) unfolded[unfolded.length - 1] += " " + l.trim();
    else if (l.length) unfolded.push(l);
  }
  const h = new HeaderMap();
  for (const l of unfolded) {
    const i = l.indexOf(":");
    if (i <= 0) continue;
    const name = l.slice(0, i).trim();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) continue;
    h.add(name, l.slice(i + 1).trim());
  }
  return h;
}

function parseEntity(buf: Buffer): Entity {
  const { end, bodyStart } = indexOfBlank(buf);
  const headers = parseHeaderBlock(buf.subarray(0, end));
  const ct = parseContentType(headers.get("content-type"));
  const disp = splitParams(headers.get("content-disposition") ?? "");
  const filename = disp.params.filename ?? ct.params.name;
  return {
    headers,
    ct,
    cte: (headers.get("content-transfer-encoding") ?? "7bit").trim().toLowerCase(),
    disposition: disp.main.toLowerCase(),
    filename: filename ? decodeEncodedWords(filename) : undefined,
    body: buf.subarray(bodyStart),
  };
}

function splitMultipart(body: Buffer, boundary: string, maxParts: number): Buffer[] {
  const text = body.toString("latin1");
  const delim = `--${boundary}`;
  const parts: Buffer[] = [];
  let start = -1;
  let pos = 0;
  for (;;) {
    const idx = text.indexOf(delim, pos);
    if (idx < 0) {
      if (start >= 0) parts.push(body.subarray(start)); // missing closing delimiter: keep the tail
      break;
    }
    const atLineStart = idx === 0 || text[idx - 1] === "\n";
    const closing = text.slice(idx + delim.length, idx + delim.length + 2) === "--";
    const eol = text.indexOf("\n", idx);
    const lineRest = text.slice(idx + delim.length, eol < 0 ? text.length : eol);
    if (!atLineStart || (!closing && !/^[ \t]*\r?$/.test(lineRest))) {
      pos = idx + delim.length;
      continue;
    }
    if (start >= 0) {
      let e = idx;
      if (text[e - 1] === "\n") e--;
      if (text[e - 1] === "\r") e--;
      parts.push(body.subarray(start, e));
      if (parts.length >= maxParts) break;
    }
    if (closing) break;
    start = eol < 0 ? text.length : eol + 1;
    pos = start;
  }
  return parts;
}

function decodeBody(e: Entity): Buffer {
  if (e.cte === "base64") return Buffer.from(e.body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (e.cte === "quoted-printable") return decodeQuotedPrintable(e.body);
  return Buffer.from(e.body);
}
function estimatedDecodedSize(e: Entity): number {
  return e.cte === "base64" ? Math.floor((e.body.length * 3) / 4) : e.body.length;
}

interface Walk {
  attachments: ParsedAttachment[];
  skipped: number;
  report: boolean;
  parts: number;
  maxAtt: number;
  maxParts: number;
  maxDepth: number;
}

function isAttachment(e: Entity): boolean {
  if (e.disposition === "attachment") return true;
  if (e.ct.type === "text" && (e.ct.subtype === "plain" || e.ct.subtype === "html") && e.disposition !== "attachment" && !e.filename) return false;
  return true;
}

function textOf(e: Entity): string {
  return decodeBytes(decodeBody(e), e.ct.params.charset);
}

/** Returns { plain, html } text candidates for an entity tree, collecting attachments on the way. */
function render(e: Entity, w: Walk, depth: number): { text: string; hasPlain: boolean; fromHtml: boolean } {
  if (++w.parts > w.maxParts || depth > w.maxDepth) return { text: "", hasPlain: false, fromHtml: false };
  const { type, subtype } = e.ct;
  if (type === "multipart") {
    if (subtype === "report") w.report = true;
    const boundary = e.ct.params.boundary;
    if (!boundary) return { text: "", hasPlain: false, fromHtml: false };
    const kids = splitMultipart(e.body, boundary, w.maxParts).map((p) => parseEntity(p));
    if (subtype === "alternative") {
      const rendered = kids.map((k) => render(k, w, depth + 1));
      const plain = rendered.find((r) => r.hasPlain);
      const pick = plain ?? [...rendered].reverse().find((r) => r.text.trim().length > 0) ?? rendered.at(-1);
      return pick ?? { text: "", hasPlain: false, fromHtml: false };
    }
    const texts: string[] = [];
    let hasPlain = false;
    let fromHtml = false;
    for (const k of kids) {
      const r = render(k, w, depth + 1);
      if (r.text.trim()) {
        texts.push(r.text);
        hasPlain ||= r.hasPlain;
        fromHtml ||= r.fromHtml;
      }
    }
    return { text: texts.join("\n\n"), hasPlain, fromHtml: !hasPlain && fromHtml };
  }
  if (type === "message" && (subtype === "delivery-status" || subtype === "disposition-notification" || subtype === "feedback-report")) {
    w.report = true;
    return { text: "", hasPlain: false, fromHtml: false };
  }
  if (type === "message" && subtype === "rfc822") return { text: "", hasPlain: false, fromHtml: false };
  if (!isAttachment(e) && type === "text" && subtype === "plain") return { text: textOf(e), hasPlain: true, fromHtml: false };
  if (!isAttachment(e) && type === "text" && subtype === "html") return { text: htmlToText(textOf(e)), hasPlain: false, fromHtml: true };
  // attachment
  if (estimatedDecodedSize(e) > w.maxAtt) {
    w.skipped++;
  } else {
    const data = decodeBody(e);
    if (data.length > w.maxAtt) w.skipped++;
    else
      w.attachments.push({
        ...(e.filename ? { filename: e.filename } : {}),
        mimeType: `${type}/${subtype}`,
        data,
        inline: e.disposition === "inline",
      });
  }
  return { text: "", hasPlain: false, fromHtml: false };
}

function resolveFrom(h: HeaderMap): { from: Mailbox } | { fromProblem: FromProblem } {
  const froms = h.getAll("from");
  if (froms.length === 0) return { fromProblem: "missing" };
  if (froms.length > 1) return { fromProblem: "duplicate" };
  if (h.getAll("return-path").length > 1) return { fromProblem: "duplicate-return-path" };
  const m = parseStrictMailbox(froms[0]!);
  if (m === "group" || m === "multiple") return { fromProblem: m };
  if (!m) return { fromProblem: "malformed" };
  const senders = h.getAll("sender");
  if (senders.length > 1) return { fromProblem: "sender-mismatch" };
  if (senders.length === 1) {
    const sm = parseStrictMailbox(senders[0]!);
    if (!sm || typeof sm === "string" || sm.address !== m.address) return { fromProblem: "sender-mismatch" };
  }
  return { from: m };
}

export function parseMessage(raw: Uint8Array, opts: ParseOptions = {}): ParsedMessage {
  const root = parseEntity(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
  const w: Walk = {
    attachments: [],
    skipped: 0,
    report: root.ct.type === "multipart" && root.ct.subtype === "report",
    parts: 0,
    maxAtt: opts.maxAttachmentBytes ?? 10 * 1024 * 1024,
    maxParts: opts.maxParts ?? 100,
    maxDepth: opts.maxDepth ?? 8,
  };
  const body = render(root, w, 0);
  const h = root.headers;
  const dateRaw = h.get("date");
  const dateMs = dateRaw ? Date.parse(dateRaw) : NaN;
  const rp = h.get("return-path");
  const fromInfo = resolveFrom(h);
  const msgId = parseMessageIds(h.get("message-id"))[0];
  const irt = parseMessageIds(h.get("in-reply-to"))[0];
  return {
    headers: h,
    ...(msgId ? { messageId: msgId } : {}),
    ...(irt ? { inReplyTo: irt } : {}),
    references: parseMessageIds(h.getAll("references").join(" ")),
    subject: decodeEncodedWords(h.get("subject") ?? "").replace(/[\r\n\t]+/g, " ").trim(),
    ...fromInfo,
    to: parseAddressList(h.getAll("to").join(", ")),
    ...(Number.isFinite(dateMs) ? { date: dateMs } : {}),
    ...(rp !== undefined ? { returnPath: rp } : {}),
    text: body.text.replace(/\r\n/g, "\n").replace(/\u0000/g, ""),
    fromHtml: body.fromHtml,
    attachments: w.attachments,
    skippedAttachments: w.skipped,
    isReport: w.report,
    contentType: `${root.ct.type}/${root.ct.subtype}`,
  };
}
