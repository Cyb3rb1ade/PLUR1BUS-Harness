import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fresh directory under the OS temp dir, spelled by its real path. GitHub's Windows runners report the temp dir in 8.3
 * form (`C:\Users\RUNNER~1\...`), and the D109 path layer refuses an 8.3 segment as a possible alias (`short-name`), so a
 * root, cwd or output path below `os.tmpdir()` would be refused there. `fs.promises.realpath` resolves it to the long
 * name (and symbolic links), as `realpathSync.native` does. The caller removes the directory.
 */
export const realTempDir = async (prefix: string): Promise<string> => realpath(await mkdtemp(join(tmpdir(), prefix)));
