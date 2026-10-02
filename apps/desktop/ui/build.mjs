import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Bundle the static shell into the requested output directory. */
async function buildUi(outdir = fileURLToPath(new URL("./dist", import.meta.url))) {
  await mkdir(outdir, { recursive: true });
  await copyFile(new URL("./index.html", import.meta.url), `${outdir}/index.html`);
  await build({ entryPoints: [fileURLToPath(new URL("./src/main.ts", import.meta.url))], bundle: true, format: "esm", target: "es2022", loader: { ".ttf": "file" }, outdir });
}
await buildUi(process.argv[2]);
