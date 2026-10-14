// Incoming A2A 0.3 Parts (text, file, data) → a single turn text plus structured copies for history.
// RULING: a file part with `uri` is accepted as a reference only; this server never fetches it (SSRF).
import type { A2aFilePart, A2aLimits, A2aPart } from "./types.ts";

export class PartError extends Error {
  readonly code: "invalid" | "content-type" | "too-large" | "too-many";
  constructor(code: PartError["code"], message: string) {
    super(message); this.name = "PartError"; this.code = code;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function fileBytes(file: Record<string, unknown>): { b64: string; byteLength: number } | undefined {
  const raw = typeof file.bytes === "string" ? file.bytes : typeof file.data === "string" ? file.data : undefined;
  if (raw === undefined) return undefined;
  // Length of base64 is a cheap upper bound; Buffer.from would allocate the decoded body.
  const padded = raw.replace(/\s+/g, "");
  return { b64: padded, byteLength: Math.floor(padded.length * 3 / 4) };
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Exact decoded size of a canonical base64 string, or undefined when it is not canonical base64. */
function decodedSize(b64: string): number | undefined {
  if (!BASE64.test(b64)) return undefined;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return b64.length / 4 * 3 - pad;
}

// File metadata ends up in the turn text; a control or line-separator character there could forge extra lines.
// eslint-disable-next-line no-control-regex
const LINE_FORGERY = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const flat = (s: string, max: number): string => s.replace(LINE_FORGERY, " ").slice(0, max).trim();

export function parseParts(raw: unknown, limits: A2aLimits): { parts: A2aPart[]; text: string } {
  if (!Array.isArray(raw) || raw.length === 0) throw new PartError("invalid", "message.parts must be a non-empty array");
  if (raw.length > limits.maxParts) throw new PartError("too-many", "too many parts");
  const parts: A2aPart[] = [];
  const texts: string[] = [];
  let textBytes = 0;
  for (const p of raw) {
    if (!isObj(p) || typeof p.kind !== "string") throw new PartError("invalid", "invalid part");
    if (p.kind === "text") {
      if (typeof p.text !== "string") throw new PartError("invalid", "text part needs a text string");
      const part: A2aPart = { kind: "text", text: p.text };
      parts.push(part);
      texts.push(p.text);
      textBytes += Buffer.byteLength(p.text, "utf8");
      if (textBytes > limits.maxTextBytes) throw new PartError("too-large", "message text is too large");
    } else if (p.kind === "file") {
      if (!isObj(p.file)) throw new PartError("invalid", "file part needs a file object");
      const f = p.file;
      const name = typeof f.name === "string" ? flat(f.name, 256) : undefined;
      const mimeType = typeof f.mimeType === "string" ? flat(f.mimeType, 128) : undefined;
      const uri = typeof f.uri === "string" ? flat(f.uri, 2048) : undefined;
      const encoded = fileBytes(f);
      if (encoded && encoded.byteLength > limits.maxFileBytes) throw new PartError("too-large", "file part is too large");
      if (encoded) {
        const exact = decodedSize(encoded.b64);
        if (exact === undefined) throw new PartError("invalid", "file bytes are not valid base64");
        encoded.byteLength = exact;
      }
      if (!encoded && !uri) throw new PartError("invalid", "file part needs bytes or a uri");
      const file: A2aFilePart["file"] = {};
      if (name) file.name = name;
      if (mimeType) file.mimeType = mimeType;
      if (uri) file.uri = uri;
      if (encoded) file.bytes = encoded.b64;
      parts.push({ kind: "file", file });
      const label = [`[file`, name ? `name=${name}` : "", mimeType ? `mime=${mimeType}` : "", encoded ? `bytes=${encoded.byteLength}` : "", uri ? `uri=${uri}` : ""].filter((x) => x !== "").join(" ");
      texts.push(`${label}]`);
    } else if (p.kind === "data") {
      if (!isObj(p.data)) throw new PartError("invalid", "data part needs a data object");
      const json = JSON.stringify(p.data);
      if (Buffer.byteLength(json, "utf8") > limits.maxDataBytes) throw new PartError("too-large", "data part is too large");
      parts.push({ kind: "data", data: p.data });
      texts.push(`[data] ${json}`);
    } else {
      throw new PartError("content-type", `part kind ${JSON.stringify(p.kind)} is not supported`);
    }
  }
  const text = texts.join("\n");
  if (text.trim() === "") throw new PartError("invalid", "message text is empty");
  return { parts, text };
}
