import { createHash } from "node:crypto";
import { createRedactor } from "../../logs/redact.ts";
import {
  MEMORY_EXPORT_CATEGORIES,
  type MemoryExportCategory,
  type ParsedEntry,
  type ParsedMemoryExport,
  type SourceType,
} from "./types.ts";

const MAX_INPUT_BYTES = 512 * 1024;
const MAX_ENTRIES = 5000;
const MAX_ENTRY_CHARS = 4000;

const CATEGORY_MAP: Record<string, MemoryExportCategory> = {
  instructions: "Instructions",
  anweisungen: "Instructions",
  regeln: "Instructions",
  identity: "Identity",
  identität: "Identity",
  identitaet: "Identity",
  career: "Career",
  beruf: "Career",
  karriere: "Career",
  projects: "Projects",
  projekte: "Projects",
  preferences: "Preferences",
  präferenzen: "Preferences",
  praeferenzen: "Preferences",
  vorlieben: "Preferences",
  other: "Other",
  sonstiges: "Other",
  anderes: "Other",
};

/** Normalise section heading line into one of the 6 categories, or null if not a category heading */
function matchCategoryHeader(line: string): MemoryExportCategory | null {
  const trimmed = line.trim();
  // Bound header line length to prevent linear slowdowns on long input
  if (trimmed.length > 64) return null;
  // Strip markdown hashes: ##, #, ###
  let text = trimmed.replace(/^#+\s*/, "");
  // Strip leading list numbers: "1. ", "1. **Instructions**"
  text = text.replace(/^\d+[\.\)]\s*/, "");
  // Linear strip of leading/trailing bold/italic stars or underscores
  let start = 0;
  while (start < text.length && (text[start] === "*" || text[start] === "_")) start++;
  let end = text.length;
  while (end > start && (text[end - 1] === "*" || text[end - 1] === "_")) end--;
  text = text.slice(start, end).trim();
  // Strip trailing colon
  if (text.endsWith(":")) text = text.slice(0, -1).trim();

  const key = text.toLowerCase();
  return CATEGORY_MAP[key] ?? null;
}

/** Parse date string like [YYYY-MM-DD], [YYYY-MM], [YYYY], [unknown], [unbekannt] */
function parseDateToken(token: string): { date?: string; warning?: string } {
  const norm = token.trim().toLowerCase();
  if (norm === "unknown" || norm === "unbekannt") {
    return {};
  }
  const ymdfull = /^(\d{4})-(\d{2})-(\d{2})$/.exec(norm);
  if (ymdfull) {
    const y = parseInt(ymdfull[1]!, 10);
    const m = parseInt(ymdfull[2]!, 10);
    const d = parseInt(ymdfull[3]!, 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { date: new Date(Date.UTC(y, m - 1, d)).toISOString() };
    }
    return { warning: "date-unparseable" };
  }
  const ym = /^(\d{4})-(\d{2})$/.exec(norm);
  if (ym) {
    const y = parseInt(ym[1]!, 10);
    const m = parseInt(ym[2]!, 10);
    if (m >= 1 && m <= 12) {
      return { date: new Date(Date.UTC(y, m - 1, 1)).toISOString() };
    }
    return { warning: "date-unparseable" };
  }
  const yonly = /^(\d{4})$/.exec(norm);
  if (yonly) {
    const y = parseInt(yonly[1]!, 10);
    return { date: new Date(Date.UTC(y, 0, 1)).toISOString() };
  }
  return { warning: "date-unparseable" };
}

