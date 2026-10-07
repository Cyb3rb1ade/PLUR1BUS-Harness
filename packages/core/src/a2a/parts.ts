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
  const byteLength = Math.floor(padded.length * 3 / 4);
  return { b64: padded, byteLength };
}

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
      const name = typeof f.name === "string" ? f.name.slice(0, 256) : undefined;
      const mimeType = typeof f.mimeType === "string" ? f.mimeType.slice(0, 128) : undefined;
      const uri = typeof f.uri === "string" ? f.uri.slice(0, 2048) : undefined;
      const encoded = fileBytes(f);
      if (encoded && encoded.byteLength > limits.maxFileBytes) throw new PartError("too-large", "file part is too large");
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
