// M-A12 owns persistent extension data directories, independently of inherited process environment.
import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { SecurePath } from "./secure-path.ts";

// ExtItem names accept 64 ASCII characters; callers still validate their kind's complete manifest.
const MAX_DATA_NAME_LENGTH = 64;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;

/**
 * Creates `<home>/data/ext/<name>` after checking a bounded, lowercase single name component.
 * Keeps existing contents, secures every data directory, and refuses links (including Windows junctions),
 * non-directories and unavailable owner-only permissions. Callers must also validate their complete manifest.
 */
export function createExtensionDataDir(home: string, name: string, securePath: SecurePath): string {
  if (name.length > MAX_DATA_NAME_LENGTH || !/^[a-z0-9]/.test(name) || /[^a-z0-9._-]/.test(name)
    || name.endsWith(".") || WINDOWS_DEVICE_NAME.test(name)) {
    throw new Error("extension name must be a safe single data-directory component");
  }
  const directory = (file: string): void => {
    const entry = lstatSync(file);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("data directory must be a directory without symbolic links or junctions");
    }
  };
  directory(home);
  let current = home;
  // Create one segment at a time: recursive mkdir could traverse a pre-existing data/ext link before validation.
  for (const segment of ["data", "ext", name]) {
    current = path.join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    directory(current);
    if (!securePath(current, { mode: 0o700 }).applied) {
      throw new Error("data directory owner-only permissions are unavailable");
    }
  }
  return current;
}
