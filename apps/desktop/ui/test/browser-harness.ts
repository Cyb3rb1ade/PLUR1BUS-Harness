import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type DisplayScale = { physicalWidth: number; physicalHeight: number; scale: number };

export async function withShell(run: (page: Page) => Promise<void>, display?: DisplayScale): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "p1t-browser-"));
  let context: BrowserContext | undefined;
  let server: Server | undefined;
  try {
    const testEntry = fileURLToPath(new URL("./fixture.ts", import.meta.url));
    await build({ entryPoints: [testEntry], bundle: true, format: "esm", target: "es2022", loader: { ".ttf": "file" }, outdir: dir });
    const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
    await writeFile(join(dir, "index.html"), source.replace("./main.js", "./fixture.js").replace("./main.css", "./fixture.css"));
    await copyFile(require.resolve("axe-core/axe.min.js"), join(dir, "axe.js"));
    server = createServer(async (request, response) => {
      const name = decodeURIComponent((request.url ?? "/").slice(1)) || "index.html";
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { response.writeHead(404).end(); return; }
      try {
        const body = await readFile(join(dir, name));
        response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
        response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".ttf") ? "font/ttf" : "text/html");
        response.end(body);
      } catch { response.writeHead(404).end(); }
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local browser server unavailable");
    context = await chromium.launchPersistentContext(join(dir, "profile"), display
      ? { headless: true, viewport: null, args: [`--force-device-scale-factor=${display.scale}`, `--window-size=${display.physicalWidth / display.scale},${display.physicalHeight / display.scale}`] }
      : { headless: true, viewport: { width: 1440, height: 900 } });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByRole("navigation").waitFor({ timeout: 5000 });
    await run(page);
  } finally {
    await context?.close();
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
    await rm(dir, { recursive: true, force: true });
  }
}
