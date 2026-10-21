import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** The OS temp directory spelled by its real path. On Windows runners `os.tmpdir()` is `C:\Users\RUNNER~1\...`, an 8.3
 *  short name, and the path canonicaliser refuses a root spelled that way (`short-name`, so every call answers
 *  OUTSIDE_ROOT). `realpath.native` expands the short names; on POSIX it changes nothing a test can see. */
export const tmpBase = (): string => realpathSync.native(tmpdir());
