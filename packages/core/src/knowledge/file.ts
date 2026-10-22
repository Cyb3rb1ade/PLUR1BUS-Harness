// The single curated Markdown target used by import, migration and Engine knowledge-update.
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeAtomicSync } from "../import/fs-atomic.ts";
import { readSourceFileSafe } from "../import/fs-safe.ts";
import { KNOWLEDGE_RELATIVE_PATH } from "../paths.ts";

const MAX_BYTES = 16 * 1024 * 1024;
const sha256 = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex");
function check(path: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("unsafe-symlink");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Refuse symlinks before any read or write, including existing ancestors inside the Harness home. Missing paths are valid for dry run. */
export function assertKnowledgeTarget(workspace: string, home?: string): void {
  const root = resolve(home ?? workspace);
  const target = resolve(workspace, KNOWLEDGE_RELATIVE_PATH);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("knowledge-path-outside-home");
  check(root);
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (!check(current)) break;
  }
}

/** Quote imported text as evidence; opaque source markers cannot contain role or HTML delimiters. */
export function formatImportedKnowledge(text: string, source: string): string {
  const marker = `<!-- plur1bus-imported-knowledge:${sha256(`${source}\0${text}`)} -->`;
  const evidence = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .split("\n").map(line => `> ${line}`).join("\n");
  return `${marker}\n## Imported agent knowledge\n\n${evidence}\n`;
}

/** The shared import writer. Caller holds the Core/import OS lock; content is already evidence-formatted. */
export function writeImportedKnowledge(workspace: string, content: string | Buffer, home: string): void {
  assertKnowledgeTarget(workspace, home);
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("knowledge-too-large");
  writeAtomicSync(join(workspace, KNOWLEDGE_RELATIVE_PATH), content);
}

/** Append source-marked agent knowledge once; the caller holds the offline Core/import lock. */
export function appendImportedKnowledge(workspace: string, text: string, source: string): { path: string; added: boolean; created: boolean; sha256: string; bytes: number } {
  assertKnowledgeTarget(workspace);
  const root = realpathSync(workspace);
  const path = join(workspace, KNOWLEDGE_RELATIVE_PATH);
  const target = join(root, KNOWLEDGE_RELATIVE_PATH);
  const exists = check(target);
  const before = exists ? readSourceFileSafe(target, MAX_BYTES) : Buffer.from("# Knowledge\n");
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(before);
  const entry = formatImportedKnowledge(text, source);
  const marker = entry.slice(0, entry.indexOf("\n"));
  if (content.includes(marker)) return { path, added: false, created: false, sha256: sha256(before), bytes: before.length };
  const output = `${content}\n${entry}`;
  writeImportedKnowledge(root, output, root);
  return { path, added: true, created: !exists, sha256: sha256(output), bytes: Buffer.byteLength(output) };
}
