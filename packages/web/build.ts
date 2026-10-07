// Static build of the web UI: index.html + main.js + lazy page chunks + one CSS bundle, no inline script or style (ADR-004 CSP).
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export type BuildOptions = {
  /** Include the pattern gallery route (`#/gallery/<pattern>`, components fixture). Off in the shipped bundle. */
  gallery?: boolean;
};

export async function buildWeb(outdir: string = here("./dist"), opts: BuildOptions = {}): Promise<void> {
  await mkdir(outdir, { recursive: true });
  await copyFile(here("./index.html"), `${outdir}/index.html`);
  await build({
    entryPoints: { main: here("./src/main.ts"), styles: here("./src/styles/app.css") },
    entryNames: "[name]",
    // Pages are dynamic import() chunks next to main.js, shared code goes into shared chunks (same origin: `script-src 'self'` covers them, nothing inline).
    splitting: true,
    // Flat on purpose: the static server only has to know single-segment file names.
    chunkNames: "[name]-[hash]",
    outdir,
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    legalComments: "none",
    sourcemap: false,
    define: { __GALLERY__: String(opts.gallery === true) },
    logLevel: "warning",
  });
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await buildWeb(process.argv[2], { gallery: process.env.PLUR1BUS_WEB_GALLERY === "1" });
}
