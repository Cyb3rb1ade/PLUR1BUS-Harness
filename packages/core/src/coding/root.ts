/** CLI-1 native worktree identity and the existing D109 deny list. Binding never substitutes for permission. */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { denyEntriesFor, isHostPlatform } from "../host-tools/index.ts";
import {
  canonicalisePath,
  containsExact,
  grantReachesSystemTree,
  type DenyEntry,
  type PathRoot,
} from "../policy/paths-index.ts";
import { RpcError } from "../rpc/errors.ts";
import { codingGit, gitLine } from "./git.ts";

/** Validate a real Git worktree root without reading files outside D109's path boundary. */
export async function codingRoot(
  raw: string,
  home: string,
  roots: readonly PathRoot[],
  extra: readonly DenyEntry[] = [],
) {
  if (!isAbsolute(raw)) throw new RpcError("E_INVALID_PARAMS", "coding requires an absolute Git worktree root");
  const platform = isHostPlatform(process.platform) ? process.platform : "linux";
  const deny = [
    ...denyEntriesFor(homedir(), process.env, platform),
    ...["run", "state", "config.json", "bin", "runtime", "secrets"].map((name) => ({ path: join(home, name) })),
    ...extra,
  ];
  const path = await canonicalisePath(raw, {
    roots,
    deny,
    access: "read",
    requireRoot: false,
    platform: process.platform,
  });
  if (!path.ok) throw new RpcError("E_DENIED", "coding root is protected or invalid", { reason: path.reason });
  if (path.systemTree || grantReachesSystemTree(path.canonical, true))
    throw new RpcError("E_DENIED", "home, drive and system roots cannot be coding roots", { reason: "protected-root" });
  // A native verifier is confined to its whole root: it cannot inherit a root containing the core's private children.
  const privateHome = realpathSync.native(home);
  if (containsExact(path.canonical, privateHome, sep)) {
    throw new RpcError("E_DENIED", "coding root cannot contain the protected core home", { reason: "protected-root" });
  }
  if (!path.exists || !statSync(path.canonical).isDirectory()) {
    throw new RpcError("E_INVALID_PARAMS", "coding requires an existing Git worktree root");
  }
  const top = realpathSync.native(gitLine(codingGit(path.canonical, ["rev-parse", "--show-toplevel"])));
  if (top !== path.canonical) throw new RpcError("E_INVALID_PARAMS", "coding requires the Git worktree root");
  return path;
}
