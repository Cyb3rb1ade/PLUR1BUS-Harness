// Test helper: one digest over a directory tree — every entry's relative path, type, content hash (files), link
// target (symlinks) and mtime — so "the source is byte-identical before and after" is one string comparison.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

export function treeEntries(root: string, opts: { mtime?: boolean } = {}): string[] {
  const mt = (m: number) => (opts.mtime === false ? "" : ` ${m}`);
  const out: string[] = [];
  const walk = (p: string) => {
    for (const name of readdirSync(p).sort()) {
      const q = join(p, name);
      const st = lstatSync(q);
      const rel = relative(root, q).replaceAll("\\", "/");
      if (st.isSymbolicLink()) out.push(`L ${rel} -> ${readlinkSync(q)}`);
      else if (st.isDirectory()) { out.push(`D ${rel}${mt(st.mtimeMs)}`); walk(q); }
      else out.push(`F ${rel} ${st.size}${mt(st.mtimeMs)} ${createHash("sha256").update(readFileSync(q)).digest("hex")}`);
    }
  };
  walk(root);
  return out;
}

export function treeDigest(root: string, opts: { mtime?: boolean } = {}): string {
  return treeEntries(root, opts).join("\n");
}
