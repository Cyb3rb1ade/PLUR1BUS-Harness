// The metrics token: random, persistent (a monitoring system keeps it as a secret macro, so it must survive a core
// restart), never logged. Rotate it by deleting the file and restarting the core.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const VALID = /^[0-9a-f]{64}$/;

export function loadOrCreateMetricsToken(file: string, secure?: (p: string) => unknown): string {
  try {
    if (existsSync(file)) {
      const t = readFileSync(file, "utf8").trim();
      if (VALID.test(t)) return t;
    }
  } catch { /* unreadable: replaced below */ }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(file, 0o600); // writeFile's mode does not apply to an existing file
  secure?.(file); // Windows: the user-SID ACL (platform.securePath)
  return token;
}
