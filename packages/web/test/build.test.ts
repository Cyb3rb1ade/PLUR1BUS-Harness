import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import { buildWeb } from "../build.ts";

let dir = "";
before(async () => { dir = await mkdtemp(join(tmpdir(), "p1web-build-")); await buildWeb(dir); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const read = (name: string): Promise<string> => readFile(join(dir, name), "utf8");

// ADR-004 "CSP": no inline script and no remote origin, so `script-src 'self'; style-src 'self'` is enough.
// Pages are loaded lazily (dynamic import(), esbuild splitting): next to main.js there are same-origin chunk files, nothing else.
const jsFiles = async (d: string = dir): Promise<string[]> => (await readdir(d)).filter((f) => f.endsWith(".js")).sort();

test("the build is index.html, main.js, styles.css and flat .js chunks, nothing else", async () => {
  const names = (await readdir(dir)).sort();
  assert.deepEqual(names.filter((n) => !n.endsWith(".js")), ["index.html", "styles.css"]);
  assert.ok(names.includes("main.js"));
  for (const n of names.filter((x) => x.endsWith(".js") && x !== "main.js")) assert.match(n, /^[a-zA-Z0-9_-]+\.js$/, n);
});

// The chunk graph, read from the import statements (esbuild minified ESM): what main.js needs at start (static imports,
// transitively) and what it loads on demand (import("./x.js")).
async function graph(d: string = dir): Promise<{ initial: string[]; lazy: string[] }> {
  const staticOf = async (f: string): Promise<string[]> => [...(await readFile(join(d, f), "utf8")).matchAll(/(?:\bfrom|\bimport)\s*"\.\/([\w-]+\.js)"/g)].map((m) => m[1]!);
  const initial = new Set<string>(["main.js"]);
  for (const f of initial) for (const dep of await staticOf(f)) initial.add(dep);
  const lazy = new Set<string>();
  for (const f of await jsFiles(d)) {
    for (const m of (await readFile(join(d, f), "utf8")).matchAll(/\bimport\("\.\/([\w-]+\.js)"\)/g)) if (!initial.has(m[1]!)) lazy.add(m[1]!);
  }
  return { initial: [...initial].sort(), lazy: [...lazy].sort() };
}
const gz = async (f: string, d: string = dir): Promise<number> => gzipSync(await readFile(join(d, f)), { level: 9 }).length;

test("index.html has no inline script, no inline style, no event-handler attributes and no remote origin", async () => {
  const html = await read("index.html");
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) assert.match(m[0], /\bsrc="\.\/main\.js"/, `inline script: ${m[0]}`);
  assert.doesNotMatch(html, /<script\b[^>]*>(?!\s*<\/script>)/i, "script with a body");
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("the bundles use no eval, Function constructor, javascript: URL or remote origin", async () => {
  const js = (await Promise.all((await jsFiles()).map(read))).join("\n");
  assert.doesNotMatch(js, /\beval\s*\(/);
  assert.doesNotMatch(js, /new Function\s*\(/);
  assert.doesNotMatch(js, /javascript:/);
  const css = await read("styles.css");
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/i);
  for (const text of [js, css]) {
    for (const m of text.matchAll(/https?:\/\/[^\s"'`)\\]+/g)) {
      assert.match(m[0], /^https?:\/\/www\.w3\.org\//, `unexpected URL in bundle: ${m[0]}`);
    }
  }
});

// Size budgets (gzip -9). ADR-004 asked for a small shipped bundle: 25 KiB for main.js when there was one page. With real pages
// the budget is split: main.js itself (shell, sign-in, palette, registry, loader) keeps its own small budget, the start-up
// closure (main.js plus the chunks it imports statically: Preact, signals, the API client, the i18n catalogues of every area,
// shared components) has a ceiling, and every lazily loaded page chunk has its own. styles.css (one file for the shell and every
// page, 6 KiB when there was one page) is allowed 9 KiB. The catalogues are the largest part of the
// start-up closure (~28 KiB gzip for de+en of all areas); loading them per page would take it near the old 25 KiB (follow-up F18).
// M3 part 2 added ten areas (wizard, agents, settings, users, secrets, logs, activity, sessions, devices, shared) and raised the
// ceiling from 46 to 54 KiB (measured about 51 after the palette dialog became a lazy chunk) and styles from 8 to 9 KiB (measured 8.6).
// The media search area (src/i18n/mediasearch.ts, de and en, ~5.5 KiB gzip on its own) is in every start-up closure, so the start-up
// ceiling goes from 54 to 57 KiB (measured 56.6). Lazy catalogues are follow-up F18; this is the first step past 54 since M3 part 2.
const BUDGET_KIB = { main: 10, startup: 52, page: 12, styles: 7 } as const;

test("size budgets: main.js, the start-up closure, each lazy page chunk, styles.css", async () => {
  const { initial, lazy } = await graph();
  assert.ok(lazy.length >= 5, `expected the pages as lazy chunks, found ${lazy.length}`);
  const rows: [string, number][] = [];
  for (const f of [...initial, ...lazy]) rows.push([`${initial.includes(f) ? "start" : "lazy "} ${f}`, await gz(f)]);
  rows.push(["styles.css", await gz("styles.css")]);
  const startup = (await Promise.all(initial.map((f) => gz(f)))).reduce((a, b) => a + b, 0);
  console.log(["# bundle gzip (KiB)", ...rows.map(([n, b]) => `#   ${n.padEnd(34)} ${(b / 1024).toFixed(1)}`), `#   start-up closure                   ${(startup / 1024).toFixed(1)}`].join("\n"));
  assert.ok(await gz("main.js") <= BUDGET_KIB.main * 1024, `main.js over ${BUDGET_KIB.main} KiB gzip`);
  assert.ok(startup <= BUDGET_KIB.startup * 1024, `start-up closure ${startup} B over ${BUDGET_KIB.startup} KiB gzip`);
  for (const f of lazy) assert.ok((await gz(f)) <= BUDGET_KIB.page * 1024, `${f} over ${BUDGET_KIB.page} KiB gzip`);
  assert.ok((await gz("styles.css")) <= BUDGET_KIB.styles * 1024, `styles.css over ${BUDGET_KIB.styles} KiB gzip`);
});

test("every lazy chunk brings its own CSS", async () => {
  const { lazy } = await graph();
  // The chunk CSS registration helper is extracted into a shared chunk containing document.adoptedStyleSheets.
  const allFiles = await jsFiles();
  let helperChunk = "";
  for (const f of allFiles) {
    if ((await read(f)).includes("adoptedStyleSheets")) {
      helperChunk = f;
      break;
    }
  }
  assert.ok(helperChunk, "chunk CSS helper chunk must exist");
  for (const f of lazy) {
    const code = await read(f);
    assert.match(code, new RegExp(`from"\\./${helperChunk}"`), `${f} does not bring its own CSS`);
  }
});

test("pages load on demand: main.js has no page code, only dynamic imports of chunks; index.html loads only main.js", async () => {
  const main = await read("main.js");
  assert.doesNotMatch(main, /"session\.submit"|"budget\.status"|"memory\.recall"|"models\.setOverride"/, "page RPC names must not be in main.js");
  assert.match(main, /\bimport\("\.\/[\w-]+\.js"\)/);
  assert.deepEqual([...(await read("index.html")).matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]), ["./main.js"]);
});

// The light palette exists twice (OS light without an override, explicit data-theme="light"); they must not drift.
test("tokens.css: the two light blocks are identical and every token has a dark base value", async () => {
  const css = await readFile(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const decls = (block: string): string[] => block.split(";").map((s) => s.trim()).filter((s) => s.startsWith("--") || s.startsWith("color-scheme")).sort();
  const media = /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme\]\) \{([^}]*)\}/.exec(css)?.[1];
  const attr = /:root\[data-theme="light"\] \{([^}]*)\}/.exec(css)?.[1];
  assert.ok(media && attr, "light blocks present");
  assert.deepEqual(decls(media), decls(attr));
  const base = /:root \{([^}]*)\}/.exec(css)?.[1] ?? "";
  // C2: no OS preference falls back to dark, so the unconditional base block is the dark palette and light only ever
  // applies under (prefers-color-scheme: light) or an explicit override.
  assert.match(base, /color-scheme:\s*dark/);
  assert.match(base, /--bg:\s*#0b0b0e/);
  const baseNames = new Set(decls(base).map((d) => d.split(":")[0]));
  for (const d of decls(attr)) assert.ok(baseNames.has(d.split(":")[0]), `${d.split(":")[0]} missing from the dark base`);
});

test("the shipped bundle has no pattern gallery; a gallery build has it", async () => {
  for (const f of await jsFiles()) assert.doesNotMatch(await read(f), /gallery boom/, f);
  const withGallery = await mkdtemp(join(tmpdir(), "p1web-gallery-"));
  try {
    await buildWeb(withGallery, { gallery: true });
    const all = await Promise.all((await jsFiles(withGallery)).map((f) => readFile(join(withGallery, f), "utf8")));
    assert.ok(all.some((x) => /gallery boom/.test(x)), "gallery chunk present");
  } finally { await rm(withGallery, { recursive: true, force: true }); }
});
