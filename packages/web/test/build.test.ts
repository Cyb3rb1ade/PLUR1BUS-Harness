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
test("the build is exactly index.html, main.js and styles.css", async () => {
  assert.deepEqual((await readdir(dir)).sort(), ["index.html", "main.js", "styles.css"]);
});

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
  const js = await read("main.js");
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

test("the bundle stays inside its size budget (ADR-004: small shipped bundle)", async () => {
  const js = gzipSync(await readFile(join(dir, "main.js")), { level: 9 }).length;
  const css = gzipSync(await readFile(join(dir, "styles.css")), { level: 9 }).length;
  console.log(`# bundle gzip: main.js ${js} B, styles.css ${css} B, total ${js + css} B`);
  assert.ok(js <= 25 * 1024, `main.js ${js} B gzip over 25 KiB`);
  assert.ok(css <= 6 * 1024, `styles.css ${css} B gzip over 6 KiB`);
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
  assert.doesNotMatch(await read("main.js"), /gallery boom/);
  const withGallery = await mkdtemp(join(tmpdir(), "p1web-gallery-"));
  try {
    await buildWeb(withGallery, { gallery: true });
    assert.match(await readFile(join(withGallery, "main.js"), "utf8"), /gallery boom/);
  } finally { await rm(withGallery, { recursive: true, force: true }); }
});
