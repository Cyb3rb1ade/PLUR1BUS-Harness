// A2: migrate legacy agent knowledge before the Engine starts. Never include USER.md.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readSourceFileSafe, decodeSourceText } from "../import/fs-safe.ts";
import { writeAtomicSync } from "../import/fs-atomic.ts";

import { KNOWLEDGE_RELATIVE_PATH } from "../paths.ts";
import { assertKnowledgeTarget } from "./file.ts";
export { KNOWLEDGE_RELATIVE_PATH } from "../paths.ts";
const LEGACY = ["knowledgepool.md", "memories.md"] as const;
const STATE = ".knowledge-migration-v1";
const MAX_BYTES = 16 * 1024 * 1024;
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
export interface KnowledgeMigrationReport {
  version: 1; state: "prepared" | "applied" | "rolled-back";
  beforeSha: string | null; afterSha: string;
  sources: { name: typeof LEGACY[number]; sha256: string }[];
}

function existsSafe(path: string, directory = false): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("unsafe-symlink");
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error("not-regular-file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function paths(workspace: string, home?: string) {
  assertKnowledgeTarget(workspace, home);
  if (!existsSafe(workspace, true)) throw new Error("workspace-missing");
  const root = realpathSync(workspace);
  existsSafe(join(root, "memory"), true);
  existsSafe(join(root, STATE), true);
  return { root, target: join(root, KNOWLEDGE_RELATIVE_PATH), state: join(root, STATE), report: join(root, STATE, "report.json") };
}
function read(path: string, max = MAX_BYTES): Buffer | null {
  return existsSafe(path) ? readSourceFileSafe(path, max) : null;
}
function load(path: string): KnowledgeMigrationReport | null {
  const bytes = read(path, 64 * 1024);
  if (!bytes) return null;
  const raw = JSON.parse(decodeSourceText(bytes));
  const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (raw?.version !== 1 || !["prepared", "applied", "rolled-back"].includes(raw.state)
    || !(raw.beforeSha === null || digest(raw.beforeSha)) || !digest(raw.afterSha)
    || !Array.isArray(raw.sources) || raw.sources.length > LEGACY.length
    || !raw.sources.every((s: { name: string; sha256: string }) => LEGACY.includes(s.name as typeof LEGACY[number]) && digest(s.sha256))) {
    throw new Error("invalid-knowledge-migration-report");
  }
  return raw as KnowledgeMigrationReport;
}
function save(path: string, report: KnowledgeMigrationReport): void { writeAtomicSync(path, JSON.stringify(report, null, 2) + "\n"); }

/** Idempotent offline migration. Sources stay untouched as rollback evidence; the canonical file is authoritative. */
export function migrateLegacyKnowledge(workspace: string, home?: string): KnowledgeMigrationReport | null {
  const p = paths(workspace, home);
  let report = load(p.report);
  if (report && report.state !== "prepared") return report;
  if (!report) {
    const sources = LEGACY.flatMap(name => {
      const bytes = read(join(p.root, name));
      return bytes === null ? [] : [{ name, bytes }];
    });
    if (!sources.length) return null;
    const before = read(p.target);
    let output = before ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(before) : "# Knowledge\n";
    for (const source of sources) {
      const text = decodeSourceText(source.bytes);
      if (!text.trim()) continue;
      // Legacy Markdown is evidence: escape role/HTML delimiters before the Engine's document recall sees it.
      const evidence = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .split("\n").map(line => `> ${line}`).join("\n");
      output += `\n<!-- plur1bus-legacy:${source.name}:${hash(source.bytes)} -->\n## Imported agent knowledge (${source.name})\n\n${evidence}\n`;
    }
    if (Buffer.byteLength(output) > MAX_BYTES) throw new Error("knowledge-too-large");
    mkdirSync(p.state, { recursive: true, mode: 0o700 });
    if (before) writeAtomicSync(join(p.state, "before.md"), before);
    writeAtomicSync(join(p.state, "after.md"), output);
    report = { version: 1, state: "prepared", beforeSha: before ? hash(before) : null, afterSha: hash(output), sources: sources.map(s => ({ name: s.name, sha256: hash(s.bytes) })) };
    save(p.report, report);
  }
  const current = read(p.target);
  const currentSha = current ? hash(current) : null;
  if (currentSha !== report.afterSha) {
    if (currentSha !== report.beforeSha) throw new Error("knowledge-changed");
    const staged = read(join(p.state, "after.md"));
    if (!staged || hash(staged) !== report.afterSha) throw new Error("knowledge-backup-changed");
    writeAtomicSync(p.target, staged);
  }
  report = { ...report, state: "applied" };
  save(p.report, report);
  return report;
}

/** Offline rollback refuses to overwrite any content written since migration (including later Engine promotions). */
export function rollbackKnowledgeMigration(workspace: string, home?: string): KnowledgeMigrationReport {
  const p = paths(workspace, home);
  const report = load(p.report);
  if (!report) throw new Error("knowledge-migration-missing");
  if (report.state === "rolled-back") return report;
  const current = read(p.target);
  const digest = current ? hash(current) : null;
  if (digest !== report.afterSha && digest !== report.beforeSha) throw new Error("knowledge-changed");
  if (report.beforeSha !== null) {
    const before = read(join(p.state, "before.md"));
    if (!before || hash(before) !== report.beforeSha) throw new Error("knowledge-backup-changed");
    writeAtomicSync(p.target, before);
  } else if (current) unlinkSync(p.target);
  const result = { ...report, state: "rolled-back" as const };
  save(p.report, result);
  return result;
}
