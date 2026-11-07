/** Original B1 variants. Seeds are data, never provider credentials or model sampling promises. */
import { createHash } from "node:crypto";
import { basename, dirname, extname, posix } from "node:path";
export const CODING_SEEDS = Object.freeze([11, 29, 47]);
export function seededInstance(id, entry, seed) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError("invalid coding seed");
  const digest = createHash("sha256").update(`${id}:${seed}`).digest("hex").slice(0, 6);
  const tag = `${seed.toString(36)}_${digest}`,
    extension = extname(entry);
  return {
    seed,
    tag,
    symbol: `solve_${tag}`,
    constant: (seed % 17) + 2,
    entry: posix.join(dirname(entry), `${basename(entry, extension)}_${tag}${extension}`),
  };
}
