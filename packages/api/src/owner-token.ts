import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync, type Stats } from "node:fs";
import path from "node:path";
import { checkRunDir, runDir, UntrustedRunDir, type TrustOptions } from "@plur1bus/module-api";

export const OWNER_TOKEN_FILE = "api-owner.token";
const SHAPE = /^[0-9a-f]{64}$/;

export function ownerTokenPath(home: string): string { return path.join(runDir(home), OWNER_TOKEN_FILE); }

/** The owner credential of the web login (ruling R2): 32 random bytes as 64 hex characters in `run/api-owner.token`
 *  (mode 0600, in the user-only `run/`), created on first start and kept. The core's RPC token is a different secret
 *  and is never offered to a browser. `run/` is checked first like every token read (audit M2); a token file that is a
 *  symlink, foreign-owned or readable by others is refused rather than trusted. Nothing here is ever logged. */
export function ensureOwnerToken(home: string, o: TrustOptions = {}): string {
  const dir = runDir(home);
  const v = checkRunDir(dir, o);
  if (!v.ok) throw new UntrustedRunDir(v.detail);
  const file = ownerTokenPath(home);
  const posix = (o.platform ?? process.platform) !== "win32";
  let st: Stats | undefined;
  try { st = lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (st) {
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (posix && ((st.mode & 0o077) !== 0 || (typeof process.geteuid === "function" && st.uid !== (o.euid ?? process.geteuid())))) throw new Error(`${file} must be owned by this user and not accessible by group or others`);
    const t = readFileSync(file, "utf8").trim();
    if (SHAPE.test(t)) return t;
    throw new Error(`${file} does not hold a 64-character hex token; remove it to have a new one made`);
  }
  const token = randomBytes(32).toString("hex");
  try { writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return ensureOwnerToken(home, o); throw e; } // lost a start race: use the winner's
  return token;
}
