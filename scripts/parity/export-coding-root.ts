// Record D109 coding-root admissions on an isolated Git fixture.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { codingRoot } from "../../packages/core/src/coding/root.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import { exporterMain } from "./lib.mjs";

export async function buildCodingRootVectors() {
  const dir = mkdtempSync(join(tmpdir(), "p4k-coding-root-"));
  try {
    const root = realpathSync.native(dir);
    const work = join(root, "work"), home = join(root, "core-home");
    const nested = join(work, "nested"), privateState = join(home, "state");
    mkdirSync(nested, { recursive: true });
    mkdirSync(privateState, { recursive: true });
    const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    Object.assign(gitEnvironment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : devNull });
    execFileSync("git", ["init", "--template=", "-q", work], { env: gitEnvironment, stdio: "pipe" });
    const cases = [];
    for (const [name, path, allow] of [
      ["configured", work, true], ["outside configured", work, false], ["not absolute", "work", false],
      ["not top-level", nested, false], ["private state", privateState, false], ["parent of core home", root, false],
      ["does not exist", join(root, "missing"), false],
    ] as const) {
      try {
        const resolved = await codingRoot(path, home, allow ? [{ id: "work", path: work }] : []);
        cases.push({ name, result: { ok: { rootId: resolved.rootId, exists: resolved.exists, systemTree: resolved.systemTree } } });
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
        cases.push({ name, result: { err: { code: e.error, message: e.message, reason: e.reason ?? null } } });
      }
    }
    return { root: cases };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "coding", build: buildCodingRootVectors });
}
