/** Pure parser for assistant memory exports; imported instructions remain inert text. */
import { createHash } from "node:crypto";
import {
  MEMORY_EXPORT_MARKER,
  normalizeMemoryText,
  type MemoryCategory,
  type MemoryExportEntry,
  type MemoryExportResult,
  type MemoryExportStatus,
  type MemorySource,
} from "./model.ts";

const MAX_PASTE_BYTES = 512 * 1024;
const MAX_ENTRIES = 5000;
const MAX_ENTRY_CHARACTERS = 4000;
const CATEGORY_ALIASES: Readonly<Record<string, MemoryCategory>> = {
  instructions: "instructions", anweisungen: "instructions", regeln: "instructions",
  identity: "identity", identität: "identity",
  career: "career", beruf: "career", karriere: "career",
  projects: "projects", projekte: "projects",
  preferences: "preferences", präferenzen: "preferences", vorlieben: "preferences",
  other: "other", sonstiges: "other",
};

interface EntryLine {
  text: string;
  originalDate: string;
  source: MemorySource;
  hasDate: boolean;
}

interface PendingEntry {
  category: MemoryCategory;
  originalDate: string;
  source: MemorySource;
  lines: string[];
  line: number;
}

interface Fence {
  character: string;
  length: number;
}

function categoryHeader(line: string): MemoryCategory | undefined {
  // Category names and their allowed decoration are short. Refusing long candidates avoids scanning hostile headings.
  if (line.length > 64) return undefined;
  let title = line.replace(/^#{1,6}\s+/u, "").replace(/^\d{1,4}[.)]\s+/u, "").trim();
  if (title.endsWith(":")) title = title.slice(0, -1).trimEnd();
  if (title.startsWith("**") && title.endsWith("**")) title = title.slice(2, -2).trim();
  if (title.endsWith(":")) title = title.slice(0, -1).trimEnd();
  const alias = title.toLowerCase();
  return Object.hasOwn(CATEGORY_ALIASES, alias) ? CATEGORY_ALIASES[alias] : undefined;
}

function fenceLine(line: string): Fence | undefined {
  const character = line[0];
  if (character !== "`" && character !== "~") return undefined;
  let length = 1;
  while (line[length] === character) length++;
  return length >= 3 ? { character, length } : undefined;
}

function entryLine(line: string): EntryLine | undefined {
  let body = line;
  const bullet = /^(?:[-*+]\s+|\d{1,4}[.)]\s+)/u.exec(body);
  if (bullet) body = body.slice(bullet[0].length);
  const date = /^\[(\d{4}(?:-\d{2}(?:-\d{2})?)?|unknown|unbekannt)\]/iu.exec(body);
  if (date) body = body.slice(date[0].length).trimStart();
  const source = /^\[(memory|chat)\]/iu.exec(body);
  if (source) body = body.slice(source[0].length).trimStart();
  if (!bullet && !date && !source) return undefined;
  if ((date || source) && (body[0] === "-" || body[0] === "–" || body[0] === ":")) {
    body = body.slice(1).trimStart();
  }
  return {
    text: body.trimEnd(),
    originalDate: date?.[1] ?? "unknown",
    source: source?.[1]?.toLowerCase() === "chat" ? "chat" : "memory",
    hasDate: date !== null,
  };
}

