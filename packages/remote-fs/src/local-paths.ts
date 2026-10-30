/** Lexical containment for configured local authorities and volume-independent native source reads. */
import * as native from "node:path";
import { RemoteFsError } from "./types.ts";

/** Returns a depth-countable path inside the configured authority, or its own native volume for CLI reads. */
export function localSourceRelativePath(path: string, root?: string, paths: typeof native.posix = native): string {
  const relative = paths.relative(root ?? paths.parse(path).root, path);
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) {
    throw new RemoteFsError("path-denied");
  }
  return relative;
}
