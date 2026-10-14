import { createHash } from "node:crypto";
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
  const platform = o.platform ?? process.platform;
  return {
    securePath: createSecurePath(o),
    ipcAddress: (stateRoot: string) => ipcAddress(stateRoot, platform),
    isUnsafeLink,
    canonicalIdentityPath: (p: string) => canonicalIdentityPath(p, platform),
  };
}

/** The pipe name hashes the whole canonical state root (not a prefix of it: homes under one profile share their first
 *  bytes), so one state root has one pipe whatever its spelling and two state roots never share one. */
function ipcAddress(stateRoot: string, platform: NodeJS.Platform): IpcAddress {
  if (platform === "win32") return { kind: "named-pipe", address: `\\\\.\\pipe\\plur1bus-embed-${createHash("sha256").update(canonicalIdentityPath(stateRoot, platform)).digest("hex").slice(0, 32)}` };
  return { kind: "unix-socket", address: path.join(stateRoot, "embedding.sock") };
}

/** Fails closed: only "nothing there" is safe. A path that cannot be examined (permission, too long, a link loop) is not
 *  vouched for. */
function isUnsafeLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** The comparison key of a path: normalised, without a trailing separator (the root keeps its own), Windows paths
 *  lower-cased with the extended-length (question-mark) and UNC prefixes removed, macOS paths in NFC (the default volume treats NFC and NFD as one name). */
function canonicalIdentityPath(p: string, platform: NodeJS.Platform): string {
  const flavour = platform === "win32" ? path.win32 : path.posix;
  let s = p;
  if (platform === "win32") s = s.replace(/^\\\\[?.]\\UNC\\/i, "\\\\").replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, "");
  s = flavour.normalize(s);
  if (platform === "win32") s = s.toLowerCase();
  if (platform === "darwin") s = s.normalize("NFC");
  const root = flavour.parse(s).root;
  while (s.length > root.length && s.endsWith(flavour.sep)) s = s.slice(0, -1);
  return s;
}

export const platformCapabilities: PlatformCapabilities = createPlatformCapabilities();