function timestamp(originalDate: string): number | undefined {
  if (/^(?:unknown|unbekannt)$/iu.test(originalDate)) return undefined;
  const [year, month = 1, day = 1] = originalDate.split("-").map(Number);
  const date = new Date(0);
  // setUTCFullYear, unlike Date.UTC, does not reinterpret years 0000..0099 as 1900..1999.
  date.setUTCFullYear(year!, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.getTime() : undefined;
}

function deduplicationKey(category: MemoryCategory, text: string): string {
  return createHash("sha256").update(JSON.stringify([category, normalizeMemoryText(text)])).digest("hex");
}

function finishEntry(pending: PendingEntry, result: MemoryExportResult, seen: Set<string>): void {
  const text = pending.lines.join("\n").trim();
  if (!text) {
    result.warnings.push({ code: "unrecognized-line", line: pending.line });
    return;
  }
  const key = deduplicationKey(pending.category, text);
  if (seen.has(key)) return;
  if (result.entries.length >= MAX_ENTRIES) throw new RangeError("Memory export exceeds 5000 unique entries.");
  seen.add(key);
  const characters = [...text];
  const createdAt = timestamp(pending.originalDate);
  const entry: MemoryExportEntry = {
    category: pending.category,
    text: characters.length > MAX_ENTRY_CHARACTERS ? characters.slice(0, MAX_ENTRY_CHARACTERS).join("") : text,
    originalDate: pending.originalDate,
    source: pending.source,
    deduplicationKey: key,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
  if (characters.length > MAX_ENTRY_CHARACTERS) result.warnings.push({ code: "entry-truncated", line: pending.line });
  if (createdAt === undefined && !/^(?:unknown|unbekannt)$/iu.test(pending.originalDate)) {
    result.warnings.push({ code: "invalid-date", line: pending.line });
  }
  result.entries.push(entry);
}

function statusLine(line: string): MemoryExportStatus | undefined {
  if (line === "STATUS: COMPLETE") return "complete";
  if (line === "STATUS: MORE") return "more";
  return undefined;
}

/**
 * Parse at most 512 KiB of UTF-8 text without I/O or a clock. Unknown dates remain unknown regardless of `now`.
 * Throws RangeError above the byte or 5000-entry limit; entries above 4000 codepoints are truncated with a warning.
 * Warnings use 1-based source line numbers and never contain source text. Missing source tags default to `memory`.
 */
export function parseMemoryExport(text: string, _options: { now?: number } = {}): MemoryExportResult {
  if (Buffer.byteLength(text, "utf8") > MAX_PASTE_BYTES) throw new RangeError("Memory export exceeds 512 KiB.");
  const result: MemoryExportResult = { entries: [], status: "unknown", warnings: [] };
  const seen = new Set<string>();
  let category: MemoryCategory = "other";
  let pending: PendingEntry | undefined;
  let fence: Fence | undefined;
  const lines = text.replace(/^\ufeff/u, "").split(/\r\n|[\r\n\u2028\u2029]/u);
  const flush = (): void => {
    if (pending) finishEntry(pending, result, seen);
    pending = undefined;
  };
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const parsed = entryLine(line);
    if (/^[\t ]/u.test(raw) && pending && !parsed?.hasDate) {
      pending.lines.push(line);
      continue;
    }
    flush();
    const candidateFence = fenceLine(line);
    if (candidateFence && !fence) {
      fence = candidateFence;
      continue;
    }
    if (candidateFence && fence && candidateFence.character === fence.character && candidateFence.length >= fence.length
      && line.slice(candidateFence.length).trim() === "") {
      fence = undefined;
      continue;
    }
    if (line === MEMORY_EXPORT_MARKER) continue;
    const heading = categoryHeader(line);
    if (heading) {
      category = heading;
      continue;
    }
    const status = statusLine(line);
    if (status && !fence) {
      result.status = status;
      continue;
    }
    if (parsed) {
      pending = {
        category, originalDate: parsed.originalDate, source: parsed.source, lines: [parsed.text], line: index + 1,
      };
    } else {
      result.warnings.push({ code: "unrecognized-line", line: index + 1 });
    }
  }
  flush();
  return result;
}

/**
 * Combine parser results without mutation, retaining the first occurrence and the final part's completion status.
 * Full-text fingerprints retain deduplication across truncated entries. Throws RangeError above 5000 unique entries.
 */
export function mergeMemoryExports(parts: readonly MemoryExportResult[]): MemoryExportResult {
  const result: MemoryExportResult = { entries: [], status: "unknown", warnings: [] };
  const seen = new Set<string>();
  for (const part of parts) {
    result.status = part.status;
    // A valid 512 KiB paste can contain more warnings than JavaScript permits as function-call arguments.
    for (const warning of part.warnings) result.warnings.push({ ...warning });
    for (const entry of part.entries) {
      const key = entry.deduplicationKey ?? deduplicationKey(entry.category, entry.text);
      if (seen.has(key)) continue;
      if (result.entries.length >= MAX_ENTRIES) throw new RangeError("Memory export exceeds 5000 unique entries.");
      seen.add(key);
      result.entries.push({ ...entry, deduplicationKey: key });
    }
  }
  return result;
}
