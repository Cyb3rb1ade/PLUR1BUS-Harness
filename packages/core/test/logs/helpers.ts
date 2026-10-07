import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

export const logsDir = (): string => { const d = path.join(tempDir("p1b-logs-"), "logs"); mkdirSync(d, { recursive: true }); return d; };
export const iso = (ms: number): string => new Date(Date.UTC(2026, 9, 7, 9, 0, 0) + ms).toISOString();

/** A D111-shaped diagnostic line. */
export function rec(ms: number, level: string, msg: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: iso(ms), level, source: { kind: "harness", id: "core", version: null }, event: "core.test", msg, ...extra }) + "\n";
}
/** The harness logger's current shape (`at`, `role`). */
export function legacy(ms: number, level: string, msg: string, role = "core"): string {
  return JSON.stringify({ at: iso(ms), level, role, msg }) + "\n";
}
export const put = (dir: string, name: string, text: string): string => { const p = path.join(dir, name); writeFileSync(p, text); return p; };
export const add = (dir: string, name: string, text: string): void => appendFileSync(path.join(dir, name), text);
/** The rotation of module-api's logger: `core.log.N` shifts up, `core.log` becomes `.1`, a fresh `core.log` appears. */
export function rotate(dir: string, name: string, keep = 5): void {
  for (let i = keep - 1; i >= 1; i--) { try { renameSync(path.join(dir, `${name}.${i}`), path.join(dir, `${name}.${i + 1}`)); } catch { /* none */ } }
  renameSync(path.join(dir, name), path.join(dir, `${name}.1`));
  writeFileSync(path.join(dir, name), "");
}
