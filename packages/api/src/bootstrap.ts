import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir, checkRunDir, createSecurePath } from "@plur1bus/module-api";
import type { AccountStore } from "./account-store.ts";
export const bootstrapHash = (value: string) => createHash("sha256").update(value).digest("hex");
/** The database consumption marker survives deletion of the proof file and process restarts. */
export function ensureBootstrap(home: string, accounts: AccountStore, installed = false): () => void {
  const dir = runDir(home), file = join(dir, "api-bootstrap.token");
  if (!checkRunDir(dir).ok) throw new Error("untrusted bootstrap directory");
  const clean = () => { rmSync(file, { force: true }); };
  if (accounts.bootstrapState()?.consumed || accounts.hasOwnerAccount() || installed) { accounts.initializeBootstrap(null, true); clean(); return clean; }
  let value: string;
  try {
    const st = lstatSync(file); if (!st.isFile() || st.size > 128 || process.platform !== "win32" && (st.mode & 0o077 || typeof process.geteuid === "function" && st.uid !== process.geteuid())) throw new Error("untrusted bootstrap file");
    value = readFileSync(file, "utf8").trim(); if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("invalid bootstrap file");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    if (accounts.bootstrapState()) throw new Error("bootstrap proof missing; recovery requires local administrator");
    value = randomBytes(32).toString("base64url"); writeFileSync(file, value + "\n", { mode: 0o600, flag: "wx" });
    if (!createSecurePath()(file, { mode: 0o600 }).applied) { clean(); throw new Error("bootstrap permissions unavailable"); }
  }
  const state = accounts.bootstrapState();
  if (state && state.expiresAt <= Date.now()) {
    value = randomBytes(32).toString("base64url");
    // Startup occurs before opening the API listener; an expired setup proof may rotate, a consumed one cannot.
    if (!accounts.renewExpiredBootstrap(bootstrapHash(value))) { clean(); return clean; }
    writeFileSync(file, value + "\n", { mode: 0o600 });
  }
  accounts.initializeBootstrap(bootstrapHash(value));
  return clean;
}
export function verifyBootstrap(accounts: AccountStore, candidate: unknown): boolean {
  const state = accounts.bootstrapState(); if (!state || state.consumed || state.expiresAt <= Date.now() || !state.hash || typeof candidate !== "string" || candidate.length !== 43) return false;
  const a = Buffer.from(state.hash, "hex"), b = Buffer.from(bootstrapHash(candidate), "hex"); return a.length === b.length && timingSafeEqual(a, b);
}