export function parseMemoryExport(
  rawInput: string,
  _options?: { now?: number },
): ParsedMemoryExport {
  const warnings: string[] = [];
  if (typeof rawInput !== "string" || rawInput.trim().length === 0) {
    return { entries: [], status: "unrecognized", warnings: [] };
  }

  let text = rawInput;
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
    // Truncate to MAX_INPUT_BYTES
    const buf = Buffer.from(text, "utf8").subarray(0, MAX_INPUT_BYTES);
    text = buf.toString("utf8");
    warnings.push("input-truncated-512kib");
  }

  // Look for status line anywhere in text (typically at the end)
  let status: "complete" | "more" | "unrecognized" = "complete";
  const statusMatch = /STATUS:\s*(COMPLETE|MORE)/i.exec(text);
  if (statusMatch) {
    status = statusMatch[1]!.toUpperCase() === "MORE" ? "more" : "complete";
  }

  // Extract lines
  const lines = text.split(/\r?\n/);
  const redactor = createRedactor();
  const entries: ParsedEntry[] = [];

  let currentCategory: MemoryExportCategory | null = null;
  let activeEntry: {
    category: MemoryExportCategory;
    sourceType: SourceType;
    recordedAt?: string | undefined;
    text: string;
    entryWarnings: Set<string>;
  } | null = null;

  function commitActiveEntry() {
    if (!activeEntry) return;
    let cleanText = activeEntry.text.trim();
    // Strip control characters except newline and tab
    cleanText = cleanText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    const entryWarnings = Array.from(activeEntry.entryWarnings);

    // Redaction must run BEFORE truncation so secrets at the 4000-char boundary are never partially leaked
    const redacted = redactor.text(cleanText);
    if (redacted !== cleanText) {
      cleanText = redacted;
      entryWarnings.push("secret-redacted");
    }

    if (cleanText.length > MAX_ENTRY_CHARS) {
      cleanText = cleanText.slice(0, MAX_ENTRY_CHARS);
      entryWarnings.push("overlong-entry");
    }

    const idempotencyKey = createHash("sha256")
      .update(activeEntry.category + ":" + cleanText.trim().toLowerCase())
      .digest("hex");

    entries.push({
      category: activeEntry.category,
      sourceType: activeEntry.sourceType,
      ...(activeEntry.recordedAt ? { recordedAt: activeEntry.recordedAt } : {}),
      text: cleanText,
      warnings: entryWarnings,
      idempotencyKey,
    });

    activeEntry = null;
  }

  for (let i = 0; i < lines.length; i++) {
    if (entries.length >= MAX_ENTRIES) {
      warnings.push("max-entries-reached");
      break;
    }
    const line = lines[i]!;
    const trimmed = line.trim();

    // Skip empty lines, code fences, status line, or the PLUR1BUS header marker
    if (
      trimmed === "" ||
      trimmed.startsWith("```") ||
      trimmed === "PLUR1BUS-MEMORY-EXPORT v1" ||
      /^STATUS:\s*(COMPLETE|MORE)$/i.test(trimmed)
    ) {
      continue;
    }

    // Check for category heading
    const matchedCategory = matchCategoryHeader(trimmed);
    if (matchedCategory) {
      commitActiveEntry();
      currentCategory = matchedCategory;
      continue;
    }

    // Ignore intro lines if not matching an item and we haven't seen an item in category yet
    if (
      /^(here are|stored memories|my stored|memory export|categories:)/i.test(
        trimmed,
      )
    ) {
      continue;
    }

    // If outside any category section, ignore line with warning
    if (!currentCategory) {
      warnings.push("unknown-section");
      continue;
    }

    // Check if continuation line: indented by >= 2 spaces or tab and not starting with a bracket date or bullet
    const isIndented = /^(\s{2,}|\t)/.test(line);
    const startsItem = /^\s*(\[|\*|-|\d+\.)/.test(line);

    if (isIndented && !startsItem && activeEntry) {
      activeEntry.text += "\n" + trimmed;
      continue;
    }

    // New item line: parse date, source type, text
    commitActiveEntry();

    let content = trimmed;
    // Strip leading list bullet if any: "- ", "* ", "1. "
    content = content.replace(/^([*\-•]|\d+[\.\)])\s+/, "");

    let recordedAt: string | undefined;
    let sourceType: SourceType = "memory";
    const entryWarnings = new Set<string>();

    // Parse bracketed tokens at the start, e.g. [2024-01-15] [memory] - text
    let matchedBracket = true;
    while (matchedBracket && content.startsWith("[")) {
      const closeIdx = content.indexOf("]");
      if (closeIdx === -1) break;
      const token = content.slice(1, closeIdx).trim();
      const tokenLower = token.toLowerCase();

      if (tokenLower === "memory" || tokenLower === "chat") {
        sourceType = tokenLower as SourceType;
        content = content.slice(closeIdx + 1).trim();
      } else {
        const { date, warning } = parseDateToken(token);
        if (warning) {
          entryWarnings.add(warning);
        } else if (date) {
          recordedAt = date;
        }
        content = content.slice(closeIdx + 1).trim();
      }
      matchedBracket = content.startsWith("[");
    }

    // Strip separators like " - ", " – ", " — ", " : ", "- ", ": "
    content = content.replace(/^[\s\-–—:]+\s*/, "").trim();

    // Ignore lines that are empty or were only bullets/separators
    if (content === "") {
      continue;
    }

    activeEntry = {
      category: currentCategory,
      sourceType,
      recordedAt,
      text: content,
      entryWarnings,
    };
  }

  commitActiveEntry();

  if (entries.length === 0) {
    status = "unrecognized";
  }

  return {
    entries,
    status,
    warnings: Array.from(new Set(warnings)),
  };
}
