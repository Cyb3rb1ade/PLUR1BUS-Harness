// Static build of the web UI: index.html + one JS bundle + one CSS bundle, no inline script or style (ADR-004 CSP).
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export async function buildWeb(outdir: string = here("./dist")): Promise<void> {
  await mkdir(outdir, { recursive: true });
  await copyFile(here("./index.html"), `${outdir}/index.html`);
  await build({
    entryPoints: { main: here("./src/main.ts"), styles: here("./src/styles/app.css") },
    entryNames: "[name]",
    outdir,
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    legalComments: "none",
    sourcemap: false,
    logLevel: "warning",
  });
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await buildWeb(process.argv[2]);
}
