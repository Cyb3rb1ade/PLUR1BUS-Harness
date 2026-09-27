import { lstatSync } from "node:fs";
import path from "node:path";
import type { IpcAddress, PlatformCapabilities } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { createSecurePath, type SecurePathOptions } from "@plur1bus/module-api";

// securePath and its Windows ACL helpers live in @plur1bus/module-api (H3B-R12): module processes secure their run
// files the same way.
export {
  othersInDacl, parseSddlDacl, parseWhoamiSid, resolveSddlTrustee, savedSddlLine, systemTool,
  type ExecFile, type SddlAce, type SecurePathOptions as PlatformOptions,
} from "@plur1bus/module-api";

/** The host's platform capabilities (engine `PlatformCapabilities`); `securePath` is module-api's `createSecurePath`. */
export function createPlatformCapabilities(o: SecurePathOptions = {}): PlatformCapabilities {
  return { securePath: createSecurePath(o), ipcAddress, isUnsafeLink, canonicalIdentityPath };
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

export const platformCapabilities: PlatformCapabilities = createPlatformCapabilities();
