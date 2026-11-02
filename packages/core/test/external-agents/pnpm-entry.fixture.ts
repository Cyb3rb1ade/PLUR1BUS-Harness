import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Locate the pinned package behind a symlink or pnpm/action-setup self-update shim. */
export function pnpmEntry(bin: string, version: string, pnpmHome?: string, npmExecPath?: string): string | null {
  const roots = new Set<string>();
  if (npmExecPath) {
    try { roots.add(dirname(dirname(realpathSync(npmExecPath)))); }
    catch { /* A stale invoking path must not hide a valid installed package. */ }
  }
  let dir = dirname(realpathSync(bin));
  for (let i = 0; i < 5; i++) {
    roots.add(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (pnpmHome) roots.add(pnpmHome);
  for (const root of roots) {
    for (const candidate of [root, join(root, "node_modules", "pnpm"),
      join(root, ".tools", "pnpm", version, "node_modules", "pnpm")]) {
      try {
        const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
        const entry = join(candidate, "bin", "pnpm.cjs");
        if (pkg.name === "pnpm" && pkg.version === version && existsSync(entry)) return entry;
      } catch { /* Not a matching installed package; keep looking. */ }
    }
  }
  return null;
}
