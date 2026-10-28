/** Shared data for the prompt interchange format; no storage, principals, or import runs are created here. */

/** Version marker shared by the parser and formatter; the complete assistant prompt lives in export-prompt.md. */
export const MEMORY_EXPORT_MARKER = "PLUR1BUS-MEMORY-EXPORT v1";

/** Category order and spelling in PLUR1BUS-MEMORY-EXPORT v1. */
export const MEMORY_CATEGORIES = [
  "instructions", "identity", "career", "projects", "preferences", "other",
] as const;

/** A category in the portable format, distinct from the Engine's open-ended `kind` string. */
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

/** A source label supplied by the exporting assistant, not a trust assertion. */
export type MemorySource = "memory" | "chat";

/** The interchange entry retains the original date token even when no timestamp can be derived. */
export interface MemoryExportEntry {
  category: MemoryCategory;
  text: string;
  originalDate: string;
  source: MemorySource;
  createdAt?: number;
  /** Full-text fingerprint keeps continuation deduplication correct after a length warning and truncation. */
  deduplicationKey?: string;
}

/** Completion reported by the assistant; missing status never implies completeness. */
export type MemoryExportStatus = "complete" | "more" | "unknown";

/** Content-free diagnostics are safe to include in later import reports. */
export interface MemoryExportWarning {
  code: "entry-truncated" | "invalid-date" | "unrecognized-line";
  line?: number;
  entry?: number;
}

/** A pure parse result; it carries no selection, principal, or persistence state. */
export interface MemoryExportResult {
  entries: MemoryExportEntry[];
  status: MemoryExportStatus;
  warnings: MemoryExportWarning[];
}

/** Unicode and whitespace normalisation for deduplication; case remains significant. */
export function normalizeMemoryText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}
