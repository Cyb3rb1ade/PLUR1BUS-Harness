// Strict validation of raw scan entries (spec §2.4, R6, R11; plan Task 3). One invalid entry fails the whole scan:
// a dropped entry would look "gone" and mark a real model unavailable.
import { LIMITS, ScanError } from "./http.ts";
import type { RawEntry } from "./types.ts";

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const bad = (): never => { throw new ScanError("failed:invalid", "invalid_entry"); };

export function checkId(v: unknown): string {
  return typeof v === "string" && ID_RE.test(v) ? v : bad();
}
/** At most 512 UTF-8 bytes, no C0, DEL or C1 control character. */
export function checkString(v: unknown): string {
  if (typeof v !== "string" || Buffer.byteLength(v, "utf8") > LIMITS.maxStringBytes || CONTROL.test(v)) return bad();
  return v;
}
export function checkPositiveInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0 ? v : bad();
}
/** More than 5 000 entries fails (`too_many_entries`); duplicate ids keep the first and are counted. */
export function finalizeEntries(entries: RawEntry[]): { entries: RawEntry[]; duplicates: number } {
  if (entries.length > LIMITS.maxEntries) throw new ScanError("failed:invalid", "too_many_entries");
  const seen = new Set<string>(); const out: RawEntry[] = []; let duplicates = 0;
  for (const e of entries) {
    if (seen.has(e.id)) { duplicates += 1; continue; }
    seen.add(e.id); out.push(e);
  }
  return { entries: out, duplicates };
}
