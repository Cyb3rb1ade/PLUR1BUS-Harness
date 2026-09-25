import { cpSync } from "node:fs";

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error("usage: copy-dir.mjs <src> <dst>");
  process.exit(1);
}
cpSync(src, dst, { recursive: true });
