// Static build of the web UI: index.html + main.js + lazy page chunks + one CSS bundle, no inline script or style (ADR-004 CSP).
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform, type Plugin } from "esbuild";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

const pageCssPlugin: Plugin = {
  name: "page-css",
  setup(b) {
    b.onResolve({ filter: /\.css$/ }, (args) => {
      // The entrypoint styles.css bundle and any @import inside a CSS file go through esbuild's default CSS handling
      if (args.importer.endsWith(".css") || args.kind === "entry-point" || args.importer.endsWith("build.ts") || args.path.endsWith("app.css")) {
        return null;
      }
      return {
        path: resolve(args.resolveDir, args.path),
        namespace: "page-css",
      };
    });

    b.onLoad({ filter: /.*/, namespace: "page-css" }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const minified = (await transform(source, { loader: "css", minify: true })).code;
      const name = basename(args.path, ".css");
      return {
        contents: `import { registerChunkCss } from "./chunk.ts";
registerChunkCss(${JSON.stringify(name)}, ${JSON.stringify(minified.trim())});
`,
        resolveDir: here("./src/styles"),
        loader: "js",
      };
    });
  },
};

// The wizard only reads provider/model/approval/discovery from the shipped inventory (config/shipped-models.ts). The
// provenance `source` links (and the prose definition) are release documentation, not UI data, and must not put remote
// origins into the bundle (CSP, test/build.test.ts), so they are dropped when the one shared file is bundled.
const shippedModelsPlugin: Plugin = {
  name: "shipped-models-web",
  setup(b) {
    b.onLoad({ filter: /config[\\/]shipped-models\.json$/ }, async (args) => {
      const inventory = JSON.parse(await readFile(args.path, "utf8")) as { definition?: unknown; models: Record<string, unknown>[] };
      delete inventory.definition;
      for (const m of inventory.models) delete m.source;
      return { contents: JSON.stringify(inventory), loader: "json" };
    });
  },
};

import { bundleDocs } from "./scripts/bundle-user-docs.ts";

export type BuildOptions = {
  /** Include the pattern gallery route (`#/gallery/<pattern>`, components fixture). Off in the shipped bundle. */
  gallery?: boolean;
};

export async function buildWeb(outdir: string = here("./dist"), opts: BuildOptions = {}): Promise<void> {
  bundleDocs();
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
    plugins: [pageCssPlugin, shippedModelsPlugin],
    logLevel: "warning",
  });
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await buildWeb(process.argv[2], { gallery: process.env.PLUR1BUS_WEB_GALLERY === "1" });
}
