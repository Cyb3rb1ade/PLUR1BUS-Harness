// Builds the installable fixture module: src/index.ts with module-api (and everything it imports) inlined into
// dist/index.js, plus module.json and README.md. Tests import buildFixture() to run against a fresh bundle.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

/** Writes dist/ and returns its path. */
export async function buildFixture() {
  const dist = join(here, "dist");
  mkdirSync(dist, { recursive: true });
  await build({
    entryPoints: [join(here, "src", "index.ts")], outfile: join(dist, "index.js"),
    // No --packages=external: the module directory is self-contained. The workspace packages are bundled from
    // their sources (the `source` export condition), so the bundle never lags behind a stale dist/.
    bundle: true, platform: "node", target: "node24", format: "esm", conditions: ["source"], logLevel: "warning",
  });
  for (const f of ["module.json", "README.md"]) copyFileSync(join(here, f), join(dist, f));
  return dist;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await buildFixture();
