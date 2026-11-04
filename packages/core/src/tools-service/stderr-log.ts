/** The standalone tools child's bounded private diagnostic stream. No ticket keys, tokens or requests are logged. */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { createLogger, createSecurePath, type HarnessLogger } from "@plur1bus/module-api";

/** The same private logs/ convention as supervised children, with a finite size and retained generations. */
export function openToolsLog(home: string): HarnessLogger {
  const directory = join(home, "logs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error("tools log directory is not a directory");
  const secure = createSecurePath();
  if (!secure(directory, { mode: 0o700 }).applied) throw new Error("tools log directory is not private");
  const file = join(directory, "tools.out.log");
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("tools log is not a private regular file");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("tools log is not a private regular file");
    if (!secure(file, { mode: 0o600 }).applied) throw new Error("tools log is not private");
  } finally { closeSync(fd); }
  return createLogger({ file, level: "error", role: "tools", maxBytes: 1 << 20, keep: 3 });
}
