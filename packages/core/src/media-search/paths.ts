import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { mediaError } from "./errors.ts";

const inside = (root: string, file: string): boolean => {
  const rel = relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Resolves `path` (following symlinks) and returns the real path only if it lies inside one of `roots`.
 * `roots` undefined: no restriction (the caller did not configure roots). An empty list allows nothing.
 * A missing file or an escape through `..` or a symlink is refused with E_MEDIA_UNSUPPORTED_KIND / reason "path-outside-roots".
 */
export async function resolveInsideRoots(path: string, roots: readonly string[] | undefined): Promise<string> {
  const abs = resolve(path);
  if (roots === undefined) return abs;
  const refuse = () => mediaError("E_MEDIA_UNSUPPORTED_KIND", "media path is outside the allowed directories", { reason: "path-outside-roots" });
  let real: string;
  try { real = await realpath(abs); } catch { throw refuse(); }
  for (const r of roots) {
    let root: string;
    try { root = await realpath(resolve(r)); } catch { continue; }
    if (inside(root, real)) return real;
  }
  throw refuse();
}
