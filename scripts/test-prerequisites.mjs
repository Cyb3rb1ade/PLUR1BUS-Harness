// Test tooling only: add setup guidance and rethrow the original resolution failure.
import { stat } from "node:fs/promises";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const PREP = "The forthcoming `pnpm test:prep` command (GP5 T2) will prepare these prerequisites.";
// A resolve hook also covers dynamic imports rejected inside node:test (which do not reach
// uncaughtExceptionMonitor). Successful resolution and every other failure pass through unchanged.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === "ERR_MODULE_NOT_FOUND" && /Cannot find package ['"]@cyb3rb1ade\/plur1bus-memory['"]/.test(error.message)) {
        error.message += `\nTest prerequisites: missing private Engine dependency @cyb3rb1ade/plur1bus-memory. From the repository root, run \`pnpm install --frozen-lockfile\` with access to the private Engine repository. ${PREP}`;
      }
      throw error;
    }
  },
});

async function main(mode, root) {
  try {
    if (mode === "audit") {
      // Import the actual dependency graph with the same source condition as the Rust test's child.
      await import(pathToFileURL(path.join(root, "packages/core/src/audit/chain.ts")).href);
    } else if (mode === "core") {
      const core = path.join(root, "packages/core/dist/core.js");
      if (!(await stat(core)).isFile()) throw new Error(`${core} is not a file`);
    } else {
      throw new Error("usage: test-prerequisites.mjs <audit|core> <repository root>");
    }
    return 0;
  } catch (error) {
    console.error(`Test prerequisites (${mode}): ${error.message}`);
    console.error(`From the repository root, run \`pnpm install --frozen-lockfile\`${mode === "core" ? " then `pnpm build` to create packages/core/dist/core.js" : " then `pnpm gen` to prepare the TypeScript workspace dependencies and generated schemas"}. Use Node 24.21. ${PREP}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main(process.argv[2], process.argv[3] ?? process.cwd());
}
