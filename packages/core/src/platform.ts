import { chmodSync, lstatSync, statSync } from "node:fs";
import path from "node:path";
import type { IpcAddress, PlatformCapabilities, SecurePathResult } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

function securePath(p: string, options: { mode?: number } = {}): SecurePathResult {
  if (typeof p !== "string" || !path.isAbsolute(p)) return { applied: false, reason: "not-a-filesystem-path" };
  try { statSync(p); } catch { return { applied: false, reason: "missing" }; }
  if (process.platform === "win32") return { applied: false, reason: "acl-tool-unavailable" }; // H2: icacls user-SID ACL
  chmodSync(p, options.mode ?? 0o600);
  return { applied: true, mechanism: "chmod" };
}

function ipcAddress(stateRoot: string): IpcAddress {
  if (process.platform === "win32") return { kind: "named-pipe", address: `\\\\.\\pipe\\plur1bus-embed-${Buffer.from(stateRoot).toString("hex").slice(0, 32)}` };
  return { kind: "unix-socket", address: path.join(stateRoot, "embedding.sock") };
}

function isUnsafeLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function canonicalIdentityPath(p: string): string {
  return process.platform === "win32" ? path.win32.normalize(p).toLowerCase().replace(/^[a-z]:/, (d) => d.toLowerCase()) : path.posix.normalize(p);
}

export const platformCapabilities: PlatformCapabilities = { securePath, ipcAddress, isUnsafeLink, canonicalIdentityPath };
